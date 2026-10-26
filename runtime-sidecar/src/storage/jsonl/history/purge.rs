//! Physical session removal, fenced against late runtime/history writers.
use super::*;
use std::fs;

fn remove_directory(path: &std::path::Path) -> Result<(), HistoryError> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

impl HistoryTask {
    pub(super) fn purge_session(&self, id: &str) -> Result<Vec<u8>, HistoryError> {
        let directory = layout::session_dir(self.root(), id).map_err(convert_io)?;
        let marker = layout::deletion_marker(self.root(), id);
        if marker.try_exists()? {
            // A previous delete may have committed its fence before losing
            // the acknowledgement or being interrupted during disk cleanup.
            if let Some(history) = self.sessions.peek(id) {
                let _checkpoint = history.checkpoint_lock.lock();
                let mut writer = history.lock.lock();
                writer.failed = true;
                writer.index = SessionIndex::empty(id);
                history.published.store(Arc::new(writer.index.clone()));
                history.encoded_values.lock().clear();
            }
            remove_directory(&directory)?;
            self.store.forget_deleted_session(id).map_err(convert_io)?;
            self.sessions.remove(id);
            return serialized(&serde_json::json!({"deleted":true}));
        }
        let handle = self.store.session(id).map_err(convert_io)?;
        let history = self.session(id)?;
        let _hot_checkpoint = handle.cell().checkpoint_lock.lock();
        let mut actor = handle.actor.lock();
        if actor.state.active_run_id.is_some()
            || actor.control.execution_lease.as_ref().is_some_and(|lease| !lease.closed) {
            return Err(HistoryError::InvalidCommand("Stop the session before permanently deleting it".into()));
        }
        let _history_checkpoint = history.checkpoint_lock.lock();
        let mut writer = history.lock.lock();
        let parent = marker.parent().expect("deletion marker parent");
        fs::create_dir_all(parent)?;
        fs::File::create(&marker)?.sync_all()?;
        fs::File::open(parent)?.sync_all()?;
        // Suppress checkpoints on retained handles and erase their cached
        // payloads. All future opens/writes reject the durable marker.
        writer.failed = true;
        writer.index = SessionIndex::empty(id);
        history.published.store(Arc::new(writer.index.clone()));
        history.encoded_values.lock().clear();
        actor.header = serde_json::Value::Null.into();
        actor.projection = None;
        actor.events.clear();
        actor.receipts.clear();
        actor.subscribers.clear();
        handle.publish(&mut actor);
        remove_directory(&directory)?;
        fs::File::open(directory.parent().expect("session shard"))?.sync_all()?;
        self.store.forget_deleted_session(id).map_err(convert_io)?;
        self.sessions.remove(id);
        serialized(&serde_json::json!({"deleted":true}))
    }
}
