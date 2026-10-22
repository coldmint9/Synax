//! Durable sync for one session.
//!
//! Writers append into the page cache and answer `GroupCommit` immediately
//! after the seal is written. One background thread per root fsyncs the
//! handles that are waiting, so a slow disk never holds the actor lock.

use std::sync::Arc;

use tokio::sync::{mpsc, oneshot};

use super::SessionHandle;

/// A request to make the session's appended frames durable.
pub struct SyncRequest {
    pub handle: SessionHandle,
    pub done: oneshot::Sender<Result<(), String>>,
}

/// Make every file of `handle` durable on the calling (blocking) thread.
pub fn sync_session(handle: &SessionHandle) {
    let files = {
        let actor = handle.actor.lock();
        [
            actor.files.controls.handle(),
            actor.files.events.handle(),
            actor.files.seals.handle(),
        ]
    };
    super::super::file::sync_files(&files).expect("fsync is fatal");
}

/// A best-effort signal that a session has frames waiting.
pub async fn wait_durable(
    requests: &mpsc::Sender<SyncRequest>,
    handle: &SessionHandle,
) -> Result<(), String> {
    let (done, wait) = oneshot::channel();
    requests
        .send(SyncRequest {
            handle: handle.clone(),
            done,
        })
        .await
        .map_err(|_| "storage sync thread has stopped".to_owned())?;
    wait.await
        .map_err(|_| "storage sync thread has stopped".to_owned())?
}

pub type SyncSender = Arc<mpsc::Sender<SyncRequest>>;
