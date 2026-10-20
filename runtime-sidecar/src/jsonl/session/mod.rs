//! One session: its committed state, its append pipeline and the immutable
//! value readers see.
//!
//! Writers take `SessionActor::lock` for the duration of one operation and
//! never across an `await`. Readers take the published `Lake` from an
//! `ArcSwap` and never take the lock at all.

pub mod load;
pub mod state;
pub use state::Tx;
pub mod sync;
#[cfg(test)]
mod tests;

use std::collections::VecDeque;
use std::sync::Arc;

use arc_swap::ArcSwap;
use parking_lot::Mutex;

use super::error::JsonlResult;
use super::file::{AppendFile, read_frames};
use super::layout;
use super::record::{
    Coverage, IndexRecord, LineWriter, ListRecord, Record, SealRecord, SnapshotCond,
};
use super::seglog::read_all;
use super::write::{Extent, Kind, Slot};
use crate::actor::StreamEvent;
use crate::session_types::ControlState;

/// Events a reader can replay from memory without touching the disk.
pub const EVENT_WINDOW: u64 = 4096;
/// Receipts kept in memory; older ones still exist on disk for a cold load.
pub const RECEIPT_RING: usize = 8192;
/// Receipts survive this long, matching the control-receipt TTL.
pub const RECEIPT_TTL_MS: u64 = 24 * 60 * 60 * 1000;
/// Frames a segment file holds before the writer rolls to the next segment.
pub const FRAMES_PER_SEGMENT: u64 = 16 * 1024;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// A committed event as readers replay it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedEvent {
    pub sequence: u64,
    pub run_id: String,
    pub kind: String,
    pub payload: Vec<u8>,
}

/// The immutable value readers observe.
pub struct Lake {
    pub state: SnapshotCond,
    pub header: Arc<serde_json::Value>,
    pub queue: Arc<crate::input_queue::QueueState>,
    pub control: Arc<ControlState>,
    pub ui_gen: u64,
    /// Events still in memory, ascending and contiguous; may start later than
    /// `retained_from` if they were read from an older segment at load.
    pub events: Arc<VecDeque<CommittedEvent>>,
    pub first_retained: u64,
}

impl Lake {
    pub fn snapshot_events(&self, after: u64) -> Vec<StreamEvent> {
        self.events
            .iter()
            .filter(|event| event.sequence > after)
            .map(|event| StreamEvent {
                sequence: event.sequence,
                run_id: event.run_id.clone(),
                kind: event.kind.clone(),
                payload: event.payload.clone(),
                ephemeral: false,
            })
            .collect()
    }
}

/// The writer side of a session.
pub struct SessionActor {
    pub id: String,
    pub state: SnapshotCond,
    pub header: serde_json::Value,
    pub queue: crate::input_queue::QueueState,
    pub control: ControlState,
    pub projection: Option<super::segment::Projection>,
    pub events: VecDeque<CommittedEvent>,
    pub receipts: std::collections::HashMap<(String, String), StoredReceipt>,
    pub subscribers: Vec<tokio::sync::mpsc::Sender<Arc<StreamEvent>>>,
    pub files: Publisher,
    pub commit: u64,
    pub ui_gen: u64,
    pub subscribers_capacity: usize,
    /// Admitted run documents by id, until the run finishes.
    pub active_runs: std::collections::HashMap<String, serde_json::Value>,
    pub activated_runs: std::collections::HashSet<String>,
    /// The store-owned cell this actor lives in.
    pub cell: Option<Arc<SessionHandleCell>>,
    pub terminated_runs: std::collections::HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct StoredReceipt {
    pub fingerprint: String,
    pub result: serde_json::Value,
    pub at: u64,
}

/// The append files, the segment they belong to and their committed extent.
pub struct Publisher {
    pub segment: u64,
    pub controls: AppendFile,
    pub events: AppendFile,
    pub seals: AppendFile,
    pub extent: Extent,
}

impl Publisher {
    pub fn open(session_dir: &std::path::Path, segment: u64, extent: Extent) -> JsonlResult<Self> {
        let dir = layout::segment_dir(session_dir, segment);
        let file = |prefix: &str| AppendFile::open(&dir.join(format!("{prefix}.000000")));
        Ok(Self {
            segment,
            controls: file("ctls")?,
            events: file("evts")?,
            seals: file("clse")?,
            extent,
        })
    }

    pub fn file(&self, kind: Kind) -> &AppendFile {
        match kind {
            Kind::Controls => &self.controls,
            Kind::Events => &self.events,
            Kind::Seal => &self.seals,
        }
    }

    pub fn file_mut(&mut self, kind: Kind) -> &mut AppendFile {
        match kind {
            Kind::Controls => &mut self.controls,
            Kind::Events => &mut self.events,
            Kind::Seal => &mut self.seals,
        }
    }

    /// Make every appended frame durable.
    pub fn sync(&mut self) -> JsonlResult<()> {
        self.controls.sync()?;
        self.events.sync()?;
        self.seals.sync()
    }

    /// Append this segment's data and its seal. Returns the new extent.
    pub fn commit(&mut self, slots: &[Slot], seal: &[u8]) -> JsonlResult<Extent> {
        for slot in slots {
            let file = self.file_mut(slot.kind);
            file.append(&slot.payload)?;
            self.extent.frames[slot.kind as usize] += 1;
            self.extent.offsets[slot.kind as usize] += 4 + slot.payload.len() as u64;
        }
        self.seals.append(seal)?;
        Ok(self.extent.clone())
    }
}

/// The store-owned cell a handle points at; keeps the handle cheap to clone.
pub struct SessionHandleCell {
    pub id: String,
    pub actor: Arc<Mutex<SessionActor>>,
    pub lake: Arc<ArcSwap<Lake>>,
    pub root: Arc<std::path::PathBuf>,
}

/// The handle the store hands out. Cloning shares the actor and the lake.
#[derive(Clone)]
pub struct SessionHandle {
    pub id: String,
    pub actor: Arc<Mutex<SessionActor>>,
    pub lake: Arc<ArcSwap<Lake>>,
    pub root: Arc<std::path::PathBuf>,
    pub cell: Option<Arc<SessionHandleCell>>,
}

impl SessionHandle {

    pub fn session_dir(&self) -> std::path::PathBuf {
        layout::session_dir(&self.root, &self.id).expect("the id was validated at open")
    }

    pub fn cell(&self) -> &Arc<SessionHandleCell> {
        self.cell.as_ref().expect("a handle is attached at open")
    }

    pub fn read(&self) -> arc_swap::Guard<Arc<Lake>> {
        self.lake.load()
    }

    pub fn snapshot(&self) -> crate::actor::SessionSnapshot {
        let lake = self.read();
        crate::actor::SessionSnapshot {
            session_id: self.id.clone(),
            epoch: lake.state.epoch,
            revision: lake.state.revision,
            active_run_id: lake.state.active_run_id.clone(),
            cursor: lake.state.cursor,
            retained_from: lake.state.retained_from,
        }
    }

    /// Publish the writer's state to readers. The caller holds the actor lock,
    /// so readers never observe a half-applied batch.
    pub fn publish(&self, actor: &mut SessionActor) {
        actor.ui_gen += 1;
        self.lake.store(Arc::new(Lake {
            state: actor.state.clone(),
            header: Arc::new(actor.header.clone()),
            queue: Arc::new(actor.queue.clone()),
            control: Arc::new(actor.control.clone()),
            ui_gen: actor.ui_gen,
            events: Arc::new(actor.events.clone()),
            first_retained: actor.state.retained_from,
        }));
    }
}

/// Append one event to the writer's window, dropping the oldest past the cap.
pub fn push_event(actor: &mut SessionActor, event: CommittedEvent) {
    let sequence = event.sequence;
    actor.events.push_back(event);
    let retained = sequence.saturating_sub(EVENT_WINDOW) + 1;
    while actor
        .events
        .front()
        .is_some_and(|first| first.sequence < retained)
    {
        actor.events.pop_front();
    }
    actor.state.retained_from = retained;
}

/// Fan out one event to the live subscribers, dropping closed ones.
pub fn fan_out(actor: &mut SessionActor, event: StreamEvent) {
    let shared = Arc::new(event);
    actor
        .subscribers
        .retain(|subscriber| subscriber.try_send(shared.clone()).is_ok());
}

/// Write the root index row for this session.
pub fn index_row(actor: &SessionActor) -> IndexRecord {
    IndexRecord {
        s: actor.id.clone(),
        c: actor.commit,
        d: actor.files.segment,
        so: actor.files.extent.offsets[Kind::Seal as usize],
        sf: actor.files.extent.frames[Kind::Seal as usize],
        u: updated_at(actor),
        h: actor.header.clone(),
        m: actor.files.extent.offsets.iter().sum::<u64>(),
        state: actor.state.clone(),
        deleted: false,
    }
}

pub fn list_row(actor: &SessionActor) -> ListRecord {
    ListRecord {
        s: actor.id.clone(),
        u: updated_at(actor),
        h: actor.header.clone(),
        del: false,
    }
}

fn updated_at(actor: &SessionActor) -> String {
    actor
        .header
        .get("updatedAt")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// Encode the seal that makes `extent` durable.
pub fn encode_seal(
    segment: u64,
    commit: u64,
    extent: &Extent,
    state: &SnapshotCond,
    writer: &mut LineWriter,
) -> JsonlResult<Vec<u8>> {
    let g = [Kind::Controls, Kind::Events]
        .iter()
        .map(|kind| Coverage {
            d: segment,
            k: *kind as u8,
            o: extent.offsets[*kind as usize],
            n: extent.frames[*kind as usize],
        })
        .collect();
    Ok(writer
        .line(&Record::Seal(SealRecord {
            c: commit,
            g,
            snap: state.clone(),
        }))
        .to_vec())
}

impl SessionActor {
    /// Build the writer for a freshly loaded session.
    pub fn from_loaded(loaded: load::Loaded, subscribers_capacity: usize) -> Self {
        Self {
            id: String::new(),
            state: loaded.state,
            header: loaded.header,
            queue: crate::input_queue::QueueState::default(),
            control: ControlState::default(),
            projection: Some(loaded.projection),
            events: loaded.events,
            receipts: loaded.receipts,
            subscribers: Vec::new(),
            files: loaded.files,
            commit: loaded.commit,
            ui_gen: 0,
            subscribers_capacity,
            active_runs: std::collections::HashMap::new(),
            activated_runs: std::collections::HashSet::new(),
            cell: None,
            terminated_runs: std::collections::HashSet::new(),
        }
    }
}

/// Drain the events that a `subscribe` must deliver before going live.
pub fn backlog(
    lake: &Lake,
    after: u64,
    limit_bytes: usize,
) -> Result<Vec<StreamEvent>, crate::actor::RuntimeError> {
    if after > lake.state.cursor {
        return Err(crate::actor::RuntimeError::InvalidCommand(
            "subscription cursor is ahead of session".into(),
        ));
    }
    if after.saturating_add(1) < lake.state.retained_from {
        return Err(crate::actor::RuntimeError::CursorExpired {
            after,
            retained_from: lake.state.retained_from,
        });
    }
    let events = lake.snapshot_events(after);
    let last = events.last().map(|event| event.sequence).unwrap_or(after);
    if last < lake.state.cursor
        || events
            .iter()
            .map(|event| event.payload.len())
            .sum::<usize>()
            > limit_bytes
    {
        return Err(crate::actor::RuntimeError::Backpressure);
    }
    Ok(events)
}
