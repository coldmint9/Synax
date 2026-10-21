//! The process-wide store: one lock per root, one handle per session, and the
//! root-level session-list index.

pub mod list_index;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use arc_swap::ArcSwap;
use parking_lot::{Mutex, RwLock};

use super::error::{JsonlError, JsonlResult};

use super::record::{ListRecord, SnapshotCond};
use super::session::{load, Lake, SessionActor, SessionHandle, SessionHandleCell};
use crate::runtime::input_queue::QueueState;
use crate::runtime::session_types::ControlState;

pub use list_index::{ListIndex, ListKey};

/// The store root: created once, shared by every session handle.
pub struct Root {
    pub path: PathBuf,
    pub lock: crate::storage::jsonl::lock::StoreLock,
    pub sessions: RwLock<HashMap<String, SessionHandle>>,
    pub list: RwLock<ListIndex>,
}

#[derive(Clone)]
pub struct JsonlStore {
    root: Arc<Root>,
}

impl JsonlStore {
    pub fn open(path: impl AsRef<Path>) -> JsonlResult<Self> {
        let path = path.as_ref().to_path_buf();
        let lock = crate::storage::jsonl::lock::StoreLock::acquire(&path)?;
        let mut list = ListIndex::default();
        let sessions_dir = path.join(super::layout::SESSIONS_DIR);
        if sessions_dir.exists() {
            for shard in std::fs::read_dir(&sessions_dir)? {
                let shard = shard?;
                if !shard.path().is_dir() { continue; }
                for entry in std::fs::read_dir(shard.path())? {
                    let entry = entry?;
                    if !entry.path().is_dir() { continue; }
                    let id = entry.file_name().to_string_lossy().into_owned();
                    let loaded = load::load(&path, &id)?;
                    if !loaded.header.is_object() { continue; }
                    list.upsert(ListRecord { s: id, u: loaded.header["updatedAt"].as_str().unwrap_or_default().to_owned(), h: loaded.header, del: false });
                }
            }
        }
        tracing::info!(event = "storage.opened", "Runtime store opened");
        Ok(Self {
            root: Arc::new(Root {
                path,
                lock,
                sessions: RwLock::new(HashMap::new()),
                list: RwLock::new(list),
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
        if let Some(handle) = self.root.sessions.read().get(session_id) {
            return Ok(handle.clone());
        }
        let mut sessions = self.root.sessions.write();
        if let Some(handle) = sessions.get(session_id) {
            return Ok(handle.clone());
        }
        let started = std::time::Instant::now();
        let loaded = load::load(&self.root.path, session_id)?;
        tracing::debug!(event = "storage.session_loaded", session_id,
            duration_ms = started.elapsed().as_millis() as u64, "Session store loaded");
        let handle = build_handle(&self.root.path, session_id, loaded);
        sessions.insert(session_id.to_owned(), handle.clone());
        Ok(handle)
    }

    pub fn session_exists(&self, session_id: &str) -> bool {
        self.root.sessions.read().contains_key(session_id)
            || super::layout::session_dir(&self.root.path, session_id)
                .map(|dir| dir.is_dir())
                .unwrap_or(false)
    }

    /// Make every session's appended frames durable.
    pub fn flush(&self) -> JsonlResult<()> {
        let started = std::time::Instant::now();
        let handles: Vec<SessionHandle> = self.root.sessions.read().values().cloned().collect();
        for handle in handles {
            handle.actor.lock().sync().map_err(JsonlError::from)?;
        }
        tracing::info!(event = "storage.flushed", duration_ms = started.elapsed().as_millis() as u64,
            "Runtime store flushed");
        Ok(())
    }

    pub fn flush_session(&self, session_id: &str) -> JsonlResult<()> {
        if let Some(handle) = self.root.sessions.read().get(session_id).cloned() {
            handle.actor.lock().sync().map_err(JsonlError::from)?;
        }
        Ok(())
    }

    pub fn update_list(&self, row: ListRecord) -> JsonlResult<()> {
        self.root.list.write().upsert(row);
        Ok(())
    }

    /// Remove every session directory (test reset).
    pub fn reset_all(&self) -> JsonlResult<()> {
        self.root.sessions.write().clear();
        let sessions = self.root.path.join(super::layout::SESSIONS_DIR);
        if sessions.exists() {
            std::fs::remove_dir_all(&sessions).map_err(JsonlError::io)?;
        }
        self.root.list.write().clear();
        Ok(())
    }
}

/// A handle whose actor, lake and cell all point at each other.
pub fn build_handle(root: &Path, session_id: &str, loaded: load::Loaded) -> SessionHandle {
    let id = session_id.to_owned();
    let actor = Arc::new(Mutex::new(SessionActor::from_loaded(loaded, 128)));
    let lake = Arc::new(ArcSwap::from_pointee(Lake {
        state: SnapshotCond { epoch: 1, retained_from: 1, ..Default::default() },
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
        guard.cell = Some(cell.clone());
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


