use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::mpsc;

use crate::storage::jsonl::hot::HotOps;

const DEFAULT_EVENT_RETENTION: usize = 1024;
const DEFAULT_SUBSCRIBER_CAPACITY: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamEvent {
    pub sequence: u64,
    pub run_id: String,
    pub kind: String,
    pub payload: Vec<u8>,
    #[serde(default)]
    pub ephemeral: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub session_id: String,
    pub epoch: u64,
    pub revision: u64,
    pub active_run_id: Option<String>,
    pub cursor: u64,
    pub retained_from: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunAdmission {
    pub session_id: String,
    pub run_id: String,
    pub epoch: u64,
    pub revision: u64,
    pub reused: bool,
    #[serde(default)]
    pub queue_event: Option<StreamEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamAppendReceipt {
    #[serde(default)]
    pub reused: bool,
    pub session_id: String,
    pub run_id: String,
    pub first_sequence: u64,
    pub last_sequence: u64,
    pub epoch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlCommandReceipt {
    pub state_json: Vec<u8>,
    pub snapshot: SessionSnapshot,
    pub event: Option<StreamEvent>,
    pub reused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RuntimeError {
    #[error("session UI projection has not been initialized")]
    ProjectionMissing,
    #[error("UI projection exceeds transport budget; content externalization required")]
    ProjectionTooLarge,
    #[error("session has existing events or runs and requires offline projection migration")]
    ProjectionMigrationRequired,
    #[error("storage disk full")]
    DiskFull,
    #[error("durability could not be confirmed: {0}")]
    DurabilityUnknown(String),
    #[error("storage unavailable: {0}")]
    StorageUnavailable(String),
    #[error("actor mailbox or subscriber is full")]
    Backpressure,
    #[error("session actor is unavailable")]
    SessionClosed,
    #[error("request id was reused with different input")]
    RequestConflict,
    #[error("session epoch is stale: expected {expected}, actual {actual}")]
    StaleEpoch { expected: u64, actual: u64 },
    #[error("session revision is stale: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("session already has an active run")]
    SessionBusy,
    #[error("{0}")]
    ExecutionSuperseded(String),
    #[error("producer sequence was already seen: expected {expected}, actual {actual}")]
    ProducerSequenceReplay { expected: u64, actual: u64 },
    #[error("producer sequence has a gap: expected {expected}, actual {actual}")]
    ProducerSequenceGap { expected: u64, actual: u64 },
    #[error("replay cursor expired: after {after}, retained from {retained_from}")]
    CursorExpired { after: u64, retained_from: u64 },
    #[error("invalid command: {0}")]
    InvalidCommand(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandResult {
    RunAdmission(RunAdmission),
    StreamAppend(StreamAppendReceipt),
    Snapshot(SessionSnapshot),
    Replay(Vec<StreamEvent>),
    UiSnapshot(Vec<u8>),
    QueueState(Vec<u8>),
    ControlState(ControlCommandReceipt),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingEvent {
    pub kind: String,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Durability {
    Sync,
    GroupCommit,
    Ephemeral,
}
pub fn validate_terminal_status(status: &str) -> Result<(), RuntimeError> {
    if matches!(
        status,
        "completed" | "failed" | "cancelled" | "interrupted" | "blocked"
    ) {
        Ok(())
    } else {
        Err(RuntimeError::InvalidCommand(
            "invalid terminal run status".into(),
        ))
    }
}
const SNAPSHOT_REPLAY_EVENTS: usize = 4096;
const SNAPSHOT_REPLAY_BYTES: usize = 4 * 1024 * 1024;
const SUBSCRIBER_CAPACITY: usize = 128;

/// The facade the transport calls. The store serializes every session itself,
/// so this holds no per-session state; it only bridges the sync store API to
/// the async callers and awaits durability.
pub struct SessionShardRouter {
    store: Option<Arc<HotOps>>,
    subscriber_capacity: usize,
}

impl SessionShardRouter {
    pub fn new(shard_count: usize, mailbox_capacity: usize) -> Result<Self, RuntimeError> {
        let _ = (shard_count, mailbox_capacity);
        Ok(Self {
            store: None,
            subscriber_capacity: SUBSCRIBER_CAPACITY,
        })
    }

    pub fn with_store(
        _shard_count: usize,
        _mailbox_capacity: usize,
        store: Arc<HotOps>,
    ) -> Result<Self, RuntimeError> {
        Ok(Self {
            store: Some(store),
            subscriber_capacity: SUBSCRIBER_CAPACITY,
        })
    }

    fn store(&self) -> Result<&Arc<HotOps>, RuntimeError> {
        self.store
            .as_ref()
            .ok_or_else(|| RuntimeError::StorageUnavailable("storage required".to_owned()))
    }

    #[cfg(test)]
    pub async fn admit_run(
        &self,
        session_id: impl Into<String>,
        request_id: impl Into<String>,
        body_hash: impl Into<String>,
        run_id: impl Into<String>,
        epoch: u64,
        revision: u64,
    ) -> Result<RunAdmission, RuntimeError> {
        self.admit_run_with_queue(
            session_id,
            request_id,
            body_hash,
            run_id,
            epoch,
            revision,
            Vec::new(),
        )
        .await
    }

    #[cfg(test)]
    pub async fn admit_run_with_queue(
        &self,
        session_id: impl Into<String>,
        request_id: impl Into<String>,
        body_hash: impl Into<String>,
        run_id: impl Into<String>,
        epoch: u64,
        expected_revision: u64,
        queue_item: Vec<u8>,
    ) -> Result<RunAdmission, RuntimeError> {
        self.admit_run_with_document(
            session_id,
            request_id,
            body_hash,
            run_id,
            epoch,
            expected_revision,
            queue_item,
            Vec::new(),
        )
        .await
    }

    pub async fn admit_run_with_document(
        &self,
        session_id: impl Into<String>,
        request_id: impl Into<String>,
        body_hash: impl Into<String>,
        run_id: impl Into<String>,
        epoch: u64,
        expected_revision: u64,
        queue_item: Vec<u8>,
        run_json: Vec<u8>,
    ) -> Result<RunAdmission, RuntimeError> {
        let hot = self.store()?.clone();
        let (session_id, request_id, body_hash, run_id) = (
            session_id.into(),
            request_id.into(),
            body_hash.into(),
            run_id.into(),
        );
        let durable_session = session_id.clone();
        let admission = spawn_store(move || {
            hot.admit_run(
                &session_id,
                &request_id,
                &body_hash,
                &run_id,
                epoch,
                expected_revision,
                &queue_item,
                &run_json,
            )
        })
        .await?;
        if !admission.reused {
            self.make_durable(Durability::Sync, &durable_session)
                .await?;
        }
        Ok(admission)
    }

    pub async fn activate_run(
        &self,
        session_id: String,
        request_id: String,
        run_json: Vec<u8>,
        epoch: u64,
        revision: u64,
    ) -> Result<SessionSnapshot, RuntimeError> {
        let hot = self.store()?.clone();
        let durable_session = session_id.clone();
        let receipt = spawn_store(move || {
            hot.activate_run(&session_id, &request_id, &run_json, epoch, revision)
        })
        .await?;
        // A retry after a failed sync must cross the barrier as well.
        self.make_durable(Durability::Sync, &durable_session)
            .await?;
        Ok(receipt.snapshot)
    }

    #[cfg(test)]
    pub async fn finish_run(
        &self,
        session_id: impl Into<String>,
        request_id: impl Into<String>,
        run_id: impl Into<String>,
        status: impl Into<String>,
        epoch: u64,
        revision: u64,
    ) -> Result<SessionSnapshot, RuntimeError> {
        self.finish_run_with_document(
            session_id,
            request_id,
            run_id,
            status,
            epoch,
            revision,
            Vec::new(),
        )
        .await
    }

    pub async fn finish_run_with_document(
        &self,
        session_id: impl Into<String>,
        request_id: impl Into<String>,
        run_id: impl Into<String>,
        status: impl Into<String>,
        epoch: u64,
        revision: u64,
        run_json: Vec<u8>,
    ) -> Result<SessionSnapshot, RuntimeError> {
        let hot = self.store()?.clone();
        let (session_id, request_id, run_id, status) = (
            session_id.into(),
            request_id.into(),
            run_id.into(),
            status.into(),
        );
        let durable_session = session_id.clone();
        let receipt = spawn_store(move || {
            hot.finish_run(
                &session_id,
                &request_id,
                &run_id,
                &status,
                epoch,
                revision,
                &run_json,
            )
        })
        .await?;
        // A retry after a failed sync must cross the barrier as well.
        self.make_durable(Durability::Sync, &durable_session)
            .await?;
        Ok(receipt.snapshot)
    }

    #[cfg(test)]
    pub async fn append_stream(
        &self,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        producer_id: impl Into<String>,
        producer_sequence: u64,
        epoch: u64,
        events: Vec<PendingEvent>,
    ) -> Result<StreamAppendReceipt, RuntimeError> {
        self.append_stream_with_durability(
            session_id,
            run_id,
            producer_id,
            producer_sequence,
            epoch,
            Durability::Sync,
            events,
        )
        .await
    }

    pub async fn append_stream_with_durability(
        &self,
        session_id: impl Into<String>,
        run_id: impl Into<String>,
        producer_id: impl Into<String>,
        producer_sequence: u64,
        epoch: u64,
        durability: Durability,
        events: Vec<PendingEvent>,
    ) -> Result<StreamAppendReceipt, RuntimeError> {
        if events.is_empty() {
            return Err(RuntimeError::InvalidCommand(
                "stream batch cannot be empty".to_owned(),
            ));
        }
        let hot = self.store()?.clone();
        let session_id = session_id.into();
        let run_id = run_id.into();
        let producer_id = producer_id.into();
        let durable_session = session_id.clone();
        if matches!(durability, Durability::Ephemeral) {
            // Ephemeral frames never touch storage: fan them out straight to
            // the live subscribers of the session.
            let handle = spawn_store({
                let hot = hot.clone();
                let session_id = session_id.clone();
                move || hot.handle(&session_id)
            })
            .await?;
            let mut actor = handle.actor.lock();
            let epoch_now = actor.state.epoch;
            for pending in events {
                let shared = Arc::new(StreamEvent {
                    sequence: 0,
                    run_id: run_id.clone(),
                    kind: pending.kind,
                    payload: pending.payload,
                    ephemeral: true,
                });
                actor.subscribers.retain(|subscriber| {
                    !subscriber.is_closed() && subscriber.try_send(shared.clone()).is_ok()
                });
            }
            return Ok(StreamAppendReceipt {
                reused: false,
                session_id,
                run_id,
                first_sequence: 0,
                last_sequence: 0,
                epoch: epoch_now,
            });
        }
        let receipt = spawn_store(move || {
            hot.append_stream(
                &session_id,
                &run_id,
                &producer_id,
                producer_sequence,
                epoch,
                durability,
                events,
            )
        })
        .await?;
        self.make_durable(durability, &durable_session).await?;
        Ok(receipt)
    }

    pub async fn ui_snapshot(
        &self,
        session_id: String,
        seed: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, RuntimeError> {
        let hot = self.store()?.clone();
        spawn_store(move || hot.ui_snapshot(&session_id, seed.as_deref())).await
    }

    pub async fn queue_read(&self, session_id: String) -> Result<Vec<u8>, RuntimeError> {
        let hot = self.store()?.clone();
        spawn_store(move || hot.queue_read(&session_id)).await
    }

    pub async fn queue_mutation(
        &self,
        session_id: String,
        request_id: String,
        epoch: u64,
        revision: u64,
        operation: String,
        payload: Vec<u8>,
    ) -> Result<Vec<u8>, RuntimeError> {
        let hot = self.store()?.clone();
        let durable_session = session_id.clone();
        let receipt = spawn_store(move || {
            hot.queue_mutation(
                &session_id,
                &request_id,
                epoch,
                revision,
                &operation,
                &payload,
            )
        })
        .await?;
        // A retry after a failed sync must cross the barrier as well.
        self.make_durable(Durability::Sync, &durable_session)
            .await?;
        serde_json::to_vec(&receipt.queue)
            .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))
    }

    pub async fn control_command(
        &self,
        session_id: String,
        request_id: String,
        epoch: u64,
        revision: u64,
        operation: String,
        payload: Vec<u8>,
    ) -> Result<ControlCommandReceipt, RuntimeError> {
        let hot = self.store()?.clone();
        let durable_session = session_id.clone();
        let receipt = spawn_store(move || {
            hot.control(
                &session_id,
                &request_id,
                epoch,
                revision,
                &operation,
                &payload,
            )
        })
        .await?;
        // A retry after a failed sync must cross the barrier as well.
        self.make_durable(Durability::Sync, &durable_session)
            .await?;
        Ok(receipt)
    }

    pub async fn snapshot(
        &self,
        session_id: impl Into<String>,
    ) -> Result<SessionSnapshot, RuntimeError> {
        let hot = self.store()?.clone();
        let session_id = session_id.into();
        spawn_store(move || hot.snapshot(&session_id)).await
    }

    pub async fn replay(
        &self,
        session_id: impl Into<String>,
        after: u64,
    ) -> Result<Vec<StreamEvent>, RuntimeError> {
        let hot = self.store()?.clone();
        let session_id = session_id.into();
        spawn_store(move || {
            hot.replay(
                &session_id,
                after,
                SNAPSHOT_REPLAY_EVENTS,
                SNAPSHOT_REPLAY_BYTES,
            )
        })
        .await
    }

    pub async fn subscribe(
        &self,
        session_id: impl Into<String>,
        after: u64,
    ) -> Result<
        (
            SessionSnapshot,
            Vec<StreamEvent>,
            mpsc::Receiver<Arc<StreamEvent>>,
        ),
        RuntimeError,
    > {
        let hot = self.store()?.clone();
        let session_id = session_id.into();
        let capacity = self.subscriber_capacity;
        spawn_store(move || hot.subscribe(&session_id, after, capacity)).await
    }

    /// Await durability for the operation that just committed.
    async fn make_durable(
        &self,
        durability: Durability,
        session_id: &str,
    ) -> Result<(), RuntimeError> {
        match durability {
            Durability::Sync => {
                let hot = self.store()?.clone();
                let session_id = session_id.to_owned();
                spawn_store(move || hot.flush_session(&session_id).map_err(RuntimeError::from))
                    .await
            }
            Durability::GroupCommit => {
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                let hot = self.store()?.clone();
                let session_id = session_id.to_owned();
                spawn_store(move || hot.flush_session(&session_id).map_err(RuntimeError::from))
                    .await
            }
            Durability::Ephemeral => Ok(()),
        }
    }
}

/// Run one synchronous store operation off the async executor.
async fn spawn_store<T, F>(operation: F) -> Result<T, RuntimeError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, RuntimeError> + Send + 'static,
{
    let span = tracing::Span::current();
    tokio::task::spawn_blocking(move || span.in_scope(operation))
        .await
        .map_err(|_| RuntimeError::SessionClosed)?
}
