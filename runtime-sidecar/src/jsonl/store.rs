//! The JSONL store: session handles, the commit batch, group-commit flushing
//! and the session index behind `session_list`.
//!
//! Every method here is synchronous; callers wrap them in `spawn_blocking`.
//! Writes take a per-session mutex, append through the session's [`SeqLog`],
//! then swap the in-memory view. A failed append leaves both untouched.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};

use serde_json::{Value, json};

use super::log::{self, BatchSpec as LogBatch, CommitLevel, LineSelector};
use super::lock::StoreLock;
use super::view::{now_ms, Receipt, SessionHandle, SessionView};

/// Persisted receipt index bound (`RECEIPT_RETENTION` in the design).
const MAX_RECEIPTS: usize = 8192;
/// Session rows returned per `session_list` page.
const SESSION_PAGE_ITEMS: usize = 64;
/// Byte budget for one `session_list` page.
const SESSION_PAGE_BYTES: usize = 900 * 1024;
/// `fdatasync` at most this often for group-committed batches.
const FLUSH_INTERVAL_MS: u64 = 20;

#[derive(Debug, thiserror::Error)]
pub enum JsonlError {
    #[error("runtime store is already open: {0}")]
    Busy(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Serialization(#[from] serde_json::Error),
    #[error(transparent)]
    Runtime(#[from] crate::actor::RuntimeError),
    #[error("disk full")]
    DiskFull,
}

impl From<JsonlError> for crate::actor::RuntimeError {
    fn from(error: JsonlError) -> Self {
        match error {
            JsonlError::Runtime(error) => error,
            JsonlError::DiskFull => crate::actor::RuntimeError::DiskFull,
            other => crate::actor::RuntimeError::StorageUnavailable(other.to_string()),
        }
    }
}

/// Map ENOSPC to a first-class error so callers can answer `DISK_FULL`.
fn io_error(error: std::io::Error) -> JsonlError {
    if error.kind() == std::io::ErrorKind::StorageFull || error.raw_os_error() == Some(28) {
        return JsonlError::DiskFull;
    }
    JsonlError::Io(error)
}

/// One entity version to append.
#[derive(Debug, Clone)]
pub struct EntityWrite {
    pub kind: String,
    pub id: String,
    pub root: bool,
    pub value: Value,
}

/// One history version to append.
#[derive(Debug, Clone)]
pub struct VersionWrite {
    pub kind: String,
    pub id: String,
    pub revision: u64,
    pub value: Value,
}

/// A receipt to persist with the batch.
#[derive(Debug, Clone)]
pub struct ReceiptWrite {
    pub scope: String,
    pub request_id: String,
    pub fingerprint: String,
    pub result: Value,
}

/// Everything one commit writes. Fields are applied in a fixed order so the
/// in-memory candidate and the appended lines always agree.
#[derive(Debug, Default)]
pub struct BatchSpec {
    pub level: CommitLevelKind,
    /// Events already assigned their sequence (`cursor + 1`, `cursor + 2`, …).
    pub events: Vec<crate::actor::StreamEvent>,
    pub entities: Vec<EntityWrite>,
    /// `(kind, id)` tombstones.
    pub withdrawals: Vec<(String, String)>,
    pub history: Vec<VersionWrite>,
    /// Staged entities written to both `entities/` and `history/`.
    pub stage: Option<(String, Vec<(String, Value)>)>,
    pub meta: Option<Value>,
    pub control: Option<crate::session_types::ControlState>,
    pub queue: Option<crate::input_queue::QueueState>,
    pub projection: Option<crate::projection::UiSnapshot>,
    pub receipts: Vec<ReceiptWrite>,
}

/// Ack policy, mirroring [`crate::actor::Durability`] without `Ephemeral`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CommitLevelKind {
    /// Append and `fdatasync` before returning.
    Sync,
    /// Append and return; the flusher syncs within [`FLUSH_INTERVAL_MS`].
    #[default]
    GroupCommit,
}

impl From<CommitLevelKind> for CommitLevel {
    fn from(level: CommitLevelKind) -> Self {
        match level {
            CommitLevelKind::Sync => CommitLevel::Sync,
            CommitLevelKind::GroupCommit => CommitLevel::GroupCommit,
        }
    }
}

/// Accumulated changes for one transaction.
#[derive(Debug, Default)]
pub struct Tx {
    pub events: Vec<crate::actor::StreamEvent>,
    pub entities: Vec<EntityWrite>,
    pub withdrawals: Vec<(String, String)>,
    pub history: Vec<VersionWrite>,
    pub stage: Option<(String, Vec<(String, Value)>)>,
    pub meta: Option<Value>,
    pub control: Option<crate::session_types::ControlState>,
    pub queue: Option<crate::input_queue::QueueState>,
    pub projection: Option<crate::projection::UiSnapshot>,
    /// Session-level projection fields set *after* this batch's events are
    /// folded (the old store set `session.completedAt` right after `apply`).
    pub projection_session: Vec<(String, Value)>,
    pub receipts: Vec<ReceiptWrite>,
}

impl Tx {
    /// Fold a static batch into this transaction.
    pub fn extend(&mut self, spec: BatchSpec) {
        self.events.extend(spec.events);
        self.entities.extend(spec.entities);
        self.withdrawals.extend(spec.withdrawals);
        self.history.extend(spec.history);
        if spec.stage.is_some() {
            self.stage = spec.stage;
        }
        if spec.meta.is_some() {
            self.meta = spec.meta;
        }
        if spec.control.is_some() {
            self.control = spec.control;
        }
        if spec.queue.is_some() {
            self.queue = spec.queue;
        }
        if spec.projection.is_some() {
            self.projection = spec.projection;
        }
        self.receipts.extend(spec.receipts);
    }
}

/// What a commit wrote.
#[derive(Debug, Clone, Copy, Default)]
pub struct CommitOutcome {
    pub first_seq: u64,
    pub last_seq: u64,
    pub lines: usize,
}

/// A session's mutable shard.
struct Shard {
    handle: SessionHandle,
    /// Set when a group-committed batch awaits `fdatasync`.
    dirty: bool,
}

struct Inner {
    root: PathBuf,
    lock: StoreLock,
    shards: Mutex<HashMap<String, Arc<Mutex<Shard>>>>,
    /// Session rows for `session_list`, ordered by `(updatedAt, id)`.
    index: Mutex<BTreeMap<(String, String), Value>>,
    dirty: Mutex<Vec<Arc<Mutex<Shard>>>>,
    flush_now: Condvar,
    stopped: AtomicBool,
}

/// Handle to one store root.
#[derive(Clone)]
pub struct JsonlStore {
    inner: Arc<Inner>,
}

impl JsonlStore {
    /// Take the exclusive lock, scan the session index and start the flusher.
    pub fn open(root: impl AsRef<Path>) -> Result<Self, JsonlError> {
        let root = root.as_ref().to_path_buf();
        let lock = StoreLock::acquire(&root).map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                JsonlError::Busy(error.to_string())
            } else {
                io_error(error)
            }
        })?;
        let store = Self {
            inner: Arc::new(Inner {
                root,
                lock,
                shards: Mutex::new(HashMap::new()),
                index: Mutex::new(BTreeMap::new()),
                dirty: Mutex::new(Vec::new()),
                flush_now: Condvar::new(),
                stopped: AtomicBool::new(false),
            }),
        };
        store.rebuild_index()?;
        store.start_flusher();
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    fn shard(&self, session_id: &str) -> Result<Arc<Mutex<Shard>>, JsonlError> {
        let mut shards = self.inner.shards.lock().map_err(poisoned)?;
        if let Some(shard) = shards.get(session_id) {
            return Ok(shard.clone());
        }
        let handle = SessionHandle::open(&self.inner.root, session_id).map_err(io_error)?;
        let shard = Arc::new(Mutex::new(Shard { handle, dirty: false }));
        shards.insert(session_id.to_owned(), shard.clone());
        Ok(shard)
    }

    pub fn session_exists(&self, session_id: &str) -> bool {
        log::session_path(&self.inner.root, session_id)
            .map(|dir| dir.join("meta.json").exists())
            .unwrap_or(false)
    }

    /// Run `f` against a session's exclusive shard.
    pub fn with_session<R>(&self, session_id: &str, f: impl FnOnce(&mut SessionHandle) -> Result<R, JsonlError>) -> Result<R, JsonlError> {
        let shard = self.shard(session_id)?;
        let mut guard = shard.lock().map_err(poisoned)?;
        f(&mut guard.handle)
    }

/// Apply a transaction under the session lock. Used by callers that built
/// the transaction inside [`Self::with_session`].
pub fn apply_locked(&self, session_id: &str, tx: Tx, level: CommitLevelKind) -> Result<CommitOutcome, JsonlError> {
    let shard = self.shard(session_id)?;
    let mut guard = shard.lock().map_err(poisoned)?;
    let projection_before = guard.handle.view.projection.clone();
    self.apply_tx(session_id, &mut guard, tx, level, projection_before)
}

/// Run one transaction: the closure sees the current view and fills a
/// [`Tx`]. The store folds the `Tx` onto the live view, appends one lease
/// record plus the batch's lines, and publishes a new read snapshot. A failed
/// append rolls the live view back and leaves the published snapshot untouched.
pub fn transact<R>(
    &self,
    session_id: &str,
    level: CommitLevelKind,
    f: impl FnOnce(&SessionView, &mut Tx) -> Result<R, JsonlError>,
) -> Result<(R, CommitOutcome), JsonlError> {
    let shard = self.shard(session_id)?;
    let mut guard = shard.lock().map_err(poisoned)?;
    let mut tx = Tx::default();
    let projection_before = guard.handle.view.projection.clone();
    let result = f(&guard.handle.view, &mut tx)?;
    let seq = self.apply_tx(session_id, &mut guard, tx, level, projection_before)?;
    Ok((result, seq))
}

/// Convenience wrapper for batches that carry no return value.
pub fn commit(&self, session_id: &str, spec: BatchSpec) -> Result<CommitOutcome, JsonlError> {
    let level = spec.level;
    self.transact(session_id, level, |_, tx| {
        tx.extend(spec);
        Ok(())
    })
    .map(|(_, outcome)| outcome)
}


    fn apply_tx(
        &self,
        session_id: &str,
        guard: &mut MutexGuard<'_, Shard>,
        tx: Tx,
        level: CommitLevelKind,
        projection_before: Option<crate::projection::UiSnapshot>,
    ) -> Result<CommitOutcome, JsonlError> {
        // A `Sync` transaction writes one lease record: it carries the sparse
        // state patch the batch changed and (when the batch replaced it) a full
        // projection, so `meta.wal` never repeats the whole session state per
        // event. Recovery folds the batch's lines, then skips every line at or
        // below the highest lease it sees.
        let leased = level == CommitLevelKind::Sync;
        let view = &mut guard.handle.view;
        let last_seq_before = view.last_seq;
        let cursor_before = view.cursor;
        let events_before = view.events.len();
        let projection_changed = tx.projection.is_some();
        let patch = view::sparse_patch(&tx.lease_patch);
        if leased
            && let Some(patch) = &patch
        {
            view.apply_patch(patch);
            view.sync_scalars_to_projection();
        }
        let events = tx.events;
        let mut seq = view.last_seq;
        let mut lines: Vec<(LineSelector, Vec<u8>)> = Vec::new();
        if !leased
        let mut lines: Vec<(LineSelector, Vec<u8>)> = Vec::new();
        {
            view.projection = Some(projection);
        }
        // Events fold before the `meta` patch: each one advances the cursor, and
        // the patch then records the final state. Applying the patch first would
        // pre-advance the cursor past the batch's own events.
        if let Some(control) = &tx.control {
            view.control = control.clone();
        }
        if let Some(queue) = &tx.queue {
            view.queue = queue.clone();
            if let Some(projection) = view.projection.as_mut() {
                projection.set_queue(queue);
            }
        }
        for entity in &tx.entities {
            seq += 1;
            view.put_entity(&entity.kind, &entity.id, entity.value.clone(), entity.root, seq);
            let body = format!("\"root\":{},\"value\":{}", entity.root, entity.value);
            lines.push((LineSelector::Entity { kind: entity.kind.clone() }, log::line_for(seq, "?", &entity.kind, &entity.id, &body)));
        }
        for (kind, id) in &tx.withdrawals {
            seq += 1;
            view.withdraw_entity(kind, id);
            lines.push((LineSelector::Entity { kind: kind.clone() }, log::line_for(seq, "?", kind, id, "\"root\":false,\"value\":null")));
        }
        if let Some((kind, staged)) = &tx.stage {
            for (id, value) in staged {
                seq += 1;
                view.put_entity(kind, id, value.clone(), true, seq);
                view.history_cursor += 1;
                lines.push((LineSelector::Entity { kind: kind.clone() }, log::line_for(seq, "?", kind, id, &format!("\"root\":true,\"value\":{value}"))));
                seq += 1;
                let revision = view.history_cursor;
                lines.push((LineSelector::History, log::line_for(seq, "version", kind, id, &format!("\"revision\":{revision},\"value\":{value}"))));
            }
        }
        for version in &tx.history {
            seq += 1;
            lines.push((
                LineSelector::History,
                log::line_for(seq, "version", &version.kind, &version.id, &format!("\"revision\":{},\"value\":{}", version.revision, version.value)),
            ));
        }
        for receipt in &tx.receipts {
            seq += 1;
            view.put_receipt(
                &receipt.scope,
                &receipt.request_id,
                Receipt { fingerprint: receipt.fingerprint.clone(), result: receipt.result.clone(), stored_at: now_ms() },
            );
            let body = format!(
                "\"scope\":{},\"requestId\":{},\"fingerprint\":{},\"storedAt\":{},\"result\":{}",
                serde_json::to_string(&receipt.scope)?,
                serde_json::to_string(&receipt.request_id)?,
                serde_json::to_string(&receipt.fingerprint)?,
                now_ms(),
                receipt.result,
            );
            lines.push((LineSelector::Receipts, log::line_for(seq, "receipt", "?", "?", &body)));
        }
        view.prune_receipts(now_ms());
        for event in &events {
            // The cursor advances as the batch is folded, so consecutive events
            // validate against the running view, not the pre-batch cursor.
            if event.sequence != view.cursor + 1 {
                return Err(JsonlError::Runtime(crate::actor::RuntimeError::InvalidCommand(
                    "stream batch is not contiguous with the session cursor".into(),
                )));
            }
            // The event's session sequence *is* its line envelope `seq`.
            seq = seq.max(event.sequence);
            let payload = serde_json::from_slice::<Value>(&event.payload).map_err(|_| {
                JsonlError::Runtime(crate::actor::RuntimeError::InvalidCommand(
                    "projection requires a schema:1 event payload".into(),
                ))
            })?;
            view.push_event(event.clone());
            let pending = crate::actor::PendingEvent { kind: event.kind.clone(), payload: event.payload.clone() };
            if let Some(projection) = view.projection.as_mut() {
                projection.apply(event.sequence, &event.run_id, &pending).map_err(|error| {
                    JsonlError::Runtime(crate::actor::RuntimeError::InvalidCommand(format!(
                        "{error}: run_id={} kind={} payload={}",
                        event.run_id,
                        event.kind,
                        String::from_utf8_lossy(&event.payload)
                    )))
                })?;
            }
            let body = format!(
                "\"runId\":{},\"kind\":{},\"payload\":{}",
                serde_json::to_string(&event.run_id)?,
                serde_json::to_string(&event.kind)?,
                payload,
            );
            lines.push((LineSelector::Event, log::line_for(event.sequence, "event", "?", "?", &body)));
        }
        if let Some(projection) = view.projection.as_mut() {
            for (key, value) in &tx.projection_session {
                projection.session[key.as_str()] = value.clone();
            }
        }
        if let Some(meta) = &tx.meta {
            view.apply_patch(meta);
        }
        seq += 1;
        view.last_seq = seq;

        // The lease describes the final state, so it is serialised after every
        // fold above. It goes first in the batch's write so recovery stops at it.
        let lease = leased.then(|| {
            let projection = projection_changed.then(|| view.projection.as_ref()).flatten();
            view::lease_record(seq, patch.as_ref(), &tx.projection_session, projection, projection_before.as_ref())
        });
        let mut log_batch = LogBatch { level: level.into(), lines: Vec::with_capacity(lines.len() + 1) };
        let mut log_batch = LogBatch { level: level.into(), lines: Vec::with_capacity(lines.len() + 1) };
            log_batch.lines.push(guard.handle.log.line_spec(LineSelector::MetaWal, lease).map_err(io_error)?);
        }
        for (selector, bytes) in lines {
            log_batch.lines.push(guard.handle.log.line_spec(selector, bytes).map_err(io_error)?);
        }
        let written = match guard.handle.log.apply_batch(log_batch) {
            Ok(written) => written,
            Err(error) => {
                // A failed append leaves the last acknowledged batch visible:
                // undo what this batch folded into the live view, keep serving
                // the snapshot published by the previous successful commit.
                let view = &mut guard.handle.view;
                view.events.truncate(events_before);
                view.cursor = cursor_before;
                view.last_seq = last_seq_before;
                if projection_changed {
                    view.projection = projection_before;
                }
                return Err(io_error(error));
            }
        };
        let now = now_ms();
        view.prune_receipts(now);
        while view.receipts.len() > MAX_RECEIPTS {
            let oldest = view.receipts.iter().min_by_key(|(_, receipt)| receipt.stored_at).map(|(key, _)| key.clone());
            match oldest {
                Some(key) => {
                    view.receipts.remove(&key);
                }
                None => break,
            }
        }
        if level == CommitLevelKind::Sync {
            self.persist_meta(&mut guard.handle)?;
        } else {
            // Without a lease record the batch's own lines must be visible to
            // recovery; keep the full state patch for that mode only.
            let mut lines = Vec::new();
            lines.push(guard.handle.log.line_spec(LineSelector::MetaWal, log::line_for(seq, "meta", "?", "?", &format!("\"patch\":{}", view.state_patch()))).map_err(io_error)?);
            guard.handle.log.apply_batch(LogBatch { level: level.into(), lines }).map_err(io_error)?;
            guard.dirty = true;
            self.queue_flush_for(session_id)?;
        }
        let (first_seq, last_seq, line_count) = (written.lines as u64, view.last_seq, written.lines);
        guard.handle.publish();
        self.update_index(&guard.handle.view);
        Ok(CommitOutcome { first_seq, last_seq, lines: line_count })
    }

    /// Replace `meta.json` and empty `meta.wal`.
    fn persist_meta(&self, handle: &mut SessionHandle) -> Result<(), JsonlError> {
        handle.checkpoint_meta().map_err(io_error)
    }

    fn queue_flush_for(&self, session_id: &str) -> Result<(), JsonlError> {
        let shard = self.inner.shards.lock().map_err(poisoned)?.get(session_id).cloned();
        if let Some(shard) = shard {
            if let Ok(mut dirty) = self.inner.dirty.lock() {
                dirty.push(shard);
            }
        }
        Ok(())
    }

    fn start_flusher(&self) {
        // The thread must not keep the store alive: it holds a weak handle, so
        // dropping the last `JsonlStore` releases the store lock deterministically.
        let inner = Arc::downgrade(&self.inner);
        std::thread::Builder::new().name("synax-jsonl-flush".into()).spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(FLUSH_INTERVAL_MS));
                    let Some(inner) = Weak::upgrade(&inner) else {
                        break;
                    };
                    if inner.stopped.load(Ordering::Acquire) {
                        break;
                    }
                    // Sessions written since the last tick only need a group-commit
                    // `fdatasync`; `meta.wal` holds their state until the next checkpoint.
                    let shards: Vec<Arc<Mutex<Shard>>> = {
                        let mut dirty = match inner.dirty.lock() {
                            Ok(dirty) => dirty,
                            Err(_) => break,
                        };
                        std::mem::take(&mut *dirty)
                    };
                    for shard in shards {
                        let Ok(mut guard) = shard.lock() else { continue };
                        if !guard.needs_flush() {
                            continue;
                        }
                        if let Err(error) = guard.checkpoint() {
                            // Keep the session dirty so the next tick retries.
                            if let Ok(mut dirty) = inner.dirty.lock() {
                                dirty.push(shard.clone());
                            }
                            eprintln!("[runtime-sidecar] jsonl checkpoint failed: {error}");
                        }
                    }
                    inner.flush_now.notify_all();
                }
            }).expect("start jsonl flusher");
    }

    /// Force every session to disk: sync the logs, then fold `meta.wal` into
    /// `meta.json` and truncate it.
    pub fn flush(&self) -> Result<(), JsonlError> {
        let shards: Vec<Arc<Mutex<Shard>>> = {
            let shards = self.inner.shards.lock().map_err(poisoned)?;
            let mut dirty = self.inner.dirty.lock().map_err(poisoned)?;
            dirty.clear();
            shards.values().cloned().collect()
        };
        for shard in shards {
            let mut guard = shard.lock().map_err(poisoned)?;
            if guard.needs_flush() {
                guard.checkpoint().map_err(io_error)?;
            }
        }
        Ok(())
    }

    /// Rebuild the session index from `meta.json` headers only.
    ///
    /// Only sessions with a list row are opened; a large session's `meta.wal`
    /// is not replayed here.
    fn rebuild_index(&self) -> Result<(), JsonlError> {
        let sessions = self.inner.root.join("sessions");
        let mut index = self.inner.index.lock().map_err(poisoned)?;
        index.clear();
        let Ok(shards) = fs::read_dir(&sessions) else {
            return Ok(());
        };
        for shard_entry in shards {
            let Ok(shard_entry) = shard_entry else { continue };
            let Ok(entries) = fs::read_dir(shard_entry.path()) else { continue };
            for entry in entries {
                let Ok(entry) = entry else { continue };
                let Ok(bytes) = fs::read(entry.path().join("meta.json")) else { continue };
                let Ok(meta) = serde_json::from_slice::<Value>(&bytes) else { continue };
                if let Some(row) = meta.get("listHeader").filter(|row| !row.is_null()) {
                    let id = meta.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
                    let updated = row.get("updatedAt").and_then(Value::as_str).unwrap_or_default().to_owned();
                    index.insert((updated, id), row.clone());
                }
            }
        }
        Ok(())
    }

    fn update_index(&self, view: &SessionView) {
        let Some(projection) = view.projection.as_ref() else {
            return;
        };
        let row = projection.session.clone();
        let updated = row.get("updatedAt").and_then(Value::as_str).unwrap_or_default().to_owned();
        if let Ok(mut index) = self.inner.index.lock() {
            // The sort key includes `updatedAt`, so a session that has moved on
            // owns a new key; drop the stale one or it would appear twice.
            index.retain(|(_, id), _| id != &view.session_id);
            index.insert((updated, view.session_id.clone()), row);
        }
    }

    /// One `session_list` page: `(items, cursor)`.
    ///
    /// The cursor is the last `updatedAt` returned plus the last id, which is
    /// exactly the sort key: a session updated while a client pages is picked up
    /// by the next page instead of disappearing or repeating.
    pub fn session_list(&self, after: &str, limit: usize) -> Result<(Vec<Value>, Option<String>), JsonlError> {
        let index = self.inner.index.lock().map_err(poisoned)?;
        let limit = limit.clamp(1, SESSION_PAGE_ITEMS);
        // The sort key is `(updatedAt, id)`, so the cursor is a `(updatedAt, id)`
        // pair: a session updated while a client pages is picked up by the next
        // page instead of disappearing or repeating.
        let start = match session_cursor(after) {
            Some(key) => key,
            None => index.keys().next().cloned().unwrap_or_default(),
        };
        let (mut items, mut bytes, mut last, mut more) = (Vec::new(), 2048usize, None, false);
        for (key, row) in index.range(start..) {
            if !after.is_empty() && !session_after(after, key) {
                continue;
            }
            let cost = serde_json::to_vec(row)?.len() + 1;
            if items.len() == limit || bytes + cost > SESSION_PAGE_BYTES {
                more = true;
                break;
            }
            bytes += cost;
            last = Some(session_encode_cursor(key));
            items.push(row.clone());
        }
        Ok((items, if more { last } else { None }))
    }

    /// Events in `(after, through]`, reading segments when the memory window
    /// no longer covers them (outbox compensation).
    pub fn events_after(&self, session_id: &str, after: u64, through: u64, limit: usize) -> Result<Vec<crate::actor::StreamEvent>, JsonlError> {
        let shard = self.shard(session_id)?;
        let guard = shard.lock().map_err(poisoned)?;
        let view = &guard.handle.view;
        let mut events = Vec::new();
        let mut sequence = after + 1;
        while sequence <= through && events.len() < limit {
            if let Some(event) = view.event(sequence) {
                events.push(event.clone());
            } else {
                break;
            }
            sequence += 1;
        }
        if events.len() < limit && sequence <= through {
            // The window starts later than `after`: read the segments instead.
            let dir = guard.handle.session_dir();
            let mut all = Vec::new();
            for path in super::view::segment_files(&dir.join("events"))? {
                for (_, record) in log::read_segment(&path)? {
                    let Some(event_sequence) = record.get("seq").and_then(Value::as_u64) else { continue };
                    if event_sequence <= after || event_sequence > through {
                        continue;
                    }
                    let payload = record.get("payload").cloned().unwrap_or(Value::Null);
                    all.push((event_sequence, crate::actor::StreamEvent {
                        sequence: event_sequence,
                        run_id: record.get("runId").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        kind: record.get("kind").and_then(Value::as_str).unwrap_or_default().to_owned(),
                        payload: serde_json::to_vec(&payload).unwrap_or_default(),
                        ephemeral: false,
                    }));
                }
            }
            all.sort_by_key(|(sequence, _)| *sequence);
            events = all.into_iter().map(|(_, event)| event).take(limit).collect();
        }
        Ok(events)
    }

    /// Every `history/` version line in on-disk order.
    pub fn history_versions(&self, session_id: &str, kind: &str, id: &str) -> Result<Vec<Value>, JsonlError> {
        let dir = log::session_path(&self.inner.root, session_id).map_err(io_error)?;
        let mut versions = Vec::new();
        for path in super::view::segment_files(&dir.join("history"))? {
            for (_, record) in log::read_segment(&path)? {
                if record.get("type").and_then(Value::as_str) != Some("version") {
                    continue;
                }
                if record.get("kind").and_then(Value::as_str) != Some(kind) || record.get("id").and_then(Value::as_str) != Some(id) {
                    continue;
                }
                versions.push(record);
            }
        }
        Ok(versions)
    }

    /// Latest version record of `kind`/`id` from `history/`.
    pub fn history_version(&self, session_id: &str, kind: &str, id: &str) -> Result<Option<Value>, JsonlError> {
        Ok(self.history_versions(session_id, kind, id)?.pop())
    }

    /// Find one `object.*` record by id, whatever its kind.
    ///
    /// Object ids are content hashes, so a caller that holds an id does not need
    /// the original kind; scanning lets `head_switch`, `page` and
    /// `object_value_chunk` resolve any stored object.
    pub fn stored_object(&self, session_id: &str, object_id: &str) -> Result<Option<Value>, JsonlError> {
        let dir = log::session_path(&self.inner.root, session_id).map_err(io_error)?;
        let mut found = None;
        for path in super::view::segment_files(&dir.join("history"))? {
            for (_, record) in log::read_segment(&path)? {
                if record.get("type").and_then(Value::as_str) != Some("version")
                    || record.get("id").and_then(Value::as_str) != Some(object_id)
                {
                    continue;
                }
                if record.get("kind").and_then(Value::as_str).is_some_and(|kind| kind.starts_with("object.")) {
                    found = Some(record["value"].clone());
                }
            }
        }
        Ok(found)
    }

    /// Every `object.*` record id currently stored for a session.
    pub fn stored_object_ids(&self, session_id: &str) -> Result<Vec<String>, JsonlError> {
        let dir = log::session_path(&self.inner.root, session_id).map_err(io_error)?;
        let mut ids = Vec::new();
        for path in super::view::segment_files(&dir.join("history"))? {
            for (_, record) in log::read_segment(&path)? {
                if record.get("type").and_then(Value::as_str) != Some("version") {
                    continue;
                }
                let Some(kind) = record.get("kind").and_then(Value::as_str) else { continue };
                if !kind.starts_with("object.") {
                    continue;
                }
                if let Some(id) = record.get("id").and_then(Value::as_str) {
                    ids.push(id.to_owned());
                }
            }
        }
        ids.sort();
        ids.dedup();
        Ok(ids)
    }

    /// Drop every `object.*` record whose id is not pinned, rewriting the
    /// history segments in place. Returns the number of records removed.
    pub fn collect_objects(&self, session_id: &str, keep: &std::collections::HashSet<String>) -> Result<usize, JsonlError> {
        let dir = log::session_path(&self.inner.root, session_id).map_err(io_error)?;
        let mut removed = 0usize;
        for path in super::view::segment_files(&dir.join("history"))? {
            let records = log::read_segment(&path)?;
            if records.is_empty() {
                continue;
            }
            let kept: Vec<Vec<u8>> = records
                .iter()
                .filter(|(_, record)| {
                    let kind = record.get("kind").and_then(Value::as_str).unwrap_or_default();
                    let id = record.get("id").and_then(Value::as_str).unwrap_or_default();
                    let drop = kind.starts_with("object.") && !keep.contains(id);
                    if drop {
                        removed += 1;
                    }
                    !drop
                })
                .map(|(_, record)| {
                    let mut bytes = serde_json::to_vec(record)?;
                    bytes.push(b'\n');
                    Ok(bytes)
                })
                .collect::<Result<Vec<_>, serde_json::Error>>()?;
            if kept.len() != records.len() {
                let mut bytes = Vec::new();
                for line in kept {
                    bytes.extend_from_slice(&line);
                }
                log::atomic_write(&path, &bytes).map_err(io_error)?;
            }
        }
        Ok(removed)
    }

    /// Snapshot of one entity kind, ordered by id.
    pub fn entities_of(&self, session_id: &str, kind: &str) -> Result<BTreeMap<String, Value>, JsonlError> {
        let shard = self.shard(session_id)?;
        let guard = shard.lock().map_err(poisoned)?;
        Ok(guard
            .handle
            .view
            .entities
            .get(kind)
            .map(|entries| entries.iter().map(|(id, entity)| (id.clone(), entity.value.clone())).collect())
            .unwrap_or_default())
    }

    /// Read one entity's latest value.
    pub fn entity_of(&self, session_id: &str, kind: &str, id: &str) -> Result<Option<Value>, JsonlError> {
        let shard = self.shard(session_id)?;
        let guard = shard.lock().map_err(poisoned)?;
        Ok(guard.handle.view.entity(kind, id).cloned())
    }

    /// Remove one session's directory and its index row.
    pub fn remove_session(&self, session_id: &str) -> Result<(), JsonlError> {
        {
            let mut shards = self.inner.shards.lock().map_err(poisoned)?;
            shards.remove(session_id);
        }
        let dir = log::session_path(&self.inner.root, session_id).map_err(io_error)?;
        match fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
        if let Ok(mut index) = self.inner.index.lock() {
            index.retain(|(_, id), _| id != session_id);
        }
        Ok(())
    }

    /// Drop every session (`test_reset_runtime`).
    pub fn reset_all(&self) -> Result<(), JsonlError> {
        let sessions = self.inner.root.join("sessions");
        if let Ok(shards) = fs::read_dir(&sessions) {
            for shard_entry in shards.flatten() {
                if let Ok(entries) = fs::read_dir(shard_entry.path()) {
                    for entry in entries.flatten() {
                        let _ = fs::remove_dir_all(entry.path());
                    }
                }
                let _ = fs::remove_dir(shard_entry.path());
            }
        }
        self.inner.shards.lock().map_err(poisoned)?.clear();
        self.inner.index.lock().map_err(poisoned)?.clear();
        Ok(())
    }

    /// Clear one session's data and leave an empty directory.
    pub fn reset_session(&self, session_id: &str) -> Result<(), JsonlError> {
        self.remove_session(session_id)?;
        let dir = log::session_path(&self.inner.root, session_id).map_err(io_error)?;
        fs::create_dir_all(&dir).map_err(io_error)?;
        log::atomic_write(&dir.join("meta.json"), &serde_json::to_vec(&SessionView::new(session_id).to_meta())?)?;
        Ok(())
    }

    /// Append a value to `assets/`, returning its `sha256:` key.
    pub fn asset_put(&self, bytes: &[u8]) -> Result<String, JsonlError> {
        super::assets::put(&self.inner.root, bytes).map_err(io_error)
    }

    pub fn asset_get(&self, key: &str) -> Result<Option<Vec<u8>>, JsonlError> {
        super::assets::get(&self.inner.root, key).map_err(io_error)
    }

    /// Write an agent-loop checkpoint (`checkpoint.json`, atomic replace).
    pub fn put_loop_checkpoint(&self, loop_id: &str, checkpoint: &[u8]) -> Result<(), JsonlError> {
        let dir = self.loop_dir(loop_id)?;
        fs::create_dir_all(&dir).map_err(io_error)?;
        log::atomic_write(&dir.join("checkpoint.json"), checkpoint).map_err(io_error)
    }

    /// Append loop events; ids are global, so they live under `<root>/loops/`.
    pub fn append_loop_events(&self, loop_id: &str, events: &[(u64, Vec<u8>)], sync: bool) -> Result<(), JsonlError> {
        let dir = self.loop_dir(loop_id)?.join("events");
        fs::create_dir_all(&dir).map_err(io_error)?;
        let path = dir.join("000001.jsonl");
        let mut file = fs::OpenOptions::new().create(true).append(true).open(&path).map_err(io_error)?;
        use std::io::Write;
        for (_, bytes) in events {
            file.write_all(bytes).map_err(io_error)?;
            file.write_all(b"\n").map_err(io_error)?;
        }
        if sync {
            file.sync_data().map_err(io_error)?;
        }
        Ok(())
    }

    /// `(checkpoint bytes, events in sequence order)`.
    pub fn load_loop(&self, loop_id: &str) -> Result<Option<(Vec<u8>, Vec<Vec<u8>>)>, JsonlError> {
        let dir = self.loop_dir(loop_id)?;
        let checkpoint = match fs::read(dir.join("checkpoint.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(error)),
        };
        let mut events = Vec::new();
        for path in super::view::segment_files(&dir.join("events"))? {
            for line in fs::read(&path)?.split(|byte| *byte == b'\n') {
                if !line.is_empty() {
                    events.push(line.to_vec());
                }
            }
        }
        Ok(Some((checkpoint, events)))
    }

    fn loop_dir(&self, loop_id: &str) -> Result<PathBuf, JsonlError> {
        if loop_id.is_empty()
            || loop_id.len() > 128
            || !loop_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
        {
            return Err(JsonlError::Runtime(crate::actor::RuntimeError::InvalidCommand(
                "invalid agent loop id".into(),
            )));
        }
        Ok(self.inner.root.join("loops").join(loop_id))
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Ok(mut dirty) = self.dirty.lock() {
            std::mem::take(&mut *dirty);
        }
        if let Ok(shards) = self.shards.lock() {
            for shard in shards.values() {
                if let Ok(mut guard) = shard.lock() {
                    let _ = guard.handle.log.fsync_pending();
                }
            }
        }
        let _ = &self.lock;
    }
}

/// Parse a `session_list` cursor back into the index sort key.
fn session_cursor(cursor: &str) -> Option<(String, String)> {
    if cursor.is_empty() {
        return None;
    }
    let (updated, id) = cursor.rsplit_once('|')?;
    Some((updated.to_owned(), id.to_owned()))
}

/// Encode an index sort key as a `session_list` cursor.
fn session_encode_cursor((updated, id): &(String, String)) -> String {
    format!("{updated}|{id}")
}

/// Whether `key` sorts strictly after `cursor`.
fn session_after(cursor: &str, key: &(String, String)) -> bool {
    match session_cursor(cursor) {
        Some(cursor) => key > &cursor,
        None => true,
    }
}

fn poisoned<T>(_: T) -> JsonlError {
    JsonlError::Runtime(crate::actor::RuntimeError::StorageUnavailable("jsonl store lock poisoned".into()))
}

/// Convenience: the `meta.json` value for a fresh session.
pub fn empty_meta(session_id: &str) -> Value {
    SessionView::new(session_id).to_meta()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actor::StreamEvent;

    fn root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("synax-store-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn event(sequence: u64) -> StreamEvent {
        StreamEvent {
            sequence,
            run_id: "r".into(),
            kind: "delta".into(),
            payload: serde_json::to_vec(&json!({"schema": 1, "chunk": {"type": "delta"}, "state": {"status": "running"}})).unwrap(),
            ephemeral: false,
        }
    }

    #[test]
    fn a_second_open_on_the_same_root_is_busy() {
        let dir = root("busy");
        let store = JsonlStore::open(&dir).unwrap();
        assert!(matches!(JsonlStore::open(&dir), Err(JsonlError::Busy(_))));
        drop(store);
        assert!(JsonlStore::open(&dir).is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_batch_is_atomic_in_memory_and_on_disk_across_reopen() {
        let dir = root("atomic");
        let store = JsonlStore::open(&dir).unwrap();
        store
            .commit("s", BatchSpec {
                    level: CommitLevelKind::Sync,
                    entities: vec![EntityWrite { kind: "runtime.step".into(), id: "stp_1".into(), root: true, value: json!({"id":"stp_1","n":1}) }],
                    meta: Some(json!({"epoch": 1, "revision": 1})),
                    ..Default::default()
                }
            )
            .unwrap();
        store
            .commit("s", BatchSpec { level: CommitLevelKind::Sync, events: vec![event(1)], ..Default::default() })
            .unwrap();
        drop(store);
        let reopened = JsonlStore::open(&dir).unwrap();
        reopened
            .with_session("s", |handle| {
                assert_eq!(handle.view.revision, 1);
                assert_eq!(handle.view.cursor, 1);
                assert_eq!(handle.view.entity("runtime.step", "stp_1").unwrap()["n"], 1);
                assert_eq!(handle.view.events.len(), 1);
                Ok(())
            })
            .unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_rejected_batch_writes_nothing() {
        let dir = root("reject");
        let store = JsonlStore::open(&dir).unwrap();
        let error = store
            .commit("s", BatchSpec { level: CommitLevelKind::Sync, events: vec![event(4)], ..Default::default() })
            .unwrap_err();
        assert!(matches!(error, JsonlError::Runtime(crate::actor::RuntimeError::InvalidCommand(_))));
        store
            .with_session("s", |handle| {
                assert_eq!(handle.view.cursor, 0);
                assert_eq!(handle.view.last_seq, 0);
                Ok(())
            })
            .unwrap();
        drop(store);
        let dir = log::session_path(&dir, "s").unwrap();
        assert_eq!(fs::read(dir.join("events").join("000001.jsonl")).unwrap_or_default(), Vec::<u8>::new());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn idempotent_receipts_survive_reopen_and_do_not_advance_state() {
        let dir = root("receipt");
        let store = JsonlStore::open(&dir).unwrap();
        let write = |store: &JsonlStore| {
            store
                .commit("s", BatchSpec {
                        level: CommitLevelKind::Sync,
                        receipts: vec![ReceiptWrite { scope: "control".into(), request_id: "req".into(), fingerprint: "abc".into(), result: json!({"ok": true}) }],
                        ..Default::default()
                    }
            )
                .unwrap()
        };
        write(&store);
        let revision = store.with_session("s", |handle| Ok(handle.view.revision)).unwrap();
        drop(store);
        let reopened = JsonlStore::open(&dir).unwrap();
        reopened
            .with_session("s", |handle| {
                assert_eq!(handle.view.receipt("control", "req").unwrap().fingerprint, "abc");
                assert_eq!(handle.view.revision, revision);
                Ok(())
            })
            .unwrap();
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn group_commit_is_durable_after_flush_and_before_drop() {
        let dir = root("group");
        let store = JsonlStore::open(&dir).unwrap();
        store
            .commit("s", BatchSpec { level: CommitLevelKind::GroupCommit, events: vec![event(1)], ..Default::default() })
            .unwrap();
        store.flush().unwrap();
        drop(store);
        let reopened = JsonlStore::open(&dir).unwrap();
        assert_eq!(reopened.with_session("s", |handle| Ok(handle.view.cursor)).unwrap(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn session_list_pages_by_updated_at_and_bounds_each_page() {
        let dir = root("list");
        let store = JsonlStore::open(&dir).unwrap();
        for index in 0..3u32 {
            let mut projection = crate::projection::UiSnapshot::seed(
                &format!("s{index}"),
                format!(r#"{{"id":"s{index}","projectId":"p","status":"queued","updatedAt":"2026-10-20T0{index}:00:00Z"}}"#).as_bytes(),
            )
            .unwrap();
            projection.cursor = 0;
            store
                .commit(&format!("s{index}"), BatchSpec { level: CommitLevelKind::Sync, projection: Some(projection), ..Default::default() })
                .unwrap();
        }
        let (first, next) = store.session_list("", 2).unwrap();
        assert_eq!(first.len(), 2);
        assert!(next.is_some());
        let (second, next) = store.session_list(next.as_deref().unwrap(), 2).unwrap();
        assert_eq!(second.len(), 1);
        assert!(next.is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reset_all_removes_every_session() {
        let dir = root("reset");
        let store = JsonlStore::open(&dir).unwrap();
        store
            .commit("s", BatchSpec { level: CommitLevelKind::Sync, events: vec![event(1)], ..Default::default() })
            .unwrap();
        store.reset_all().unwrap();
        assert!(!store.session_exists("s"));
        let (items, _) = store.session_list("", 10).unwrap();
        assert!(items.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn agent_loop_journals_round_trip() {
        let dir = root("loop");
        let store = JsonlStore::open(&dir).unwrap();
        store.put_loop_checkpoint("loop-1", b"{\"version\":1}").unwrap();
        store.append_loop_events("loop-1", &[(1, b"{\"a\":1}".to_vec()), (2, b"{\"a\":2}".to_vec())], true).unwrap();
        let (checkpoint, events) = store.load_loop("loop-1").unwrap().unwrap();
        assert_eq!(checkpoint, b"{\"version\":1}");
        assert_eq!(events.len(), 2);
        assert!(store.load_loop("missing").unwrap().is_none());
        assert!(store.load_loop("../escape").is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
