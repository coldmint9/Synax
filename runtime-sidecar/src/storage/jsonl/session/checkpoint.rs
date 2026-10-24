use super::{CommittedEvent, SessionActor, SessionHandle, StoredReceipt};
use crate::{
    runtime::{input_queue::QueueState, projection::UiSnapshot, session_types::ControlState},
    storage::jsonl::{
        JsonlResult,
        checkpoint::{self, Position},
        layout,
        record::SnapshotCond,
        segment::Projection,
        write::Extent,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::Arc,
};

pub const FILE: &str = "runtime-checkpoint.bin";

#[derive(Serialize, Deserialize)]
pub struct Snapshot<E = Vec<Event>, R = Vec<((String, String), StoredReceipt)>> {
    pub id: String,
    pub segment: u64,
    pub positions: [Position; 3],
    pub frames: [u64; 3],
    pub commit: u64,
    pub state: SnapshotCond,
    pub projection: UiSnapshot,
    pub control: ControlState,
    pub queue: QueueState,
    events: E,
    receipts: R,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Event {
    sequence: u64,
    run_id: String,
    kind: String,
    #[serde(with = "checkpoint::bytes")]
    payload: Vec<u8>,
}

// Borrow the large event/receipt bodies while serializing a consistent view;
// the resulting JSON is the only full snapshot copy retained outside the lock.
#[derive(Serialize)]
struct EventRef<'a> {
    sequence: u64,
    run_id: &'a str,
    kind: &'a str,
    #[serde(serialize_with = "checkpoint::bytes::serialize")]
    payload: &'a [u8],
}

impl Snapshot {
    pub fn extent(&self) -> Extent {
        Extent {
            offsets: std::array::from_fn(|i| self.positions[i].offset),
            frames: self.frames,
        }
    }
    pub fn restore(self, loaded: &mut super::load::Loaded) {
        loaded.commit = self.commit;
        loaded.checkpoint_commit = self.commit;
        loaded.state = self.state;
        loaded.header = self.projection.session.clone();
        loaded.projection = Projection::from_snapshot(&self.projection);
        loaded.control = self.control;
        loaded.queue = self.queue;
        loaded.events = self
            .events
            .into_iter()
            .map(|event| CommittedEvent {
                sequence: event.sequence,
                run_id: event.run_id,
                kind: event.kind,
                payload: Arc::from(event.payload),
            })
            .collect::<VecDeque<_>>();
        loaded.receipts = self
            .receipts
            .into_iter()
            .filter(|(_, receipt)| {
                super::now_ms().saturating_sub(receipt.at) < super::RECEIPT_TTL_MS
            })
            .collect::<HashMap<_, _>>();
    }
}

pub fn read(directory: &Path, id: &str) -> Option<Snapshot> {
    let saved: Snapshot = checkpoint::read(&directory.join(FILE))?;
    if saved.id != id || saved.projection.session["id"] != id {
        return None;
    }
    let segment = layout::segment_dir(&directory.join("events-v2"), saved.segment);
    for (i, name) in ["ctls.000000", "evts.000000", "clse.000000"]
        .iter()
        .enumerate()
    {
        if !saved.positions[i].valid(&segment.join(name)) {
            return None;
        }
    }
    Some(saved)
}

pub fn save(handle: &SessionHandle, force: bool) -> JsonlResult<()> {
    save_with(handle, force, checkpoint::Pending::stage)
}

fn save_with(
    handle: &SessionHandle,
    force: bool,
    stage: impl FnOnce(checkpoint::Pending) -> JsonlResult<checkpoint::Staged>,
) -> JsonlResult<()> {
    // A periodic flush skips an in-flight checkpoint instead of retaining
    // another large snapshot. Forced shutdown/eviction waits outside actor lock.
    let gate = &handle.cell().checkpoint_lock;
    let _gate = if force {
        gate.lock()
    } else {
        let Some(guard) = gate.try_lock() else {
            return Ok(());
        };
        guard
    };
    let prepared = {
        let mut actor = handle.actor.lock();
        prepare(&handle.root, &mut actor, force)?
    };
    let Some((pending, commit)) = prepared else {
        return Ok(());
    };
    let staged = stage(pending)?;
    staged.publish()?;
    let mut actor = handle.actor.lock();
    actor.checkpoint_commit = commit;
    actor.checkpoint_at = std::time::Instant::now();
    Ok(())
}

fn prepare(
    root: &Path,
    actor: &mut SessionActor,
    force: bool,
) -> JsonlResult<Option<(checkpoint::Pending, u64)>> {
    if !actor.header.is_object()
        || actor.commit == actor.checkpoint_commit
        || (!force
            && (actor.commit.saturating_sub(actor.checkpoint_commit) < 128
                || actor.checkpoint_at.elapsed().as_secs() < 30))
    {
        return Ok(None);
    }
    // New writes may have arrived since flush released the actor. Capture only
    // a durable prefix, so publishing outside the lock never acknowledges it.
    actor.sync()?;
    let directory = layout::session_dir(root, &actor.id)?;
    let positions = [
        Position::capture(actor.files.controls.path(), actor.files.extent.offsets[0])?,
        Position::capture(actor.files.events.path(), actor.files.extent.offsets[1])?,
        Position::capture(actor.files.seals.path(), actor.files.extent.offsets[2])?,
    ];
    let snapshot = Snapshot {
        id: actor.id.clone(),
        segment: actor.files.segment,
        positions,
        frames: actor.files.extent.frames,
        commit: actor.commit,
        state: actor.state.clone(),
        projection: serde_json::from_value(
            actor
                .projection
                .as_ref()
                .expect("seeded projection")
                .to_json(),
        )?,
        control: actor.control.clone(),
        queue: actor.queue.clone(),
        events: actor
            .events
            .iter()
            .map(|event| EventRef {
                sequence: event.sequence,
                run_id: &event.run_id,
                kind: &event.kind,
                payload: &event.payload,
            })
            .collect::<Vec<_>>(),
        receipts: actor.receipts.iter().collect::<Vec<_>>(),
    };
    Ok(Some((
        checkpoint::Pending::new(directory.join(FILE), &snapshot)?,
        actor.commit,
    )))
}

#[cfg(test)]
mod tests;
