use std::collections::{HashMap, VecDeque, hash_map::DefaultHasher};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use crate::storage::{HotStore, StorageError, append_fingerprint};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

const DEFAULT_EVENT_RETENTION: usize = 1024;
const DEFAULT_SUBSCRIBER_CAPACITY: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamEvent {
    pub sequence: u64,
    pub run_id: String,
    pub kind: String,
    pub payload: Vec<u8>,
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

#[derive(Debug)]
enum ActorCommand {
    AdmitRun {
        session_id: String,
        request_id: String,
        body_hash: String,
        run_id: String,
        epoch: u64,
        expected_revision: u64,
        response: oneshot::Sender<Result<CommandResult, RuntimeError>>,
    },
    ActivateRun {
        session_id: String,
        request_id: String,
        run_json: Vec<u8>,
        epoch: u64,
        revision: u64,
        response: oneshot::Sender<Result<CommandResult, RuntimeError>>,
    },
    FinishRun {
        session_id: String,
        request_id: String,
        run_id: String,
        status: String,
        run_json: Vec<u8>,
        epoch: u64,
        revision: u64,
        response: oneshot::Sender<Result<CommandResult, RuntimeError>>,
    },
    AppendStream {
        session_id: String,
        run_id: String,
        producer_id: String,
        producer_sequence: u64,
        epoch: u64,
        durability: Durability,
        events: Vec<PendingEvent>,
        response: oneshot::Sender<Result<CommandResult, RuntimeError>>,
    },
    UiSnapshot {
        session_id: String,
        seed: Option<Vec<u8>>,
        response: oneshot::Sender<Result<CommandResult, RuntimeError>>,
    },
    Snapshot {
        session_id: String,
        response: oneshot::Sender<Result<CommandResult, RuntimeError>>,
    },
    Replay {
        session_id: String,
        after: u64,
        response: oneshot::Sender<Result<CommandResult, RuntimeError>>,
    },
    Subscribe {
        session_id: String,
        after: u64,
        sender: mpsc::Sender<Arc<StreamEvent>>,
        response: oneshot::Sender<Result<(SessionSnapshot, Vec<StreamEvent>), RuntimeError>>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Receipt {
    body_hash: String,
    result: CommandResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum ReceiptKey {
    Admit(String),
    Finish(String),
    Append(String, u64, String, u64),
}

struct SessionState {
    session_id: String,
    epoch: u64,
    revision: u64,
    active_run_id: Option<String>,
    cursor: u64,
    retained_from: u64,
    events: VecDeque<StreamEvent>,
    receipts: HashMap<ReceiptKey, Receipt>,
    producer_sequences: HashMap<String, u64>,
    subscribers: Vec<mpsc::Sender<Arc<StreamEvent>>>,
    event_retention: usize,
}

impl SessionState {
    fn new(session_id: String, event_retention: usize) -> Self {
        Self {
            session_id,
            epoch: 1,
            revision: 0,
            active_run_id: None,
            cursor: 0,
            retained_from: 1,
            events: VecDeque::new(),
            receipts: HashMap::new(),
            producer_sequences: HashMap::new(),
            subscribers: Vec::new(),
            event_retention,
        }
    }

    fn from_snapshot(snapshot: SessionSnapshot, event_retention: usize) -> Self {
        Self {
            session_id: snapshot.session_id,
            epoch: snapshot.epoch,
            revision: snapshot.revision,
            active_run_id: snapshot.active_run_id,
            cursor: snapshot.cursor,
            retained_from: snapshot.retained_from,
            events: VecDeque::new(),
            receipts: HashMap::new(),
            producer_sequences: HashMap::new(),
            subscribers: Vec::new(),
            event_retention,
        }
    }

    fn sync_snapshot(&mut self, snapshot: &SessionSnapshot) {
        self.epoch = snapshot.epoch;
        self.revision = snapshot.revision;
        self.active_run_id = snapshot.active_run_id.clone();
        self.cursor = snapshot.cursor;
        self.retained_from = snapshot.retained_from;
    }

    fn publish_persisted_events(
        &mut self,
        receipt: &StreamAppendReceipt,
        run_id: &str,
        events: Vec<PendingEvent>,
    ) {
        self.cursor = receipt.last_sequence;
        self.retained_from = self.cursor.saturating_sub(self.event_retention as u64) + 1;
        let mut sequence = receipt.first_sequence;
        for pending in events {
            let event = StreamEvent {
                sequence,
                run_id: run_id.to_owned(),
                kind: pending.kind,
                payload: pending.payload,
            };
            let shared = Arc::new(event);
            self.subscribers
                .retain(|subscriber| matches!(subscriber.try_send(shared.clone()), Ok(())));
            sequence += 1;
        }
    }

    fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            session_id: self.session_id.clone(),
            epoch: self.epoch,
            revision: self.revision,
            active_run_id: self.active_run_id.clone(),
            cursor: self.cursor,
            retained_from: self.retained_from,
        }
    }

    fn ensure_epoch(&self, epoch: u64) -> Result<(), RuntimeError> {
        if epoch == self.epoch {
            Ok(())
        } else {
            Err(RuntimeError::StaleEpoch {
                expected: self.epoch,
                actual: epoch,
            })
        }
    }

    fn ensure_revision(&self, expected: u64) -> Result<(), RuntimeError> {
        if expected == self.revision {
            Ok(())
        } else {
            Err(RuntimeError::RevisionConflict {
                expected,
                actual: self.revision,
            })
        }
    }

    fn append_events(&mut self, run_id: &str, events: Vec<PendingEvent>) -> StreamAppendReceipt {
        let first_sequence = self.cursor + 1;
        for pending in events {
            self.cursor += 1;
            let event = StreamEvent {
                sequence: self.cursor,
                run_id: run_id.to_owned(),
                kind: pending.kind,
                payload: pending.payload,
            };
            self.events.push_back(event.clone());
            let shared = Arc::new(event);
            self.subscribers
                .retain(|subscriber| matches!(subscriber.try_send(shared.clone()), Ok(())));
        }
        while self.events.len() > self.event_retention {
            self.events.pop_front();
        }
        self.retained_from = self
            .events
            .front()
            .map(|event| event.sequence)
            .unwrap_or(self.cursor + 1);
        StreamAppendReceipt {
            reused: false,
            session_id: self.session_id.clone(),
            run_id: run_id.to_owned(),
            first_sequence,
            last_sequence: self.cursor,
            epoch: self.epoch,
        }
    }

    fn replay(&self, after: u64) -> Result<Vec<StreamEvent>, RuntimeError> {
        if after > 0 && after + 1 < self.retained_from {
            return Err(RuntimeError::CursorExpired {
                after,
                retained_from: self.retained_from,
            });
        }
        Ok(self
            .events
            .iter()
            .filter(|event| event.sequence > after)
            .cloned()
            .collect())
    }
}

pub struct SessionShardRouter {
    shards: Vec<mpsc::Sender<ActorCommand>>,
    subscriber_capacity: usize,
}

impl SessionShardRouter {
    pub fn new(shard_count: usize, mailbox_capacity: usize) -> Result<Self, RuntimeError> {
        Self::with_limits(
            shard_count,
            mailbox_capacity,
            DEFAULT_EVENT_RETENTION,
            DEFAULT_SUBSCRIBER_CAPACITY,
        )
    }

    pub fn with_limits(
        shard_count: usize,
        mailbox_capacity: usize,
        event_retention: usize,
        subscriber_capacity: usize,
    ) -> Result<Self, RuntimeError> {
        Self::with_limits_and_store(
            shard_count,
            mailbox_capacity,
            event_retention,
            subscriber_capacity,
            None,
        )
    }

    pub fn with_store(
        shard_count: usize,
        mailbox_capacity: usize,
        store: Arc<HotStore>,
    ) -> Result<Self, RuntimeError> {
        Self::with_limits_and_store(
            shard_count,
            mailbox_capacity,
            DEFAULT_EVENT_RETENTION,
            DEFAULT_SUBSCRIBER_CAPACITY,
            Some(store),
        )
    }

    fn with_limits_and_store(
        shard_count: usize,
        mailbox_capacity: usize,
        event_retention: usize,
        subscriber_capacity: usize,
        store: Option<Arc<HotStore>>,
    ) -> Result<Self, RuntimeError> {
        if shard_count == 0
            || mailbox_capacity == 0
            || event_retention == 0
            || subscriber_capacity == 0
        {
            return Err(RuntimeError::InvalidCommand(
                "all actor limits must be positive".to_owned(),
            ));
        }
        let mut shards = Vec::with_capacity(shard_count);
        for _ in 0..shard_count {
            let (sender, receiver) = mpsc::channel(mailbox_capacity);
            tokio::spawn(run_shard(receiver, event_retention, store.clone()));
            shards.push(sender);
        }
        Ok(Self {
            shards,
            subscriber_capacity,
        })
    }

    pub async fn admit_run(
        &self,
        session_id: impl Into<String>,
        request_id: impl Into<String>,
        body_hash: impl Into<String>,
        run_id: impl Into<String>,
        epoch: u64,
        expected_revision: u64,
    ) -> Result<RunAdmission, RuntimeError> {
        let session_id = session_id.into();
        let (response, receiver) = oneshot::channel();
        self.dispatch(
            &session_id,
            ActorCommand::AdmitRun {
                session_id: session_id.clone(),
                request_id: request_id.into(),
                body_hash: body_hash.into(),
                run_id: run_id.into(),
                epoch,
                expected_revision,
                response,
            },
        )?;
        match receiver.await.map_err(|_| RuntimeError::SessionClosed)?? {
            CommandResult::RunAdmission(admission) => Ok(admission),
            _ => Err(RuntimeError::InvalidCommand(
                "unexpected admission response".to_owned(),
            )),
        }
    }

    pub async fn activate_run(
        &self,
        session_id: String,
        request_id: String,
        run_json: Vec<u8>,
        epoch: u64,
        revision: u64,
    ) -> Result<SessionSnapshot, RuntimeError> {
        let (response, result) = oneshot::channel();
        self.dispatch(
            &session_id,
            ActorCommand::ActivateRun {
                session_id: session_id.clone(),
                request_id,
                run_json,
                epoch,
                revision,
                response,
            },
        )?;
        match result.await.map_err(|_| RuntimeError::SessionClosed)?? {
            CommandResult::Snapshot(snapshot) => Ok(snapshot),
            _ => Err(RuntimeError::InvalidCommand(
                "unexpected activation response".into(),
            )),
        }
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
        let session_id = session_id.into();
        let (response, receiver) = oneshot::channel();
        self.dispatch(
            &session_id,
            ActorCommand::FinishRun {
                session_id: session_id.clone(),
                request_id: request_id.into(),
                run_id: run_id.into(),
                status: status.into(),
                run_json,
                epoch,
                revision,
                response,
            },
        )?;
        match receiver.await.map_err(|_| RuntimeError::SessionClosed)?? {
            CommandResult::Snapshot(snapshot) => Ok(snapshot),
            _ => Err(RuntimeError::InvalidCommand(
                "unexpected completion response".into(),
            )),
        }
    }

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
        let session_id = session_id.into();
        let (response, receiver) = oneshot::channel();
        self.dispatch(
            &session_id,
            ActorCommand::AppendStream {
                session_id: session_id.clone(),
                run_id: run_id.into(),
                producer_id: producer_id.into(),
                producer_sequence,
                epoch,
                durability,
                events,
                response,
            },
        )?;
        match receiver.await.map_err(|_| RuntimeError::SessionClosed)?? {
            CommandResult::StreamAppend(receipt) => Ok(receipt),
            _ => Err(RuntimeError::InvalidCommand(
                "unexpected stream response".to_owned(),
            )),
        }
    }

    pub async fn ui_snapshot(
        &self,
        session_id: String,
        seed: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, RuntimeError> {
        let (response, result) = oneshot::channel();
        self.dispatch(
            &session_id,
            ActorCommand::UiSnapshot {
                session_id: session_id.clone(),
                seed,
                response,
            },
        )?;
        match result.await.map_err(|_| RuntimeError::SessionClosed)?? {
            CommandResult::UiSnapshot(bytes) => Ok(bytes),
            _ => Err(RuntimeError::InvalidCommand(
                "unexpected UI snapshot response".into(),
            )),
        }
    }

    pub async fn snapshot(
        &self,
        session_id: impl Into<String>,
    ) -> Result<SessionSnapshot, RuntimeError> {
        let session_id = session_id.into();
        let (response, receiver) = oneshot::channel();
        self.dispatch(
            &session_id,
            ActorCommand::Snapshot {
                session_id: session_id.clone(),
                response,
            },
        )?;
        match receiver.await.map_err(|_| RuntimeError::SessionClosed)?? {
            CommandResult::Snapshot(snapshot) => Ok(snapshot),
            _ => Err(RuntimeError::InvalidCommand(
                "unexpected snapshot response".to_owned(),
            )),
        }
    }

    pub async fn replay(
        &self,
        session_id: impl Into<String>,
        after: u64,
    ) -> Result<Vec<StreamEvent>, RuntimeError> {
        let session_id = session_id.into();
        let (response, receiver) = oneshot::channel();
        self.dispatch(
            &session_id,
            ActorCommand::Replay {
                session_id: session_id.clone(),
                after,
                response,
            },
        )?;
        match receiver.await.map_err(|_| RuntimeError::SessionClosed)?? {
            CommandResult::Replay(events) => Ok(events),
            _ => Err(RuntimeError::InvalidCommand(
                "unexpected replay response".to_owned(),
            )),
        }
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
        let session_id = session_id.into();
        let (sender, receiver) = mpsc::channel(self.subscriber_capacity);
        let (response, result) = oneshot::channel();
        self.dispatch(
            &session_id,
            ActorCommand::Subscribe {
                session_id: session_id.clone(),
                after,
                sender,
                response,
            },
        )?;
        let (snapshot, backlog) = result.await.map_err(|_| RuntimeError::SessionClosed)??;
        Ok((snapshot, backlog, receiver))
    }

    fn dispatch(&self, session_id: &str, command: ActorCommand) -> Result<(), RuntimeError> {
        let index = shard_index(session_id, self.shards.len());
        self.shards[index]
            .try_send(command)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => RuntimeError::Backpressure,
                mpsc::error::TrySendError::Closed(_) => RuntimeError::SessionClosed,
            })
    }
}

fn shard_index(session_id: &str, shard_count: usize) -> usize {
    let mut hasher = DefaultHasher::new();
    session_id.hash(&mut hasher);
    (hasher.finish() as usize) % shard_count
}

async fn run_shard(
    mut receiver: mpsc::Receiver<ActorCommand>,
    event_retention: usize,
    store: Option<Arc<HotStore>>,
) {
    let mut sessions: HashMap<String, SessionState> = HashMap::new();
    while let Some(command) = receiver.recv().await {
        match command {
            ActorCommand::AdmitRun {
                session_id,
                request_id,
                body_hash,
                run_id,
                epoch,
                expected_revision,
                response,
            } => {
                if let Err(error) = ensure_session_state(
                    &mut sessions,
                    &session_id,
                    event_retention,
                    store.as_ref(),
                )
                .await
                {
                    let _ = response.send(Err(error));
                    continue;
                }
                let result = if let Some(store) = store.as_ref() {
                    match store
                        .admit_run_async(
                            session_id.clone(),
                            request_id.clone(),
                            body_hash.clone(),
                            run_id.clone(),
                            epoch,
                            expected_revision,
                        )
                        .await
                    {
                        Ok(admission) => match store.snapshot_async(session_id.clone()).await {
                            Ok(snapshot) => {
                                sessions
                                    .get_mut(&session_id)
                                    .unwrap()
                                    .sync_snapshot(&snapshot);
                                Ok(admission)
                            }
                            Err(error) => {
                                if storage_state_uncertain(&error) {
                                    sessions.remove(&session_id);
                                }
                                Err(storage_error_to_runtime(error))
                            }
                        },
                        Err(error) => {
                            if storage_state_uncertain(&error) {
                                sessions.remove(&session_id);
                            }
                            Err(storage_error_to_runtime(error))
                        }
                    }
                } else {
                    admit_run(
                        sessions.get_mut(&session_id).unwrap(),
                        request_id,
                        body_hash,
                        run_id,
                        epoch,
                        expected_revision,
                    )
                };
                let _ = response.send(result.map(CommandResult::RunAdmission));
            }
            ActorCommand::ActivateRun {
                session_id,
                request_id,
                run_json,
                epoch,
                revision,
                response,
            } => {
                let result = if let Some(store) = store.as_ref() {
                    match ensure_session_state(
                        &mut sessions,
                        &session_id,
                        event_retention,
                        Some(store),
                    )
                    .await
                    {
                        Err(error) => Err(error),
                        Ok(()) => match store
                            .activate_run_async(
                                session_id.clone(),
                                request_id,
                                run_json,
                                epoch,
                                revision,
                            )
                            .await
                        {
                            Ok(receipt) => {
                                if !receipt.reused {
                                    let state = sessions.get_mut(&session_id).unwrap();
                                    state.sync_snapshot(&receipt.snapshot);
                                    let event = Arc::new(receipt.event);
                                    state.subscribers.retain(|subscriber| {
                                        subscriber.try_send(event.clone()).is_ok()
                                    });
                                }
                                Ok(receipt.snapshot)
                            }
                            Err(error) => {
                                if storage_state_uncertain(&error) {
                                    sessions.remove(&session_id);
                                }
                                Err(storage_error_to_runtime(error))
                            }
                        },
                    }
                } else {
                    Err(RuntimeError::StorageUnavailable(
                        "run activation requires RocksDB".into(),
                    ))
                };
                let _ = response.send(result.map(CommandResult::Snapshot));
            }
            ActorCommand::FinishRun {
                session_id,
                request_id,
                run_id,
                status,
                run_json,
                epoch,
                revision,
                response,
            } => {
                if let Err(error) = ensure_session_state(
                    &mut sessions,
                    &session_id,
                    event_retention,
                    store.as_ref(),
                )
                .await
                {
                    let _ = response.send(Err(error));
                    continue;
                }
                let result = if let Some(store) = store.as_ref() {
                    match store
                        .finish_run_async(
                            session_id.clone(),
                            request_id,
                            run_id,
                            status,
                            epoch,
                            revision,
                            run_json,
                        )
                        .await
                    {
                        Ok(receipt) => match store.snapshot_async(session_id.clone()).await {
                            Ok(current) => {
                                let state = sessions.get_mut(&session_id).unwrap();
                                state.sync_snapshot(&current);
                                if !receipt.reused {
                                    if let Some(event) = receipt.event {
                                        let shared = Arc::new(event);
                                        state.subscribers.retain(|subscriber| {
                                            subscriber.try_send(shared.clone()).is_ok()
                                        });
                                    }
                                }
                                Ok(receipt.snapshot)
                            }
                            Err(error) => {
                                if storage_state_uncertain(&error) {
                                    sessions.remove(&session_id);
                                }
                                Err(storage_error_to_runtime(error))
                            }
                        },
                        Err(error) => {
                            if storage_state_uncertain(&error) {
                                sessions.remove(&session_id);
                            }
                            Err(storage_error_to_runtime(error))
                        }
                    }
                } else {
                    finish_run(
                        sessions.get_mut(&session_id).unwrap(),
                        request_id,
                        run_id,
                        status,
                        epoch,
                        revision,
                        &run_json,
                    )
                };
                let _ = response.send(result.map(CommandResult::Snapshot));
            }
            ActorCommand::AppendStream {
                session_id,
                run_id,
                producer_id,
                producer_sequence,
                epoch,
                durability,
                events,
                response,
            } => {
                if let Err(error) = ensure_session_state(
                    &mut sessions,
                    &session_id,
                    event_retention,
                    store.as_ref(),
                )
                .await
                {
                    let _ = response.send(Err(error));
                    continue;
                }
                let result = if let Some(store) = store.as_ref() {
                    match store
                        .append_stream_async(
                            session_id.clone(),
                            run_id.clone(),
                            producer_id,
                            producer_sequence,
                            epoch,
                            durability,
                            events.clone(),
                        )
                        .await
                    {
                        Ok(receipt) => {
                            // Retry acknowledgements never publish a second copy of an event.
                            if !receipt.reused {
                                sessions
                                    .get_mut(&session_id)
                                    .unwrap()
                                    .publish_persisted_events(&receipt, &run_id, events);
                            }
                            Ok(receipt)
                        }
                        Err(error) => {
                            if storage_state_uncertain(&error) {
                                sessions.remove(&session_id);
                            }
                            Err(storage_error_to_runtime(error))
                        }
                    }
                } else {
                    append_stream(
                        sessions.get_mut(&session_id).unwrap(),
                        run_id,
                        producer_id,
                        producer_sequence,
                        epoch,
                        durability,
                        events,
                    )
                };
                let _ = response.send(result.map(CommandResult::StreamAppend));
            }
            ActorCommand::UiSnapshot {
                session_id,
                seed,
                response,
            } => {
                let result = match store.as_ref() {
                    Some(store) => store
                        .ui_snapshot_async(session_id, seed)
                        .await
                        .map_err(storage_error_to_runtime),
                    None => Err(RuntimeError::StorageUnavailable(
                        "UI projection requires persistent storage".into(),
                    )),
                };
                let _ = response.send(result.map(CommandResult::UiSnapshot));
            }
            ActorCommand::Snapshot {
                session_id,
                response,
            } => {
                if let Err(error) = ensure_session_state(
                    &mut sessions,
                    &session_id,
                    event_retention,
                    store.as_ref(),
                )
                .await
                {
                    let _ = response.send(Err(error));
                    continue;
                }
                let result = if let Some(store) = store.as_ref() {
                    match store.snapshot_async(session_id.clone()).await {
                        Ok(snapshot) => {
                            sessions
                                .get_mut(&session_id)
                                .unwrap()
                                .sync_snapshot(&snapshot);
                            Ok(snapshot)
                        }
                        Err(error) => {
                            if storage_state_uncertain(&error) {
                                sessions.remove(&session_id);
                            }
                            Err(storage_error_to_runtime(error))
                        }
                    }
                } else {
                    Ok(sessions.get(&session_id).unwrap().snapshot())
                };
                let _ = response.send(result.map(CommandResult::Snapshot));
            }
            ActorCommand::Replay {
                session_id,
                after,
                response,
            } => {
                if let Err(error) = ensure_session_state(
                    &mut sessions,
                    &session_id,
                    event_retention,
                    store.as_ref(),
                )
                .await
                {
                    let _ = response.send(Err(error));
                    continue;
                }
                let result = if let Some(store) = store.as_ref() {
                    store
                        .replay_async(session_id, after)
                        .await
                        .map_err(storage_error_to_runtime)
                } else {
                    sessions.get(&session_id).unwrap().replay(after)
                };
                let _ = response.send(result.map(CommandResult::Replay));
            }
            ActorCommand::Subscribe {
                session_id,
                after,
                sender,
                response,
            } => {
                if let Err(error) = ensure_session_state(
                    &mut sessions,
                    &session_id,
                    event_retention,
                    store.as_ref(),
                )
                .await
                {
                    let _ = response.send(Err(error));
                    continue;
                }
                let result = if let Some(store) = store.as_ref() {
                    store
                        .replay_bounded_async(
                            session_id.clone(),
                            after,
                            event_retention,
                            4 * 1024 * 1024,
                        )
                        .await
                        .map_err(storage_error_to_runtime)
                        .map(|events| (events, sessions.get(&session_id).unwrap().snapshot()))
                } else {
                    sessions
                        .get(&session_id)
                        .unwrap()
                        .replay(after)
                        .map(|events| (events, sessions.get(&session_id).unwrap().snapshot()))
                };
                let result = match result {
                    Ok((events, snapshot)) => {
                        if after > snapshot.cursor {
                            Err(RuntimeError::InvalidCommand(
                                "subscription cursor is ahead of session".into(),
                            ))
                        } else if after.saturating_add(1) < snapshot.retained_from {
                            Err(RuntimeError::CursorExpired {
                                after,
                                retained_from: snapshot.retained_from,
                            })
                        } else if events.last().map(|event| event.sequence).unwrap_or(after)
                            < snapshot.cursor
                        {
                            Err(RuntimeError::Backpressure)
                        } else if events
                            .iter()
                            .map(|event| event.payload.len())
                            .sum::<usize>()
                            > 4 * 1024 * 1024
                        {
                            Err(RuntimeError::Backpressure)
                        } else {
                            // The same actor turn captures the backlog and installs the live sender.
                            // Backlog never consumes the bounded live mailbox.
                            let subscribers =
                                &mut sessions.get_mut(&session_id).unwrap().subscribers;
                            subscribers.retain(|sender| !sender.is_closed());
                            subscribers.push(sender);
                            Ok((snapshot, events))
                        }
                    }
                    Err(error) => Err(error),
                };
                let _ = response.send(result);
            }
        }
    }
}

async fn ensure_session_state(
    sessions: &mut HashMap<String, SessionState>,
    session_id: &str,
    event_retention: usize,
    store: Option<&Arc<HotStore>>,
) -> Result<(), RuntimeError> {
    if sessions.contains_key(session_id) {
        return Ok(());
    }
    let state = if let Some(store) = store {
        let snapshot = store
            .snapshot_async(session_id.to_owned())
            .await
            .map_err(storage_error_to_runtime)?;
        SessionState::from_snapshot(snapshot, event_retention)
    } else {
        SessionState::new(session_id.to_owned(), event_retention)
    };
    sessions.insert(session_id.to_owned(), state);
    Ok(())
}

fn storage_state_uncertain(error: &StorageError) -> bool {
    !matches!(error, StorageError::Runtime(error) if !matches!(error, RuntimeError::DurabilityUnknown(_) | RuntimeError::StorageUnavailable(_)))
}

fn storage_error_to_runtime(error: StorageError) -> RuntimeError {
    match error {
        StorageError::Runtime(error) => error,
        StorageError::DiskFull => RuntimeError::DiskFull,
        other => RuntimeError::StorageUnavailable(other.to_string()),
    }
}

fn admit_run(
    state: &mut SessionState,
    request_id: String,
    body_hash: String,
    run_id: String,
    epoch: u64,
    expected_revision: u64,
) -> Result<RunAdmission, RuntimeError> {
    let request_key = ReceiptKey::Admit(request_id);
    if let Some(receipt) = state.receipts.get(&request_key) {
        if receipt.body_hash != body_hash {
            return Err(RuntimeError::RequestConflict);
        }
        if let CommandResult::RunAdmission(admission) = &receipt.result {
            let mut reused = admission.clone();
            reused.reused = true;
            return Ok(reused);
        }
        return Err(RuntimeError::InvalidCommand(
            "request receipt has an unexpected result".to_owned(),
        ));
    }
    state.ensure_epoch(epoch)?;
    state.ensure_revision(expected_revision)?;
    if state.active_run_id.is_some() {
        return Err(RuntimeError::SessionBusy);
    }
    state.revision += 1;
    state.active_run_id = Some(run_id.clone());
    let admission = RunAdmission {
        session_id: state.session_id.clone(),
        run_id,
        epoch: state.epoch,
        revision: state.revision,
        reused: false,
    };
    state.receipts.insert(
        request_key,
        Receipt {
            body_hash,
            result: CommandResult::RunAdmission(admission.clone()),
        },
    );
    Ok(admission)
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

fn finish_run(
    state: &mut SessionState,
    request_id: String,
    run_id: String,
    status: String,
    epoch: u64,
    revision: u64,
    run_json: &[u8],
) -> Result<SessionSnapshot, RuntimeError> {
    let document =
        crate::completion::decode_run_document(&state.session_id, &run_id, &status, run_json)?;
    let key = ReceiptKey::Finish(request_id);
    let identity = serde_json::to_string(&(&run_id, &status, &document)).unwrap();
    if let Some(receipt) = state.receipts.get(&key) {
        if receipt.body_hash != identity {
            return Err(RuntimeError::RequestConflict);
        }
        if let CommandResult::Snapshot(snapshot) = &receipt.result {
            return Ok(snapshot.clone());
        }
        return Err(RuntimeError::RequestConflict);
    }
    state.ensure_epoch(epoch)?;
    state.ensure_revision(revision)?;
    if state.active_run_id.as_deref() != Some(&run_id) {
        return Err(RuntimeError::InvalidCommand("run is not active".into()));
    }
    let completion =
        crate::completion::complete(&run_id, &status, document, serde_json::Value::Null)?;
    state.append_events(&run_id, vec![completion.event]);
    state.active_run_id = None;
    state.epoch += 1;
    state.revision += 1;
    state.producer_sequences.clear();
    let snapshot = state.snapshot();
    state.receipts.insert(
        key,
        Receipt {
            body_hash: identity,
            result: CommandResult::Snapshot(snapshot.clone()),
        },
    );
    Ok(snapshot)
}

fn append_stream(
    state: &mut SessionState,
    run_id: String,
    producer_id: String,
    producer_sequence: u64,
    epoch: u64,
    durability: Durability,
    events: Vec<PendingEvent>,
) -> Result<StreamAppendReceipt, RuntimeError> {
    let key = ReceiptKey::Append(
        run_id.clone(),
        epoch,
        producer_id.clone(),
        producer_sequence,
    );
    let fingerprint = append_fingerprint(
        &state.session_id,
        &run_id,
        &producer_id,
        producer_sequence,
        epoch,
        durability,
        &events,
    );
    if let Some(receipt) = state.receipts.get(&key) {
        if receipt.body_hash != fingerprint {
            return Err(RuntimeError::RequestConflict);
        }
        if let CommandResult::StreamAppend(saved) = &receipt.result {
            let mut reused = saved.clone();
            reused.reused = true;
            return Ok(reused);
        }
        return Err(RuntimeError::RequestConflict);
    }
    state.ensure_epoch(epoch)?;
    if state.active_run_id.as_deref() != Some(&run_id) {
        return Err(RuntimeError::InvalidCommand("run is not active".into()));
    }
    let expected = state
        .producer_sequences
        .get(&producer_id)
        .copied()
        .unwrap_or(0)
        + 1;
    if producer_sequence < expected {
        return Err(RuntimeError::ProducerSequenceReplay {
            expected,
            actual: producer_sequence,
        });
    }
    if producer_sequence > expected {
        return Err(RuntimeError::ProducerSequenceGap {
            expected,
            actual: producer_sequence,
        });
    }
    state
        .producer_sequences
        .insert(producer_id, producer_sequence);
    let receipt = state.append_events(&run_id, events);
    state.receipts.insert(
        key,
        Receipt {
            body_hash: fingerprint,
            result: CommandResult::StreamAppend(receipt.clone()),
        },
    );
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str) -> PendingEvent {
        PendingEvent {
            kind: kind.to_owned(),
            payload: kind.as_bytes().to_vec(),
        }
    }

    #[tokio::test]
    async fn replayed_receipts_cannot_reactivate_finished_run() {
        let path = std::env::temp_dir().join(format!("synax-receipt-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(HotStore::open(&path).unwrap());
        let router = SessionShardRouter::with_store(1, 16, store.clone()).unwrap();
        router
            .admit_run("s", "start1", "body1", "r1", 1, 0)
            .await
            .unwrap();
        router
            .finish_run("s", "finish1", "r1", "completed", 1, 1)
            .await
            .unwrap();
        router
            .admit_run("s", "start2", "body2", "r2", 2, 2)
            .await
            .unwrap();
        assert!(
            router
                .admit_run("s", "start1", "body1", "r1", 1, 0)
                .await
                .unwrap()
                .reused
        );
        router
            .finish_run("s", "finish1", "r1", "completed", 1, 1)
            .await
            .unwrap();
        let current = router.snapshot("s").await.unwrap();
        assert_eq!(current.active_run_id.as_deref(), Some("r2"));
        assert_eq!((current.epoch, current.revision), (2, 3));
        drop(router);
        tokio::task::yield_now().await;
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn backlog_is_separate_from_live_mailbox_and_has_no_boundary_gap() {
        let router = SessionShardRouter::with_limits(1, 16, 512, 4).unwrap();
        router
            .admit_run("s", "request", "body", "r", 1, 0)
            .await
            .unwrap();
        router
            .append_stream(
                "s",
                "r",
                "p",
                1,
                1,
                (0..200).map(|_| event("backlog")).collect(),
            )
            .await
            .unwrap();
        let (subscription, append) = tokio::join!(
            router.subscribe("s", 0),
            router.append_stream("s", "r", "p", 2, 1, vec![event("live")])
        );
        append.unwrap();
        let (snapshot, backlog, mut live) = subscription.unwrap();
        assert_eq!(snapshot.cursor, 200);
        assert_eq!(backlog.len(), 200);
        assert_eq!(live.recv().await.unwrap().sequence, 201);
        assert!(live.try_recv().is_err());
    }

    #[tokio::test]
    async fn duplicate_append_is_not_republished_and_changed_payload_is_rejected() {
        let router = SessionShardRouter::new(1, 16).unwrap();
        router
            .admit_run("s", "start", "body", "r", 1, 0)
            .await
            .unwrap();
        let (_, _, mut live) = router.subscribe("s", 0).await.unwrap();
        router
            .append_stream("s", "r", "p", 1, 1, vec![event("one")])
            .await
            .unwrap();
        assert_eq!(live.recv().await.unwrap().sequence, 1);
        let retried = router
            .append_stream("s", "r", "p", 1, 1, vec![event("one")])
            .await
            .unwrap();
        assert!(retried.reused);
        assert!(live.try_recv().is_err());
        assert!(matches!(
            router
                .append_stream("s", "r", "p", 1, 1, vec![event("other")])
                .await,
            Err(RuntimeError::RequestConflict)
        ));
        assert_eq!(router.snapshot("s").await.unwrap().cursor, 1);
    }

    #[tokio::test]
    async fn finish_publishes_once_and_retry_after_next_admission_does_not_revert_cache() {
        for persistent in [false, true] {
            let path =
                std::env::temp_dir().join(format!("synax-live-finish-{}", uuid::Uuid::new_v4()));
            let store = if persistent {
                Some(Arc::new(HotStore::open(&path).unwrap()))
            } else {
                None
            };
            let router = if let Some(store) = &store {
                SessionShardRouter::with_store(1, 16, store.clone()).unwrap()
            } else {
                SessionShardRouter::new(1, 16).unwrap()
            };
            router
                .admit_run("s", "start", "hash", "r", 1, 0)
                .await
                .unwrap();
            let (_, _, mut live) = router.subscribe("s", 0).await.unwrap();
            let first = router
                .finish_run("s", "finish", "r", "failed", 1, 1)
                .await
                .unwrap();
            let event = tokio::time::timeout(std::time::Duration::from_secs(1), live.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(event.sequence, first.cursor);
            assert_eq!(event.kind, "run_finished");
            router
                .admit_run("s", "next", "hash2", "next", 2, 2)
                .await
                .unwrap();
            assert_eq!(
                router
                    .finish_run("s", "finish", "r", "failed", 1, 1)
                    .await
                    .unwrap(),
                first
            );
            assert!(matches!(
                live.try_recv(),
                Err(mpsc::error::TryRecvError::Empty)
            ));
            assert_eq!(
                router.snapshot("s").await.unwrap().active_run_id.as_deref(),
                Some("next")
            );
            drop(router);
            tokio::task::yield_now().await;
            drop(store);
            let _ = std::fs::remove_dir_all(path);
        }
    }

    #[tokio::test]
    async fn router_rejects_invalid_limits() {
        assert!(matches!(
            SessionShardRouter::new(0, 1),
            Err(RuntimeError::InvalidCommand(_))
        ));
    }

    #[tokio::test]
    async fn admits_idempotently_and_rejects_conflicting_request_body() {
        let router = SessionShardRouter::new(2, 16).unwrap();
        let first = router
            .admit_run("session-a", "request-a", "body-a", "run-a", 1, 0)
            .await
            .unwrap();
        assert!(!first.reused);
        assert_eq!(first.revision, 1);

        let reused = router
            .admit_run("session-a", "request-a", "body-a", "run-new", 99, 99)
            .await
            .unwrap();
        assert!(reused.reused);
        assert_eq!(reused.run_id, "run-a");
        assert!(matches!(
            router
                .admit_run("session-a", "request-a", "body-b", "run-b", 1, 1)
                .await,
            Err(RuntimeError::RequestConflict)
        ));
    }

    #[tokio::test]
    async fn fences_epoch_revision_and_busy_sessions() {
        let router = SessionShardRouter::new(1, 16).unwrap();
        router
            .admit_run("session-a", "request-a", "body-a", "run-a", 1, 0)
            .await
            .unwrap();
        assert!(matches!(
            router
                .admit_run("session-a", "request-b", "body-b", "run-b", 2, 1)
                .await,
            Err(RuntimeError::StaleEpoch { .. })
        ));
        assert!(matches!(
            router
                .admit_run("session-a", "request-b", "body-b", "run-b", 1, 1)
                .await,
            Err(RuntimeError::SessionBusy)
        ));
    }

    #[tokio::test]
    async fn rejects_revision_conflicts_before_busy_state() {
        let router = SessionShardRouter::new(1, 16).unwrap();
        router
            .admit_run("session-a", "request-a", "body-a", "run-a", 1, 0)
            .await
            .unwrap();
        assert!(matches!(
            router
                .admit_run("session-a", "request-b", "body-b", "run-b", 1, 0)
                .await,
            Err(RuntimeError::RevisionConflict {
                expected: 0,
                actual: 1
            })
        ));
    }

    #[tokio::test]
    async fn slow_subscriber_is_dropped_without_blocking_other_sessions() {
        let router = SessionShardRouter::with_limits(2, 16, 8, 1).unwrap();
        router
            .admit_run("slow-session", "start", "body", "run-slow", 1, 0)
            .await
            .unwrap();
        let (_, _, _slow_receiver) = router.subscribe("slow-session", 0).await.unwrap();
        router
            .append_stream(
                "slow-session",
                "run-slow",
                "producer-slow",
                1,
                1,
                vec![event("first")],
            )
            .await
            .unwrap();
        router
            .append_stream(
                "slow-session",
                "run-slow",
                "producer-slow",
                2,
                1,
                vec![event("second")],
            )
            .await
            .unwrap();
        let fast = router.snapshot("fast-session").await.unwrap();
        assert_eq!(fast.session_id, "fast-session");
        assert_eq!(fast.cursor, 0);
    }

    #[tokio::test]
    async fn appends_replays_and_subscribes_without_losing_order() {
        let router = SessionShardRouter::with_limits(1, 16, 3, 4).unwrap();
        router
            .admit_run("session-a", "start", "body", "run-a", 1, 0)
            .await
            .unwrap();
        let (snapshot, _, mut receiver) = router.subscribe("session-a", 0).await.unwrap();
        assert_eq!(snapshot.cursor, 0);
        router
            .append_stream(
                "session-a",
                "run-a",
                "producer-a",
                1,
                1,
                vec![event("one"), event("two")],
            )
            .await
            .unwrap();
        let first = receiver.recv().await.unwrap();
        let second = receiver.recv().await.unwrap();
        assert_eq!((first.sequence, second.sequence), (1, 2));

        let replay = router.replay("session-a", 0).await.unwrap();
        assert_eq!(
            replay.iter().map(|item| item.sequence).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(matches!(
            router
                .append_stream("session-a", "run-a", "producer-a", 3, 1, vec![event("gap")])
                .await,
            Err(RuntimeError::ProducerSequenceGap {
                expected: 2,
                actual: 3
            })
        ));
        router
            .append_stream(
                "session-a",
                "run-a",
                "producer-a",
                2,
                1,
                vec![event("three")],
            )
            .await
            .unwrap();
        assert_eq!(router.snapshot("session-a").await.unwrap().cursor, 3);
    }

    #[tokio::test]
    async fn bounded_mailbox_returns_backpressure() {
        let router = SessionShardRouter::with_limits(1, 1, 8, 1).unwrap();
        let first = router.snapshot("session-a");
        let second = router.snapshot("session-a");
        let first_result = first.await;
        let second_result = second.await;
        assert!(first_result.is_ok() || second_result.is_ok());
        assert!(first_result.is_ok() || matches!(second_result, Err(RuntimeError::Backpressure)));
    }

    #[tokio::test]
    async fn cursor_expires_after_retention_window() {
        let router = SessionShardRouter::with_limits(1, 32, 2, 2).unwrap();
        router
            .admit_run("session-a", "start", "body", "run-a", 1, 0)
            .await
            .unwrap();
        for sequence in 1..=3 {
            router
                .append_stream(
                    "session-a",
                    "run-a",
                    "producer-a",
                    sequence,
                    1,
                    vec![event("x")],
                )
                .await
                .unwrap();
        }
        assert!(matches!(
            router.replay("session-a", 0).await,
            Ok(events) if events.len() == 2
        ));
        assert!(matches!(
            router.replay("session-a", 1).await,
            Ok(events) if events.len() == 2
        ));
    }
}
