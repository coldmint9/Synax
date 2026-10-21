//! The process-wide store: one lock per root, one handle per session, and the
//! root-level session-list index.

pub mod list_index;
mod summary_cache;
mod summary_replay;
#[cfg(test)]
mod tests;

use crate::storage::session_cache::SessionCache;
use futures_util::{StreamExt, stream};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

use arc_swap::ArcSwap;
use parking_lot::{Mutex, RwLock};

use super::error::{JsonlError, JsonlResult};

use super::record::{ListRecord, SnapshotCond};
use super::session::{Lake, SessionActor, SessionHandle, SessionHandleCell, load};
use crate::runtime::input_queue::QueueState;
use crate::runtime::session_types::ControlState;

pub use list_index::{ListIndex, ListKey};

/// The store root: created once, shared by every session handle.
pub struct Root {
    pub path: PathBuf,
    pub lock: crate::storage::jsonl::lock::StoreLock,
    pub(crate) sessions: SessionCache<SessionHandle>,
    pub list: RwLock<ListIndex>,
    index_state: AtomicU8,
    index_error: Mutex<Option<String>>,
}

#[derive(Clone)]
pub struct JsonlStore {
    root: Arc<Root>,
}

impl JsonlStore {
    pub fn open(path: impl AsRef<Path>) -> JsonlResult<Self> {
        let path = path.as_ref().to_path_buf();
        let lock = crate::storage::jsonl::lock::StoreLock::acquire(&path)?;
        tracing::info!(event = "storage.opened", "Runtime store opened");
        Ok(Self {
            root: Arc::new(Root {
                path,
                lock,
                sessions: SessionCache::default(),
                list: RwLock::new(ListIndex::default()),
                index_state: AtomicU8::new(0),
                index_error: Mutex::new(None),
            }),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root.path
    }

    pub fn list(&self) -> &RwLock<ListIndex> {
        &self.root.list
    }

    /// The handle for `session_id`, loading it on first touch.
    pub fn session(&self, session_id: &str) -> JsonlResult<SessionHandle> {
        super::layout::validate_session_id(session_id)?;
        let handle = self.root.sessions.get_or_try_init(session_id, || -> JsonlResult<SessionHandle> {
            let started = std::time::Instant::now();
            let loaded = load::load(&self.root.path, session_id)?;
            tracing::debug!(
                event = "storage.session_loaded",
                session_id,
                duration_ms = started.elapsed().as_millis() as u64,
                replayed_commits = loaded.replayed_commits,
                checkpoint_commit = loaded.checkpoint_commit,
                "Session store loaded"
            );
            let handle = build_handle(&self.root.path, session_id, loaded);
            if handle.read().header.is_object() {
                let actor = handle.actor.lock();
                self.root
                    .list
                    .write()
                    .upsert(super::session::list_row(&actor));
            }
            Ok(handle)
        })?;
        self.evict_idle();
        Ok(handle)
    }

    /// Restore summary rows without opening historical session actors. Older
    /// sessions without a valid cache read their committed header fields once.
    pub fn index_ready(&self) -> Result<bool, String> {
        if self
            .root
            .index_state
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            let store = self.clone();
            tokio::spawn(async move {
                let started = std::time::Instant::now();
                let result = store.load_index().await;
                match result {
                    Ok(()) => {
                        store.root.index_state.store(2, Ordering::Release);
                        tracing::info!(
                            event = "storage.index_ready",
                            duration_ms = started.elapsed().as_millis() as u64,
                            "Session index ready"
                        );
                    }
                    Err(error) => {
                        tracing::error!(
                            event = "storage.index_failed",
                            "Session index scan failed"
                        );
                        *store.root.index_error.lock() = Some(error);
                        store.root.index_state.store(3, Ordering::Release);
                    }
                }
            });
        }
        match self.root.index_state.load(Ordering::Acquire) {
            2 => Ok(true),
            3 => Err(self
                .root
                .index_error
                .lock()
                .clone()
                .unwrap_or_else(|| "Session index unavailable".into())),
            _ => Ok(false),
        }
    }

    async fn load_index(&self) -> Result<(), String> {
        let directory = self.root.path.join(super::layout::SESSIONS_DIR);
        let ids = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<String>> {
            let mut ids = Vec::new();
            let shards = match std::fs::read_dir(directory) {
                Ok(shards) => shards,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(ids),
                Err(error) => return Err(error),
            };
            for shard in shards {
                let shard = shard?;
                if !shard.file_type()?.is_dir() {
                    continue;
                }
                for entry in std::fs::read_dir(shard.path())? {
                    let entry = entry?;
                    if entry.file_type()?.is_dir() {
                        ids.push(entry.file_name().to_string_lossy().into_owned());
                    }
                }
            }
            Ok(ids)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let mut loads = stream::iter(ids)
            .map(|id| {
                let store = self.clone();
                async move {
                    tokio::task::spawn_blocking(move || store.load_list_entry(&id))
                        .await
                        .map_err(|e| e.to_string())?
                        .map_err(|e| e.to_string())
                }
            })
            .buffer_unordered(2);
        // spawn_blocking cannot be cancelled. Drain already-started readers even
        // after a failure before publishing completion or allowing a test reset.
        let mut failure = None;
        while let Some(result) = loads.next().await {
            if let Err(error) = result { failure.get_or_insert(error); }
        }
        failure.map_or(Ok(()), Err)
    }

    fn load_list_entry(&self, id: &str) -> JsonlResult<bool> {
        if self.root.sessions.get(id).is_some() { return Ok(false); }
        if let Some(row) = summary_cache::read(&self.root.path, id) {
            self.root.list.write().insert_cached(row);
            return Ok(false);
        }
        let row = summary_cache::rebuild(&self.root.path, id)?;
        self.root.list.write().insert_cached(row);
        Ok(true)
    }

    pub fn session_summary(&self, id: &str) -> JsonlResult<Option<serde_json::Value>> {
        super::layout::validate_session_id(id)?;
        if let Some(row) = self.root.list.read().get(id) { return Ok(Some(row)); }
        self.load_list_entry(id)?;
        Ok(self.root.list.read().get(id))
    }

    fn cache_summary(&self, actor: &SessionActor) {
        if let Err(error) = summary_cache::write(&self.root.path, actor) {
            // Cache failures cannot fail an otherwise durable session write.
            tracing::warn!(event = "storage.summary_cache_failed", session_id = actor.id,
                error = %error, "Session summary will be rebuilt on next startup");
        }
    }

    fn checkpoint(&self, actor: &mut SessionActor, force: bool) {
        if let Err(error) = super::session::checkpoint::save(&self.root.path, actor, force) {
            tracing::warn!(event = "storage.checkpoint_failed", session_id = actor.id, error = %error,
                "Runtime checkpoint will be retried; committed logs remain authoritative");
        }
    }

    pub async fn wait_for_index_scan(&self) {
        while self.root.index_state.load(Ordering::Acquire) == 1 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    pub fn session_exists(&self, session_id: &str) -> bool {
        self.root.sessions.get(session_id).is_some()
            || super::layout::session_dir(&self.root.path, session_id)
                .map(|dir| dir.is_dir())
                .unwrap_or(false)
    }

    /// Make every session's appended frames durable.
    pub fn flush(&self) -> JsonlResult<()> {
        let started = std::time::Instant::now();
        let handles = self.root.sessions.values();
        for handle in handles {
            let mut actor = handle.actor.lock();
            actor.sync()?;
            self.cache_summary(&actor);
            self.checkpoint(&mut actor, true);
        }
        tracing::info!(
            event = "storage.flushed",
            duration_ms = started.elapsed().as_millis() as u64,
            "Runtime store flushed"
        );
        Ok(())
    }

    pub fn flush_session(&self, session_id: &str) -> JsonlResult<()> {
        if let Some(handle) = self.root.sessions.get(session_id) {
            let mut actor = handle.actor.lock();
            actor.sync()?;
            self.cache_summary(&actor);
            self.checkpoint(&mut actor, false);
        }
        Ok(())
    }

    /// Release completed sessions from the hot cache once no operation still
    /// owns a handle. The durable list index remains available for listings.
    pub fn evict_idle(&self) -> usize {
        self.evict_with_policy(8, std::time::Duration::from_secs(300))
    }

    pub(crate) fn evict_with_policy(&self, capacity: usize, idle: std::time::Duration) -> usize {
        self.root.sessions.evict_prepared(capacity, idle, |handle| {
            // The cache's handle and its cell each own the actor. Any caller
            // clone adds another pair, so exactly two means no in-flight use.
            if Arc::strong_count(&handle.actor) != 2 {
                return false;
            }
            let mut actor = handle.actor.lock();
            actor.subscribers.retain(|subscriber| !subscriber.is_closed());
            if !actor.subscribers.is_empty()
                || actor.state.active_run_id.is_some()
                || !actor.active_runs.is_empty()
                || !actor.activated_runs.is_empty()
                || actor.control.runtime_control.is_some()
                || actor.control.execution_lease.as_ref().is_some_and(|lease| !lease.closed)
            {
                return false;
            }
            true
        }, |handle| {
            let mut actor = handle.actor.lock();
            if actor.sync().is_err() { return false; }
            self.cache_summary(&actor);
            self.checkpoint(&mut actor, true);
            true
        })
    }

    pub(crate) fn cached_session_idle(&self, session_id: &str) -> bool {
        let Some(handle) = self.root.sessions.peek(session_id) else {
            return true;
        };
        let Some(actor) = handle.actor.try_lock() else { return false; };
        actor.subscribers.iter().all(|subscriber| subscriber.is_closed())
            && actor.state.active_run_id.is_none()
            && actor.active_runs.is_empty()
            && actor.activated_runs.is_empty()
            && actor.control.runtime_control.is_none()
            && actor.control.execution_lease.as_ref().is_none_or(|lease| lease.closed)
    }

    pub fn update_list(&self, row: ListRecord) -> JsonlResult<()> {
        self.root.list.write().upsert(row);
        Ok(())
    }

    /// Remove every session directory (test reset).
    pub fn reset_all(&self) -> JsonlResult<()> {
        self.root.sessions.clear();
        let sessions = self.root.path.join(super::layout::SESSIONS_DIR);
        if sessions.exists() {
            std::fs::remove_dir_all(&sessions).map_err(JsonlError::io)?;
        }
        self.root.list.write().clear();
        self.root.index_state.store(2, Ordering::Release);
        *self.root.index_error.lock() = None;
        Ok(())
    }
}

/// Construct a handle whose actor keeps only a weak back-reference to its cell.
pub fn build_handle(root: &Path, session_id: &str, loaded: load::Loaded) -> SessionHandle {
    let id = session_id.to_owned();
    let actor = Arc::new(Mutex::new(SessionActor::from_loaded(loaded, 128)));
    let lake = Arc::new(ArcSwap::from_pointee(Lake {
        state: SnapshotCond {
            epoch: 1,
            retained_from: 1,
            ..Default::default()
        },
        header: Arc::new(serde_json::Value::Null),
        projection: Arc::new(load::empty_projection()),
        projection_ready: false,
        queue: Arc::new(QueueState::default()),
        control: Arc::new(ControlState::default()),
        ui_gen: 0,
        events: Arc::new(std::collections::VecDeque::new()),
        first_retained: 1,
    }));
    let cell = Arc::new(SessionHandleCell {
        id: id.clone(),
        actor: actor.clone(),
        lake: lake.clone(),
        root: Arc::new(root.to_path_buf()),
    });
    {
        let mut guard = actor.lock();
        guard.id = id.clone();
        guard.cell = Some(Arc::downgrade(&cell));
    }
    let handle = SessionHandle {
        id,
        actor,
        lake,
        root: Arc::new(root.to_path_buf()),
        cell: Some(cell),
    };
    {
        let mut guard = handle.actor.lock();
        handle.publish(&mut guard);
    }
    handle
}
