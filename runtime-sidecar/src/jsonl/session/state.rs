//! The transaction writer: one prepared batch becomes frames, a seal, and a
//! published state.
//!
//! `Tx` accumulates what an operation wants to change. Nothing is applied
//! until `commit` runs, so a rejected operation — a stale fence, a receipt
//! mismatch, an oversized projection — never leaves a partial batch behind.

use std::collections::VecDeque;

use crate::actor::{RuntimeError, StreamEvent};
use crate::jsonl::record::{EventRecord, LineWriter, ReceiptRecord, Record};
use crate::jsonl::segment::Projection;
use crate::jsonl::session::{CommittedEvent, StoredReceipt, push_event};
use crate::jsonl::write::{Kind, Slot};

use super::SessionActor;

/// Everything one operation changes. Built by validation, consumed by
/// [`Tx::commit`].
#[derive(Default)]
pub struct Tx {
    pub cursor: u64,
    pub revision: u64,
    pub epoch: u64,
    pub retained_from: u64,
    /// `None` means unchanged; `Some(None)` clears the active run.
    pub active_run_id: Option<Option<String>>,
    pub header: Option<crate::jsonl::segment::PValue>,
    pub events: Vec<StreamEvent>,
    pub projection: Projection,
    /// `(scope, request id, fingerprint, result)`.
    pub receipt: Option<(String, String, String, serde_json::Value)>,
    pub fan_out: Vec<StreamEvent>,
    pub control: Option<crate::session_types::ControlState>,
    pub queue: Option<crate::input_queue::QueueState>,
}

impl Tx {
    /// The transaction as the seal records it.
    fn state(
        &self,
        actor: &mut SessionActor,
        retained_from: u64,
    ) -> crate::jsonl::record::SnapshotCond {
        let mut state = actor.state.clone();
        state.cursor = self.cursor;
        state.revision = self.revision;
        state.epoch = self.epoch;
        state.retained_from = retained_from;
        if let Some(active_run_id) = &self.active_run_id {
            state.active_run_id = active_run_id.clone();
        }
        state.header = Some(self.header.as_ref().map_or_else(
            || actor.header.clone(),
            crate::jsonl::segment::PValue::to_json,
        ));
        state
    }
}

impl SessionActor {
    /// Apply a validated transaction: append its frames, seal them, update the
    /// in-memory state and publish.
    pub fn write(&mut self, handle: &super::SessionHandle, tx: Tx) -> Result<(), RuntimeError> {
        // The projection budget is a commit invariant: an over-budget batch
        // would make the session unreadable forever.
        tx.projection.encode()?;
        let commit_id = self.commit + 1;
        // A rolled segment must be opened before its first frame is written.
        if self.files.extent.frames[Kind::Events as usize] >= super::FRAMES_PER_SEGMENT {
            self.roll(handle)?;
        }
        let mut controls: Vec<Vec<u8>> = Vec::with_capacity(tx.events.len() + 2);
        let mut events: Vec<Vec<u8>> = Vec::with_capacity(tx.events.len());
        let mut writer = LineWriter::new();

        if let Some(control) = &tx.control {
            controls.push(
                writer
                    .line(&Record::Control {
                        c: commit_id,
                        ctl: Some(control.clone()),
                        queue: tx.queue.clone(),
                    })
                    .to_vec(),
            );
        } else if let Some(queue) = &tx.queue {
            controls.push(
                writer
                    .line(&Record::Control {
                        c: commit_id,
                        ctl: None,
                        queue: Some(queue.clone()),
                    })
                    .to_vec(),
            );
        }
        for event in &tx.events {
            let payload: serde_json::Value = serde_json::from_slice(&event.payload)
                .map_err(|_| RuntimeError::InvalidCommand("event payload is not JSON".into()))?;
            events.push(
                writer
                    .line(&Record::Event(EventRecord {
                        s: event.sequence,
                        r: event.run_id.clone(),
                        k: event.kind.clone(),
                        p: payload,
                    }))
                    .to_vec(),
            );
        }
        if !tx.events.is_empty() {
            controls.push(
                writer
                    .line(&Record::Cursor {
                        c: commit_id,
                        cur: tx.cursor,
                    })
                    .to_vec(),
            );
        }
        if let Some((scope, request_id, fingerprint, result)) = &tx.receipt {
            let value = result.clone();
            controls.push(
                writer
                    .line(&Record::Receipt(ReceiptRecord {
                        sc: scope.clone(),
                        id: request_id.clone(),
                        f: fingerprint.clone(),
                        at: super::now_ms(),
                        r: value,
                    }))
                    .to_vec(),
            );
        }

        // The seal records the extent this batch extends to.
        let mut next = self.files.extent.clone();
        next.frames[Kind::Controls as usize] += controls.len() as u64;
        next.offsets[Kind::Controls as usize] += controls
            .iter()
            .map(|frame| frame.len() as u64 + 4)
            .sum::<u64>();
        next.frames[Kind::Events as usize] += events.len() as u64;
        next.offsets[Kind::Events as usize] += events
            .iter()
            .map(|frame| frame.len() as u64 + 4)
            .sum::<u64>();
        let seal = super::encode_seal(
            self.files.segment,
            commit_id,
            &next,
            &tx.state(self, tx.retained_from),
            &mut writer,
        )?;

        let mut slots: Vec<Slot> = Vec::with_capacity(controls.len() + events.len());
        slots.extend(controls.into_iter().map(|payload| Slot {
            kind: Kind::Controls,
            segment: self.files.segment,
            payload,
        }));
        slots.extend(events.into_iter().map(|payload| Slot {
            kind: Kind::Events,
            segment: self.files.segment,
            payload,
        }));
        self.files.commit(&slots, &seal)?;

        // In-memory state follows the durable batch.
        self.state.cursor = tx.cursor;
        self.state.revision = tx.revision;
        self.state.epoch = tx.epoch;
        if let Some(active_run_id) = &tx.active_run_id {
            self.state.active_run_id = active_run_id.clone();
        }
        if let Some(control) = &tx.control {
            self.control = control.clone();
        }
        if let Some(queue) = &tx.queue {
            self.queue = queue.clone();
        }
        self.projection = Some(tx.projection);
        self.header = tx.header.as_ref().map_or_else(
            || self.header.clone(),
            crate::jsonl::segment::PValue::to_json,
        );
        for event in &tx.events {
            push_event(
                self,
                CommittedEvent {
                    sequence: event.sequence,
                    run_id: event.run_id.clone(),
                    kind: event.kind.clone(),
                    payload: event.payload.clone(),
                },
            );
        }
        if let Some((scope, request_id, fingerprint, result)) = tx.receipt {
            self.put_receipt(
                scope,
                request_id,
                StoredReceipt {
                    fingerprint,
                    result,
                    at: super::now_ms(),
                },
            );
        }
        self.commit = commit_id;
        self.publish(handle);
        for event in tx.fan_out {
            super::fan_out(self, event);
        }
        Ok(())
    }
}

/// Put a receipt into the bounded, TTL-pruned map.
impl SessionActor {
    pub fn put_receipt(&mut self, scope: String, request_id: String, receipt: StoredReceipt) {
        self.receipts.insert((scope, request_id), receipt);
        if self.receipts.len() > super::RECEIPT_RING {
            if let Some(oldest) = self
                .receipts
                .iter()
                .min_by_key(|(_, receipt)| receipt.at)
                .map(|(key, _)| key.clone())
            {
                self.receipts.remove(&oldest);
            }
        }
    }

    /// Drop receipts past their TTL, and the oldest past the ring bound.
    pub fn prune_receipts(&mut self, now_ms: u64) {
        self.receipts
            .retain(|_, receipt| now_ms.saturating_sub(receipt.at) < super::RECEIPT_TTL_MS);
        while self.receipts.len() > super::RECEIPT_RING {
            let Some(oldest) = self.receipts.iter().min_by_key(|(_, receipt)| receipt.at).map(|(key, _)| key.clone()) else {
                break;
            };
            self.receipts.remove(&oldest);
        }
    }

    pub fn receipt(&self, scope: &str, request_id: &str) -> Option<&StoredReceipt> {
        self.receipts
            .get(&(scope.to_owned(), request_id.to_owned()))
    }

    /// Open the next segment directory and seal the boundary.
    fn roll(&mut self, handle: &super::SessionHandle) -> Result<(), RuntimeError> {
        let next = self.files.segment + 1;
        self.files.sync()?;
        let session_dir = handle.session_dir();
        let commit = self.commit + 1;
        let empty = crate::jsonl::write::Extent { offsets: [0; 3], frames: [0; 3] };
        let seal = super::encode_seal(next, commit, &empty, &self.state, &mut LineWriter::new())?;
        let mut files = super::Publisher::open(&session_dir, next, empty)?;
        files.seals.append(&seal)?;
        files.sync()?;
        self.files = files;
        self.commit = commit;
        self.publish(handle);
        Ok(())
    }

    /// Make this actor's appended frames durable.
    pub fn sync(&mut self) -> crate::jsonl::error::JsonlResult<()> {
        self.files.sync()
    }

    /// The handle this actor belongs to.
    pub fn this(&self) -> super::SessionHandle {
        let cell = self.cell.clone().expect("an actor is attached before it serves");
        super::SessionHandle {
            id: self.id.clone(),
            actor: cell.actor.clone(),
            lake: cell.lake.clone(),
            root: cell.root.clone(),
            cell: Some(cell),
        }
    }

    /// Publish this actor's state to readers.
    pub fn publish(&mut self, handle: &super::SessionHandle) {
        handle.publish(self);
    }
}
