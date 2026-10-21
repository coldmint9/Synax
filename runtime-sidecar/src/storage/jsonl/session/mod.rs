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
use std::sync::{Arc, Weak};

use arc_swap::ArcSwap;
use parking_lot::Mutex;

use super::error::JsonlResult;
use super::file::AppendFile;
use super::layout;
use super::record::{
    Coverage, IndexRecord, LineWriter, ListRecord, Record, SnapshotCond,
};
use super::write::{Extent, Kind, Slot};
use crate::runtime::actor::StreamEvent;
use crate::runtime::session_types::ControlState;

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
    /// Shared because every hot commit publishes the same bounded event
    /// window through both the actor and the immutable reader lake.
    pub payload: Arc<[u8]>,
}

/// The immutable value readers observe.
pub struct Lake {
    pub state: SnapshotCond,
    pub header: Arc<serde_json::Value>,
    pub projection: Arc<super::segment::Projection>,
    pub projection_ready: bool,
    pub queue: Arc<crate::runtime::input_queue::QueueState>,
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
                payload: event.payload.to_vec(),
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
    pub queue: crate::runtime::input_queue::QueueState,
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
    pub cell: Option<Weak<SessionHandleCell>>,
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
    failed: bool,
}

impl Publisher {
    pub fn open(session_dir: &std::path::Path, segment: u64, extent: Extent) -> JsonlResult<Self> {
        let dir = layout::segment_dir(&session_dir.join("events-v2"), segment);
        let file = |prefix: &str, kind: Kind| AppendFile::open_committed(&dir.join(format!("{prefix}.000000")), extent.offsets[kind as usize]);
        Ok(Self {
            segment,
            controls: file("ctls", Kind::Controls)?,
            events: file("evts", Kind::Events)?,
            seals: file("clse", Kind::Seal)?,
            extent,
            failed: false,
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
        if self.failed { return Err(super::error::JsonlError::corrupt(self.seals.path(), 0, "writer requires reopen after failed rollback")); }
        let before = self.extent.clone();
        // Validate the entire batch before writing. On an I/O failure discard
        // every uncommitted byte before allowing another transaction.
        for bytes in slots.iter().map(|slot| slot.payload.as_slice()).chain(std::iter::once(seal)) {
            if bytes.len() > super::seglog::MAX_FRAME {
                return Err(super::error::JsonlError::corrupt(self.seals.path(), 0, "frame exceeds MAX_FRAME"));
            }
        }
        let result = (|| {
            for slot in slots {
                self.file_mut(slot.kind).append(&slot.payload)?;
                self.extent.frames[slot.kind as usize] += 1;
                self.extent.offsets[slot.kind as usize] += 4 + slot.payload.len() as u64;
            }
            self.seals.append(seal)?;
            self.extent.frames[Kind::Seal as usize] += 1;
            self.extent.offsets[Kind::Seal as usize] += 4 + seal.len() as u64;
            // The router awaits the existing Sync/GroupCommit barrier before
            // acknowledging. Do not add a second fsync to every token burst.
            Ok(())
        })();
        if let Err(error) = result {
            self.failed = true;
            for kind in Kind::ALL { self.file_mut(kind).truncate(before.offsets[kind as usize])?; }
            self.extent = before;
            self.failed = false;
            return Err(error);
        }
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

    pub fn snapshot(&self) -> crate::runtime::actor::SessionSnapshot {
        let lake = self.read();
        crate::runtime::actor::SessionSnapshot {
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
            projection: Arc::new(actor.projection.clone().unwrap_or_default()),
            projection_ready: actor.projection.is_some(),
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
    _state: &SnapshotCond,
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
        .line(&Record::Commit { c: commit, g })
        .to_vec())
}

impl SessionActor {
    /// Build the writer for a freshly loaded session.
    pub fn from_loaded(loaded: load::Loaded, subscribers_capacity: usize) -> Self {
        let projection_ready = loaded.header.is_object();
        Self {
            id: String::new(),
            state: loaded.state,
            header: loaded.header,
            queue: loaded.queue,
            control: loaded.control,
            projection: if projection_ready { Some(loaded.projection) } else { None },
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
) -> Result<Vec<StreamEvent>, crate::runtime::actor::RuntimeError> {
    if after > lake.state.cursor {
        return Err(crate::runtime::actor::RuntimeError::InvalidCommand(
            "subscription cursor is ahead of session".into(),
        ));
    }
    if after.saturating_add(1) < lake.state.retained_from {
        return Err(crate::runtime::actor::RuntimeError::CursorExpired {
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
        return Err(crate::runtime::actor::RuntimeError::Backpressure);
    }
    Ok(events)
}
