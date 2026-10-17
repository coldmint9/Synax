use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use moka::future::Cache;
use rocksdb::{ColumnFamilyDescriptor, DB, Options, WriteBatch};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::actor::{
    Durability, PendingEvent, RunAdmission, RuntimeError, SessionSnapshot, StreamAppendReceipt,
    StreamEvent,
};
use crate::commit::Committer;
use crate::projection::UiSnapshot;

const CF_ACTIVATIONS: &str = "run_activations";
const CF_CONTROLS: &str = "control_receipts";
const CF_UI: &str = "ui_projections";
const CF_SESSIONS: &str = "sessions";
const CF_RUNS: &str = "runs";
const CF_RECEIPTS: &str = "receipts";
const CF_STREAMS: &str = "streams";
const CF_APPENDS: &str = "append_receipts";
const CF_TRANSITIONS: &str = "transitions";
const CF_HISTORY_OUTBOX: &str = "history_outbox";
const SNAPSHOT_CACHE_CAPACITY: u64 = 4096;
const EVENT_RETENTION: u64 = 1024;
const HISTORY_OUTBOX_MAINTENANCE_BATCH: usize = 256;

#[derive(Debug, Clone, Default)]
pub struct HistoryOutboxSessionPage {
    pub session_ids: Vec<String>,
    pub next_key: Option<String>,
}

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("rocksdb: {0}")]
    Rocks(#[from] rocksdb::Error),
    #[error("serialization: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
    #[error("missing column family: {0}")]
    MissingColumnFamily(String),
    #[error("storage disk full")]
    DiskFull,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSession {
    session_id: String,
    epoch: u64,
    revision: u64,
    active_run_id: Option<String>,
    cursor: u64,
    retained_from: u64,
    producer_sequences: HashMap<String, u64>,
}

impl StoredSession {
    fn new(session_id: String) -> Self {
        Self {
            session_id,
            epoch: 1,
            revision: 0,
            active_run_id: None,
            cursor: 0,
            retained_from: 1,
            producer_sequences: HashMap::new(),
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredReceipt {
    body_hash: String,
    admission: RunAdmission,
    #[serde(default)]
    queue_item: Option<serde_json::Value>,
    #[serde(default)]
    run_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredRun {
    #[serde(default)]
    activation_request: Option<String>,
    #[serde(default)]
    document: Option<serde_json::Value>,
    #[serde(default)]
    terminal_status: Option<String>,
    run_id: String,
    session_id: String,
    epoch: u64,
    revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivationReceipt {
    pub snapshot: SessionSnapshot,
    pub event: StreamEvent,
    #[serde(default)]
    pub reused: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredActivation {
    identity: String,
    result: ActivationReceipt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinishReceipt {
    pub snapshot: SessionSnapshot,
    pub event: Option<StreamEvent>,
    #[serde(default)]
    pub reused: bool,
}

/// Result of one bounded history-outbox maintenance pass.
///
/// Only entries at or below the durable acknowledgement watermark are eligible
/// for removal.  An unacknowledged event is never removed by maintenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryOutboxMaintenance {
    pub acked_through: u64,
    pub removed: usize,
    pub has_more_acked: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredFinish {
    identity: String,
    result: FinishReceipt,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum FinishRecord {
    Current(StoredFinish),
    // Prior versions completed runs without a stream event. Never invent one on retry.
    Legacy((String, SessionSnapshot)),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredAppendReceipt {
    fingerprint: String,
    receipt: StreamAppendReceipt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredControlReceipt {
    identity: String,
    result: QueueMutationReceipt,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueueMutationReceipt {
    pub queue: crate::input_queue::QueueState,
    pub snapshot: SessionSnapshot,
    pub event: Option<StreamEvent>,
    pub reused: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlState {
    #[serde(default)]
    pub permissions: Vec<serde_json::Value>,
    #[serde(default)]
    pub interactions: Vec<serde_json::Value>,
    #[serde(default)]
    pub runtime_control: Option<serde_json::Value>,
    #[serde(default)]
    pub process_leases: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredControlCommandReceipt {
    identity: String,
    result: crate::actor::ControlCommandReceipt,
}

/// Versioned, length-delimited digest; stable across processes and Rust releases.
pub fn append_fingerprint(
    session: &str,
    run: &str,
    producer: &str,
    sequence: u64,
    epoch: u64,
    durability: Durability,
    events: &[PendingEvent],
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"synax.runtime.append.v1\0");
    for value in [session, run, producer] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    digest.update(sequence.to_be_bytes());
    digest.update(epoch.to_be_bytes());
    digest.update([match durability {
        Durability::Sync => 0,
        Durability::GroupCommit => 1,
        Durability::Ephemeral => 2,
    }]);
    digest.update((events.len() as u64).to_be_bytes());
    for event in events {
        digest.update((event.kind.len() as u64).to_be_bytes());
        digest.update(event.kind.as_bytes());
        digest.update((event.payload.len() as u64).to_be_bytes());
        digest.update(&event.payload);
    }
    format!("{:x}", digest.finalize())
}

#[derive(Clone)]
struct FaultConfig {
    ack_unknown_after_commit: bool,
    abort_after_commit: bool,
    abort_after_append: bool,
    abort_after_finish: bool,
    disk_full: bool,
}

#[derive(Clone)]
pub struct HotStore {
    db: Arc<DB>,
    committer: Arc<Committer>,
    snapshots: Cache<String, SessionSnapshot>,
    faults: FaultConfig,
}

impl HotStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        Self::open_with_faults(
            path,
            FaultConfig {
                ack_unknown_after_commit: std::env::var("SYNAX_RUNTIME_HOT_ACK_UNKNOWN")
                    == Ok("1".to_owned()),
                abort_after_finish: std::env::var("SYNAX_RUNTIME_HOT_ABORT_FINISH_AFTER_COMMIT")
                    == Ok("1".to_owned()),
                abort_after_append: std::env::var("SYNAX_RUNTIME_HOT_ABORT_APPEND_AFTER_COMMIT")
                    == Ok("1".to_owned()),
                abort_after_commit: std::env::var("SYNAX_RUNTIME_HOT_ABORT_AFTER_COMMIT")
                    == Ok("1".to_owned()),
                disk_full: std::env::var("SYNAX_RUNTIME_HOT_DISK_FULL") == Ok("1".to_owned()),
            },
        )
    }

    fn open_with_faults(path: impl AsRef<Path>, faults: FaultConfig) -> Result<Self, StorageError> {
        let mut options = Options::default();
        options.create_if_missing(true);
        options.create_missing_column_families(true);
        let descriptors = [
            CF_SESSIONS,
            CF_RUNS,
            CF_RECEIPTS,
            CF_STREAMS,
            CF_TRANSITIONS,
            CF_APPENDS,
            CF_UI,
            CF_ACTIVATIONS,
            CF_CONTROLS,
            CF_HISTORY_OUTBOX,
        ]
        .into_iter()
        .map(|name| ColumnFamilyDescriptor::new(name, Options::default()))
        .collect::<Vec<_>>();
        let db = Arc::new(DB::open_cf_descriptors(&options, path, descriptors)?);
        Ok(Self {
            committer: Arc::new(Committer::new(db.clone())),
            db,
            snapshots: Cache::builder()
                .max_capacity(SNAPSHOT_CACHE_CAPACITY)
                .build(),
            faults,
        })
    }

    pub async fn snapshot_async(
        &self,
        session_id: String,
    ) -> Result<SessionSnapshot, StorageError> {
        // The shard actor serializes reads and writes for a session, including cache fills.
        if let Some(snapshot) = self.snapshots.get(&session_id).await {
            return Ok(snapshot);
        }
        let store = self.clone();
        let key = session_id.clone();
        let snapshot = tokio::task::spawn_blocking(move || store.snapshot(&session_id))
            .await
            .map_err(|error| {
                StorageError::Runtime(RuntimeError::InvalidCommand(format!(
                    "storage task failed: {error}"
                )))
            })??;
        self.snapshots.insert(key, snapshot.clone()).await;
        Ok(snapshot)
    }

    pub async fn admit_run_async(
        &self,
        session_id: String,
        request_id: String,
        body_hash: String,
        run_id: String,
        epoch: u64,
        expected_revision: u64,
        queue_item: Vec<u8>,
    ) -> Result<RunAdmission, StorageError> {
        self.admit_run_with_document_async(
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

    pub async fn admit_run_with_document_async(
        &self,
        session_id: String,
        request_id: String,
        body_hash: String,
        run_id: String,
        epoch: u64,
        expected_revision: u64,
        queue_item: Vec<u8>,
        run_json: Vec<u8>,
    ) -> Result<RunAdmission, StorageError> {
        let store = self.clone();
        let key = session_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            store.admit_run_with_document(
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
        .await
        .map_err(|error| {
            StorageError::Runtime(RuntimeError::InvalidCommand(format!(
                "storage task failed: {error}"
            )))
        });
        // Also invalidate on acknowledgement loss: the write may have committed.
        self.snapshots.invalidate(&key).await;
        result?
    }

    pub async fn append_stream_async(
        &self,
        session_id: String,
        run_id: String,
        producer_id: String,
        producer_sequence: u64,
        epoch: u64,
        durability: Durability,
        events: Vec<PendingEvent>,
    ) -> Result<StreamAppendReceipt, StorageError> {
        let store = self.clone();
        let key = session_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            store.append_stream_with_durability(
                &session_id,
                &run_id,
                &producer_id,
                producer_sequence,
                epoch,
                durability,
                events,
            )
        })
        .await
        .map_err(|error| {
            StorageError::Runtime(RuntimeError::InvalidCommand(format!(
                "storage task failed: {error}"
            )))
        });
        // Also invalidate on acknowledgement loss: the write may have committed.
        self.snapshots.invalidate(&key).await;
        result?
    }

    pub async fn replay_async(
        &self,
        session_id: String,
        after: u64,
    ) -> Result<Vec<StreamEvent>, StorageError> {
        self.replay_bounded_async(session_id, after, 256, 1024 * 1024 - 8192)
            .await
    }

    pub async fn replay_bounded_async(
        &self,
        session_id: String,
        after: u64,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<Vec<StreamEvent>, StorageError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            store.replay_bounded(&session_id, after, max_events, max_bytes)
        })
        .await
        .map_err(|error| {
            StorageError::Runtime(RuntimeError::StorageUnavailable(error.to_string()))
        })?
    }

    pub async fn history_outbox_async(
        &self,
        session_id: String,
        limit: usize,
    ) -> Result<Vec<StreamEvent>, StorageError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.history_outbox(&session_id, limit.min(4096)))
            .await
            .map_err(|error| {
                StorageError::Runtime(RuntimeError::StorageUnavailable(error.to_string()))
            })?
    }

    pub async fn history_outbox_ack_async(
        &self,
        session_id: String,
        through: u64,
    ) -> Result<(), StorageError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.history_outbox_ack(&session_id, through))
            .await
            .map_err(|error| {
                StorageError::Runtime(RuntimeError::StorageUnavailable(error.to_string()))
            })?
    }

    pub async fn history_outbox_maintain_async(
        &self,
        session_id: String,
        max_entries: usize,
    ) -> Result<HistoryOutboxMaintenance, StorageError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            store.history_outbox_maintain(
                &session_id,
                max_entries.min(HISTORY_OUTBOX_MAINTENANCE_BATCH),
            )
        })
        .await
        .map_err(|error| {
            StorageError::Runtime(RuntimeError::StorageUnavailable(error.to_string()))
        })?
    }

    /// Return a bounded page of sessions that have durable outbox records.
    /// The cursor is a RocksDB key, so a caller can walk the keyspace without
    /// repeatedly rescanning already visited sessions or relying on a UI
    /// projection to discover old runtime data.
    pub async fn history_outbox_sessions_async(
        &self,
        start_after: Option<String>,
        limit: usize,
    ) -> Result<HistoryOutboxSessionPage, StorageError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            store.history_outbox_sessions(start_after.as_deref(), limit)
        })
        .await
        .map_err(|error| {
            StorageError::Runtime(RuntimeError::StorageUnavailable(error.to_string()))
        })?
    }

    pub async fn ui_snapshot_async(
        &self,
        session_id: String,
        seed: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, StorageError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.ui_snapshot(&session_id, seed.as_deref()))
            .await
            .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))?
    }

    pub async fn queue_mutation_async(
        &self,
        session_id: String,
        request_id: String,
        epoch: u64,
        revision: u64,
        operation: String,
        payload: Vec<u8>,
    ) -> Result<QueueMutationReceipt, StorageError> {
        let store = self.clone();
        let key = session_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            store.queue_mutation(
                &session_id,
                &request_id,
                epoch,
                revision,
                &operation,
                &payload,
            )
        })
        .await
        .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()));
        self.snapshots.invalidate(&key).await;
        result?
    }
    pub async fn queue_read_async(&self, session_id: String) -> Result<Vec<u8>, StorageError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let projection = store
                .read_ui_projection(&session_id)?
                .ok_or(RuntimeError::ProjectionMissing)?;
            Ok(serde_json::to_vec(&projection.queue())?)
        })
        .await
        .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))?
    }

    pub async fn session_list_async(&self) -> Result<Vec<u8>, StorageError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.session_list())
            .await
            .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))?
    }

    pub async fn import_ui_projection_async(
        &self,
        session_id: String,
        snapshot_json: Vec<u8>,
    ) -> Result<Vec<u8>, StorageError> {
        let store = self.clone();
        let key = session_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            store.import_ui_projection(&session_id, &snapshot_json)
        })
        .await
        .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()));
        self.snapshots.invalidate(&key).await;
        result?
    }

    pub async fn import_stream_async(
        &self,
        session_id: String,
        events_json: Vec<u8>,
    ) -> Result<Vec<u8>, StorageError> {
        let store = self.clone();
        let key = session_id.clone();
        let result =
            tokio::task::spawn_blocking(move || store.import_stream(&session_id, &events_json))
                .await
                .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()));
        self.snapshots.invalidate(&key).await;
        result?
    }

    pub async fn control_state_async(&self, session_id: String) -> Result<Vec<u8>, StorageError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.control_state(&session_id))
            .await
            .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))?
    }

    pub async fn control_command_async(
        &self,
        session_id: String,
        request_id: String,
        epoch: u64,
        revision: u64,
        operation: String,
        payload: Vec<u8>,
    ) -> Result<crate::actor::ControlCommandReceipt, StorageError> {
        let store = self.clone();
        let key = session_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            store.control_command(
                &session_id,
                &request_id,
                epoch,
                revision,
                &operation,
                &payload,
            )
        })
        .await
        .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()));
        self.snapshots.invalidate(&key).await;
        result?
    }

    fn control_state(&self, session_id: &str) -> Result<Vec<u8>, StorageError> {
        let state = self.read_control_state(session_id)?;
        Ok(serde_json::to_vec(&state)?)
    }

    fn control_command(
        &self,
        session_id: &str,
        request_id: &str,
        epoch: u64,
        revision: u64,
        operation: &str,
        payload: &[u8],
    ) -> Result<crate::actor::ControlCommandReceipt, StorageError> {
        use crate::actor::ControlCommandReceipt;

        if request_id.is_empty()
            || request_id.len() > 256
            || operation.is_empty()
            || operation.len() > 64
            || payload.len() > 512 * 1024
        {
            return Err(
                RuntimeError::InvalidCommand("control command exceeds bounds".into()).into(),
            );
        }
        let value: serde_json::Value = if payload.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(payload)?
        };
        let identity = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&("control.v1", operation, &value))?)
        );
        let receipt_key = control_receipt_key(session_id, request_id);
        if let Some(bytes) = self.get(CF_CONTROLS, receipt_key.as_bytes())? {
            let saved: StoredControlCommandReceipt = serde_json::from_slice(&bytes)?;
            if saved.identity != identity {
                return Err(RuntimeError::RequestConflict.into());
            }
            self.write_with_durability(WriteBatch::default(), Durability::Sync)?;
            let mut result = saved.result;
            result.reused = true;
            return Ok(result);
        }

        let mut state = self.read_session(session_id)?;
        ensure_epoch(&state, epoch)?;
        ensure_revision(&state, revision)?;
        let mut control = self.read_control_state(session_id)?;
        let mut projection = self
            .read_ui_projection(session_id)?
            .ok_or(RuntimeError::ProjectionMissing)?;

        let now = chrono::Utc::now().to_rfc3339();
        let mut changed = false;
        let mut event_name = operation.to_owned();
        let mut event_run_id = projection.session["activeRunId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();

        match operation {
            "read" => {}
            "permission_request" => {
                let id = value["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        RuntimeError::InvalidCommand("permission id is required".into())
                    })?;
                if control
                    .permissions
                    .iter()
                    .any(|item| item["id"].as_str() == Some(id))
                {
                    return Err(RuntimeError::RequestConflict.into());
                }
                let mut item = value.clone();
                if item["createdAt"].is_null() {
                    item["createdAt"] = serde_json::json!(now);
                }
                if item["resolvedAt"].is_null() {
                    item["resolvedAt"] = serde_json::Value::Null;
                }
                control.permissions.push(item.clone());
                event_run_id = item["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                if item["action"] == "ask" && item["resolvedAt"].is_null() {
                    let reason = item["reason"].as_str().unwrap_or("Permission required");
                    set_projection_state(
                        &mut projection,
                        "waiting_permission",
                        Some(&event_run_id),
                        item["resumeToken"].as_str(),
                        Some(reason),
                        &now,
                    );
                }
                changed = true;
                event_name = "permission_requested".into();
            }
            "permission_reply" => {
                let id = required_string(&value, "id")?;
                let reply = required_string(&value, "reply")?;
                let item = control
                    .permissions
                    .iter_mut()
                    .find(|item| item["id"].as_str() == Some(id))
                    .ok_or_else(|| {
                        RuntimeError::InvalidCommand("permission was not found".into())
                    })?;
                if item["resolvedAt"].is_string() {
                    if item["userReply"].as_str() == Some(reply) {
                        return Err(RuntimeError::RequestConflict.into());
                    }
                    return Err(RuntimeError::InvalidCommand(
                        "permission was already resolved".into(),
                    )
                    .into());
                }
                let action = if reply == "reject" { "deny" } else { "allow" };
                item["userReply"] = serde_json::json!(reply);
                item["action"] = serde_json::json!(action);
                item["resolvedAt"] = serde_json::json!(now);
                if let Some(message) = value["message"].as_str() {
                    item["reason"] = serde_json::json!(format!(
                        "{} {}",
                        item["reason"].as_str().unwrap_or_default(),
                        message
                    ));
                }
                event_run_id = item["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                let resume = item["resumeToken"].as_str();
                if action == "allow" && resume.is_some() {
                    set_projection_state(
                        &mut projection,
                        "running",
                        Some(&event_run_id),
                        None,
                        None,
                        &now,
                    );
                    projection.session["completedAt"] = serde_json::Value::Null;
                    projection.session["resultSummary"] = serde_json::Value::Null;
                } else {
                    let reason = item["reason"].as_str().unwrap_or("Permission denied");
                    set_projection_state(
                        &mut projection,
                        "completed",
                        None,
                        None,
                        Some(reason),
                        &now,
                    );
                    projection.session["completedAt"] = serde_json::json!(now);
                    projection.session["resultSummary"] = serde_json::json!(reason);
                    if projection.run["id"].as_str() == Some(&event_run_id) {
                        projection.run["status"] = serde_json::json!("blocked");
                        projection.run["completedAt"] = serde_json::json!(now);
                        projection.run["stopReason"] = serde_json::json!(reason);
                        if projection.run["metadata"].is_object()
                            && projection.run["metadata"]["executionLease"].is_object()
                        {
                            projection.run["metadata"]["executionLease"]["closed"] =
                                serde_json::json!(true);
                        }
                    }
                    for chunk in &mut projection.live_chunks {
                        if chunk["type"] == "tool_call" || chunk["type"] == "tool_result" {
                            if chunk["toolCall"]["id"].as_str() == item["toolCallId"].as_str() {
                                chunk["toolCall"]["status"] = serde_json::json!("denied");
                                chunk["toolCall"]["endedAt"] = serde_json::json!(now);
                                chunk["toolCall"]["error"] = serde_json::json!(reason);
                            }
                        }
                    }
                }
                changed = true;
                event_name = "permission_resolved".into();
            }
            "interaction_request" => {
                let id = required_string(&value, "id")?;
                if control
                    .interactions
                    .iter()
                    .any(|item| item["id"].as_str() == Some(id))
                {
                    return Err(RuntimeError::RequestConflict.into());
                }
                let mut item = value.clone();
                if item["status"].is_null() {
                    item["status"] = serde_json::json!("pending");
                }
                if item["createdAt"].is_null() {
                    item["createdAt"] = serde_json::json!(now);
                }
                control.interactions.push(item.clone());
                event_run_id = item["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                let title = item["request"]["title"]
                    .as_str()
                    .unwrap_or("Input required");
                set_projection_state(
                    &mut projection,
                    "waiting_input",
                    Some(&event_run_id),
                    Some(&format!("interaction:{id}")),
                    Some(title),
                    &now,
                );
                changed = true;
                event_name = "interaction_requested".into();
            }
            "interaction_reply" => {
                let id = required_string(&value, "id")?;
                let reply = value
                    .get("reply")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let item = control
                    .interactions
                    .iter_mut()
                    .find(|item| item["id"].as_str() == Some(id))
                    .ok_or_else(|| {
                        RuntimeError::InvalidCommand("interaction was not found".into())
                    })?;
                if item["status"] != "pending" {
                    if item["response"] == reply {
                        return Err(RuntimeError::RequestConflict.into());
                    }
                    return Err(RuntimeError::InvalidCommand(
                        "interaction was already resolved".into(),
                    )
                    .into());
                }
                if let Some(expected) = value["revision"].as_u64() {
                    if item["revision"].as_u64() != Some(expected) {
                        return Err(RuntimeError::RevisionConflict {
                            expected,
                            actual: item["revision"].as_u64().unwrap_or_default(),
                        }
                        .into());
                    }
                }
                let status = if reply["action"] == "cancel" {
                    "cancelled"
                } else {
                    "answered"
                };
                item["status"] = serde_json::json!(status);
                item["response"] = reply;
                item["resolvedAt"] = serde_json::json!(now);
                event_run_id = item["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                changed = true;
                event_name = "interaction_resolved".into();
            }
            "interaction_consume" => {
                let id = required_string(&value, "id")?;
                let item = control
                    .interactions
                    .iter_mut()
                    .find(|item| item["id"].as_str() == Some(id))
                    .ok_or_else(|| {
                        RuntimeError::InvalidCommand("interaction was not found".into())
                    })?;
                item["consumedAt"] = serde_json::json!(now);
                event_run_id = item["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                set_projection_state(
                    &mut projection,
                    "running",
                    Some(&event_run_id),
                    None,
                    None,
                    &now,
                );
                changed = true;
                event_name = "interaction_consumed".into();
            }
            "stop_begin" | "stop_unconfirmed" => {
                let run_id = value["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                let control_state = if operation == "stop_begin" {
                    "stopping"
                } else {
                    "unconfirmed"
                };
                control.runtime_control = Some(
                    serde_json::json!({"state":control_state,"runId":run_id,"reason":value["reason"],"updatedAt":now}),
                );
                event_run_id = run_id.clone();
                set_projection_state(
                    &mut projection,
                    "stopping",
                    Some(&run_id),
                    None,
                    value["reason"].as_str(),
                    &now,
                );
                changed = true;
                event_name = operation.into();
            }
            "stop_ack" => {
                control.runtime_control = None;
                event_run_id = value["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                set_projection_state(
                    &mut projection,
                    "interrupted",
                    None,
                    None,
                    value["reason"].as_str(),
                    &now,
                );
                changed = true;
                event_name = "stop_acknowledged".into();
            }
            "resume" => {
                control.runtime_control = None;
                event_run_id = value["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                set_projection_state(
                    &mut projection,
                    "running",
                    Some(&event_run_id),
                    None,
                    None,
                    &now,
                );
                changed = true;
                event_name = "run_resumed".into();
            }
            "lease_open" | "lease_close" => {
                let lease_id = required_string(&value, "leaseId")?;
                control
                    .process_leases
                    .retain(|item| item["leaseId"].as_str() != Some(lease_id));
                if operation == "lease_open" {
                    control.process_leases.push(value.clone());
                }
                changed = true;
                event_name = operation.into();
            }
            "run_patch" => {
                let run_id = required_string(&value, "runId")?;
                let patch = value["patch"].as_object().ok_or_else(|| {
                    RuntimeError::InvalidCommand("run patch must be an object".into())
                })?;
                if projection.run["id"].as_str() != Some(run_id) {
                    return Err(RuntimeError::InvalidCommand(
                        "run patch does not target the projected run".into(),
                    )
                    .into());
                }
                for key in patch.keys() {
                    if !matches!(
                        key.as_str(),
                        "status"
                            | "currentStep"
                            | "completedAt"
                            | "stopReason"
                            | "triggerMessageId"
                            | "metadata"
                            | "model"
                    ) {
                        return Err(RuntimeError::InvalidCommand(format!(
                            "run field cannot be patched: {key}"
                        ))
                        .into());
                    }
                }
                let target = projection.run.as_object_mut().ok_or_else(|| {
                    RuntimeError::InvalidCommand("projected run is not an object".into())
                })?;
                for (key, patch_value) in patch {
                    if key == "metadata"
                        && target.get(key).is_some_and(|item| item.is_object())
                        && patch_value.is_object()
                    {
                        let metadata = target[key].as_object_mut().expect("metadata object");
                        for (nested, nested_value) in
                            patch_value.as_object().expect("patch metadata object")
                        {
                            metadata.insert(nested.clone(), nested_value.clone());
                        }
                    } else {
                        target.insert(key.clone(), patch_value.clone());
                    }
                }
                event_run_id = run_id.to_owned();
                changed = true;
                event_name = "run_updated".into();
            }
            "session_patch" => {
                let patch = value["patch"].as_object().ok_or_else(|| {
                    RuntimeError::InvalidCommand("session patch must be an object".into())
                })?;
                for (key, patch_value) in patch {
                    match key.as_str() {
                        "title" | "prompt" | "contextSnapshotId" | "profileId" | "nodeId"
                        | "childSessionIds" | "skillIds" | "mcpServerIds" | "permissionRules"
                        | "pinned" | "mode" | "status" | "activeRunId" | "completedAt"
                        | "updatedAt" | "archivedAt" | "archiveBatchId" | "resultSummary"
                        | "blockedReason" | "pendingResumeToken" => {
                            if key == "status"
                                && !patch_value
                                    .as_str()
                                    .is_some_and(crate::projection::is_valid_status)
                            {
                                return Err(RuntimeError::InvalidCommand(
                                    "invalid session status patch".into(),
                                )
                                .into());
                            }
                            projection.session[key] = patch_value.clone();
                        }
                        "sessionMetadata" => {
                            if !projection.session["sessionMetadata"].is_object() {
                                projection.session["sessionMetadata"] = serde_json::json!({});
                            }
                            let target = projection.session["sessionMetadata"]
                                .as_object_mut()
                                .ok_or_else(|| {
                                    RuntimeError::InvalidCommand(
                                        "sessionMetadata is not an object".into(),
                                    )
                                })?;
                            let source = patch_value.as_object().ok_or_else(|| {
                                RuntimeError::InvalidCommand(
                                    "sessionMetadata patch must be an object".into(),
                                )
                            })?;
                            for (nested_key, nested_value) in source {
                                target.insert(nested_key.clone(), nested_value.clone());
                            }
                        }
                        _ => {
                            return Err(RuntimeError::InvalidCommand(format!(
                                "session field cannot be patched: {key}"
                            ))
                            .into());
                        }
                    }
                }
                changed = true;
                event_name = "session_updated".into();
            }
            _ => {
                return Err(RuntimeError::InvalidCommand(format!(
                    "unknown control operation: {operation}"
                ))
                .into());
            }
        }

        let snapshot = if changed {
            state.cursor += 1;
            state.revision += 1;
            let state_payload = serde_json::json!({
                "schema": 1,
                "chunk": {"type": event_name, "sessionId": session_id, "runId": event_run_id, "control": control.clone()},
                "state": {"status": projection.session["status"], "activeRunId": projection.session["activeRunId"], "pendingResumeToken": projection.session["pendingResumeToken"], "blockedReason": projection.session["blockedReason"], "updatedAt": projection.session["updatedAt"]}
            });
            let event = StreamEvent {
                sequence: state.cursor,
                run_id: event_run_id.clone(),
                kind: event_name.clone(),
                payload: serde_json::to_vec(&state_payload)?,
                ephemeral: false,
            };
            projection.apply(
                state.cursor,
                &event_run_id,
                &PendingEvent {
                    kind: event.kind.clone(),
                    payload: event.payload.clone(),
                },
            )?;
            state.retained_from = state.cursor.saturating_sub(EVENT_RETENTION) + 1;
            let mut batch = WriteBatch::default();
            if event_name == "run_updated" {
                if let Some(existing) =
                    self.get(CF_RUNS, run_key(session_id, &event_run_id).as_bytes())?
                {
                    let mut stored: StoredRun = serde_json::from_slice(&existing)?;
                    stored.document = Some(projection.run.clone());
                    stored.revision = state.revision;
                    self.put_batch(
                        &mut batch,
                        CF_RUNS,
                        run_key(session_id, &event_run_id),
                        &serde_json::to_vec(&stored)?,
                    )?;
                }
            }
            self.put_batch(
                &mut batch,
                CF_SESSIONS,
                session_key(session_id),
                &serde_json::to_vec(&state)?,
            )?;
            self.put_batch(
                &mut batch,
                CF_CONTROLS,
                control_state_key(session_id),
                &serde_json::to_vec(&control)?,
            )?;
            self.put_batch(
                &mut batch,
                CF_UI,
                session_key(session_id),
                &projection.encode()?,
            )?;
            self.put_batch(
                &mut batch,
                CF_STREAMS,
                stream_key(session_id, state.cursor),
                &serde_json::to_vec(&event)?,
            )?;
            self.put_batch(
                &mut batch,
                CF_HISTORY_OUTBOX,
                history_outbox_key(session_id, state.cursor),
                &serde_json::to_vec(&event)?,
            )?;
            for sequence in 1..state.retained_from {
                batch.delete_cf(self.cf(CF_STREAMS)?, stream_key(session_id, sequence));
            }
            let result = ControlCommandReceipt {
                state_json: serde_json::to_vec(&control)?,
                snapshot: state.snapshot(),
                event: Some(event),
                reused: false,
            };
            self.put_batch(
                &mut batch,
                CF_CONTROLS,
                receipt_key,
                &serde_json::to_vec(&StoredControlCommandReceipt {
                    identity,
                    result: result.clone(),
                })?,
            )?;
            self.write_with_durability(batch, Durability::Sync)?;
            result
        } else {
            let result = ControlCommandReceipt {
                state_json: serde_json::to_vec(&control)?,
                snapshot: state.snapshot(),
                event: None,
                reused: false,
            };
            let mut batch = WriteBatch::default();
            self.put_batch(
                &mut batch,
                CF_CONTROLS,
                receipt_key,
                &serde_json::to_vec(&StoredControlCommandReceipt {
                    identity,
                    result: result.clone(),
                })?,
            )?;
            self.write_with_durability(batch, Durability::Sync)?;
            result
        };
        Ok(snapshot)
    }
    fn queue_mutation(
        &self,
        session_id: &str,
        request_id: &str,
        epoch: u64,
        revision: u64,
        operation: &str,
        payload: &[u8],
    ) -> Result<QueueMutationReceipt, StorageError> {
        if request_id.is_empty()
            || request_id.len() > 256
            || operation.len() > 32
            || payload.len() > 512 * 1024
        {
            return Err(RuntimeError::InvalidCommand("queue command exceeds bounds".into()).into());
        }
        let value: serde_json::Value = serde_json::from_slice(payload)?;
        let identity = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&("queue.v1", operation, &value))?)
        );
        let key = serde_json::to_vec(&(session_id, request_id))?;
        if let Some(bytes) = self.get(CF_CONTROLS, &key)? {
            let saved: StoredControlReceipt = serde_json::from_slice(&bytes)?;
            if saved.identity != identity {
                return Err(RuntimeError::RequestConflict.into());
            }
            self.write_with_durability(WriteBatch::default(), Durability::Sync)?;
            let mut result = saved.result;
            result.reused = true;
            return Ok(result);
        }
        let mut state = self.read_session(session_id)?;
        ensure_epoch(&state, epoch)?;
        ensure_revision(&state, revision)?;
        if operation == "consume" {
            let run = value["runId"].as_str().ok_or_else(|| {
                RuntimeError::InvalidCommand("consumption requires active run".into())
            })?;
            if state.active_run_id.as_deref() != Some(run) {
                return Err(RuntimeError::InvalidCommand(
                    "input consumer is not active run".into(),
                )
                .into());
            }
        }
        let mut projection = self
            .read_ui_projection(session_id)?
            .ok_or(RuntimeError::ProjectionMissing)?;
        if operation == "consume"
            && projection.force_inject_item_id.as_deref() != value["id"].as_str()
        {
            return Err(RuntimeError::InvalidCommand(
                "forced input changed before consumption".into(),
            )
            .into());
        }
        let (queue, changed) = projection.queue_mutation(operation, payload)?;
        let mut batch = WriteBatch::default();
        let mut event = None;
        if changed {
            state.cursor += 1;
            state.revision += 1;
            let run_id = projection.session["activeRunId"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let payload = serde_json::to_vec(&serde_json::json!({ "schema":1,
                "chunk":{"type":"input_queue_changed","sessionId":session_id,"queueSize":queue.items.len(),"forceInjectItemId":queue.force_inject_item_id,"queueRevision":queue.revision},
                "state":{"status":projection.session["status"],"activeRunId":projection.session["activeRunId"],"pendingResumeToken":projection.session["pendingResumeToken"],"blockedReason":projection.session["blockedReason"],"updatedAt":projection.session["updatedAt"]}
            }))?;
            projection.apply(
                state.cursor,
                &run_id,
                &PendingEvent {
                    kind: "input_queue_changed".into(),
                    payload: payload.clone(),
                },
            )?;
            let record = StreamEvent {
                sequence: state.cursor,
                run_id,
                kind: "input_queue_changed".into(),
                payload,
                ephemeral: false,
            };
            self.put_batch(
                &mut batch,
                CF_STREAMS,
                stream_key(session_id, state.cursor),
                &serde_json::to_vec(&record)?,
            )?;
            let retained_from = state.cursor.saturating_sub(EVENT_RETENTION) + 1;
            for sequence in state.retained_from..retained_from {
                batch.delete_cf(self.cf(CF_STREAMS)?, stream_key(session_id, sequence));
            }
            state.retained_from = retained_from;
            event = Some(record);
            self.put_batch(
                &mut batch,
                CF_SESSIONS,
                session_key(session_id),
                &serde_json::to_vec(&state)?,
            )?;
            self.put_batch(
                &mut batch,
                CF_UI,
                session_key(session_id),
                &projection.encode()?,
            )?;
        }
        let result = QueueMutationReceipt {
            queue,
            snapshot: state.snapshot(),
            event,
            reused: false,
        };
        self.put_batch(
            &mut batch,
            CF_CONTROLS,
            key,
            &serde_json::to_vec(&StoredControlReceipt {
                identity,
                result: result.clone(),
            })?,
        )?;
        self.write_with_durability(batch, Durability::Sync)?;
        Ok(result)
    }

    pub fn ui_snapshot(
        &self,
        session_id: &str,
        seed: Option<&[u8]>,
    ) -> Result<Vec<u8>, StorageError> {
        if let Some(bytes) = self.get(CF_UI, session_key(session_id).as_bytes())? {
            return Ok(bytes);
        }
        let Some(seed) = seed else {
            return Err(RuntimeError::ProjectionMissing.into());
        };
        let state = self.read_session(session_id)?;
        if state.cursor != 0 || state.revision != 0 || state.active_run_id.is_some() {
            return Err(RuntimeError::ProjectionMigrationRequired.into());
        }
        let projection = UiSnapshot::seed(session_id, seed)?;
        let bytes = projection.encode()?;
        let mut batch = WriteBatch::default();
        self.put_batch(&mut batch, CF_UI, session_key(session_id), &bytes)?;
        self.write_with_durability(batch, Durability::Sync)?;
        Ok(bytes)
    }

    fn read_ui_projection(&self, session_id: &str) -> Result<Option<UiSnapshot>, StorageError> {
        self.get(CF_UI, session_key(session_id).as_bytes())?
            .map(|bytes| serde_json::from_slice(&bytes).map_err(StorageError::from))
            .transpose()
    }

    pub fn snapshot(&self, session_id: &str) -> Result<SessionSnapshot, StorageError> {
        Ok(self.read_session(session_id)?.snapshot())
    }

    #[cfg(test)]
    pub fn admit_run(
        &self,
        session_id: &str,
        request_id: &str,
        body_hash: &str,
        run_id: &str,
        epoch: u64,
        revision: u64,
    ) -> Result<RunAdmission, StorageError> {
        self.admit_run_with_queue(
            session_id,
            request_id,
            body_hash,
            run_id,
            epoch,
            revision,
            &[],
        )
    }

    pub fn admit_run_with_queue(
        &self,
        session_id: &str,
        request_id: &str,
        body_hash: &str,
        run_id: &str,
        epoch: u64,
        expected_revision: u64,
        queue_item_json: &[u8],
    ) -> Result<RunAdmission, StorageError> {
        self.admit_run_with_document(
            session_id,
            request_id,
            body_hash,
            run_id,
            epoch,
            expected_revision,
            queue_item_json,
            &[],
        )
    }

    pub fn admit_run_with_document(
        &self,
        session_id: &str,
        request_id: &str,
        body_hash: &str,
        run_id: &str,
        epoch: u64,
        expected_revision: u64,
        queue_item_json: &[u8],
        run_json: &[u8],
    ) -> Result<RunAdmission, StorageError> {
        let queue_item: Option<serde_json::Value> = if queue_item_json.is_empty() {
            None
        } else {
            Some(serde_json::from_slice(queue_item_json)?)
        };
        let run_document: Option<serde_json::Value> = if run_json.is_empty() {
            None
        } else {
            let document: serde_json::Value = serde_json::from_slice(run_json)?;
            if document["id"].as_str() != Some(run_id)
                || document["sessionId"].as_str() != Some(session_id)
                || document["status"] != "queued"
                || document["startedAt"].as_str().is_none()
            {
                return Err(RuntimeError::InvalidCommand(
                    "admission requires a queued run document with matching identity".into(),
                )
                .into());
            }
            Some(document)
        };
        let run_hash = (!run_json.is_empty()).then(|| format!("{:x}", Sha256::digest(run_json)));
        let mut state = self.read_session(session_id)?;
        let receipt_key = receipt_key(session_id, request_id);
        if let Some(bytes) = self.get(CF_RECEIPTS, receipt_key.as_bytes())? {
            let receipt: StoredReceipt = serde_json::from_slice(&bytes)?;
            if receipt.body_hash != body_hash || receipt.queue_item != queue_item {
                return Err(RuntimeError::RequestConflict.into());
            }
            // A prior write may have reached memory/WAL but lost its sync acknowledgement.
            // Confirm the barrier before acknowledging an idempotent retry.
            self.write_with_durability(WriteBatch::default(), Durability::Sync)?;
            let mut reused = receipt.admission;
            reused.reused = true;
            return Ok(reused);
        }
        ensure_epoch(&state, epoch)?;
        ensure_revision(&state, expected_revision)?;
        if state.active_run_id.is_some() {
            return Err(RuntimeError::SessionBusy.into());
        }
        if self
            .get(CF_RUNS, run_key(session_id, run_id).as_bytes())?
            .is_some()
        {
            return Err(RuntimeError::InvalidCommand("run id already exists".into()).into());
        }
        let mut projection = self.read_ui_projection(session_id)?;
        if projection
            .as_ref()
            .is_some_and(|projection| projection.pending_queue_input.is_some())
        {
            return Err(RuntimeError::InvalidCommand(
                "previous input delivery requires recovery before admission".into(),
            )
            .into());
        }
        let mut queue_event = None;
        let mut batch = WriteBatch::default();
        if let Some(item) = queue_item.as_ref() {
            let projection = projection.as_mut().ok_or(RuntimeError::ProjectionMissing)?;
            let id = crate::input_queue::item_id(item)?;
            let mut queue = projection.queue();
            let persisted = queue
                .items
                .iter()
                .find(|entry| entry["id"].as_str() == Some(id))
                .ok_or_else(|| {
                    RuntimeError::InvalidCommand("queued input no longer exists".into())
                })?;
            if persisted != item {
                return Err(RuntimeError::RequestConflict.into());
            }
            queue.apply("consume", &serde_json::json!({"id":id, "runId":run_id}))?;
            // Admission is the durable owner of this input; no intermediate delivery remains.
            queue.delivery = None;
            projection.set_queue(&queue);
            state.cursor += 1;
            let payload = serde_json::to_vec(&serde_json::json!({"schema":1,
                "chunk":{"type":"input_queue_changed","sessionId":session_id,"queueSize":queue.items.len(),"forceInjectItemId":queue.force_inject_item_id,"queueRevision":queue.revision},
                "state":{"status":projection.session["status"],"activeRunId":projection.session["activeRunId"],"pendingResumeToken":projection.session["pendingResumeToken"],"blockedReason":projection.session["blockedReason"],"updatedAt":projection.session["updatedAt"]}
            }))?;
            let event = StreamEvent {
                sequence: state.cursor,
                run_id: run_id.into(),
                kind: "input_queue_changed".into(),
                payload,
                ephemeral: false,
            };
            projection.apply(
                state.cursor,
                run_id,
                &PendingEvent {
                    kind: event.kind.clone(),
                    payload: event.payload.clone(),
                },
            )?;
            self.put_batch(
                &mut batch,
                CF_STREAMS,
                stream_key(session_id, state.cursor),
                &serde_json::to_vec(&event)?,
            )?;
            let retained_from = state.cursor.saturating_sub(EVENT_RETENTION) + 1;
            for sequence in state.retained_from..retained_from {
                batch.delete_cf(self.cf(CF_STREAMS)?, stream_key(session_id, sequence));
            }
            state.retained_from = retained_from;
            queue_event = Some(event);
        }
        state.revision += 1;
        state.active_run_id = Some(run_id.to_owned());
        let admission = RunAdmission {
            session_id: session_id.to_owned(),
            run_id: run_id.to_owned(),
            epoch: state.epoch,
            revision: state.revision,
            reused: false,
            queue_event,
        };
        let receipt = StoredReceipt {
            body_hash: body_hash.to_owned(),
            admission: admission.clone(),
            queue_item,
            run_hash,
        };
        let run = StoredRun {
            activation_request: None,
            document: run_document.clone(),
            terminal_status: None,
            run_id: run_id.to_owned(),
            session_id: session_id.to_owned(),
            epoch: state.epoch,
            revision: state.revision,
        };
        self.put_batch(
            &mut batch,
            CF_SESSIONS,
            session_key(session_id),
            &serde_json::to_vec(&state)?,
        )?;
        self.put_batch(
            &mut batch,
            CF_RECEIPTS,
            receipt_key,
            &serde_json::to_vec(&receipt)?,
        )?;
        self.put_batch(
            &mut batch,
            CF_RUNS,
            run_key(session_id, run_id),
            &serde_json::to_vec(&run)?,
        )?;
        if let Some(mut projection) = projection {
            projection.admitted(run_id);
            if let Some(document) = run_document {
                projection.run = document;
            }
            self.put_batch(
                &mut batch,
                CF_UI,
                session_key(session_id),
                &projection.encode()?,
            )?;
        }
        self.write_with_durability(batch, Durability::Sync)?;
        Ok(admission)
    }

    pub async fn activate_run_async(
        &self,
        session_id: String,
        request_id: String,
        run_json: Vec<u8>,
        epoch: u64,
        revision: u64,
    ) -> Result<ActivationReceipt, StorageError> {
        let store = self.clone();
        let key = session_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            store.activate_run(&session_id, &request_id, &run_json, epoch, revision)
        })
        .await
        .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()));
        self.snapshots.invalidate(&key).await;
        result?
    }

    fn activate_run(
        &self,
        session_id: &str,
        request_id: &str,
        run_json: &[u8],
        epoch: u64,
        revision: u64,
    ) -> Result<ActivationReceipt, StorageError> {
        if request_id.is_empty() || request_id.len() > 256 || run_json.len() > 512 * 1024 {
            return Err(RuntimeError::InvalidCommand(
                "activation request exceeds its bounds".into(),
            )
            .into());
        }
        let mut document: serde_json::Value = serde_json::from_slice(run_json)?;
        let run_id = document["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| RuntimeError::InvalidCommand("missing run identity".into()))?
            .to_owned();
        if document["sessionId"].as_str() != Some(session_id)
            || document["status"] != "queued"
            || document["startedAt"].as_str().is_none()
        {
            return Err(RuntimeError::InvalidCommand(
                "activation requires an admitted queued run document".into(),
            )
            .into());
        }
        let identity = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(epoch, revision, &document))?)
        );
        let key = serde_json::to_vec(&(session_id, request_id))?;
        if let Some(bytes) = self.get(CF_ACTIVATIONS, &key)? {
            let saved: StoredActivation = serde_json::from_slice(&bytes)?;
            if saved.identity != identity {
                return Err(RuntimeError::RequestConflict.into());
            }
            self.write_with_durability(WriteBatch::default(), Durability::Sync)?;
            let mut receipt = saved.result;
            receipt.reused = true;
            return Ok(receipt);
        }
        let mut state = self.read_session(session_id)?;
        ensure_epoch(&state, epoch)?;
        ensure_revision(&state, revision)?;
        if state.active_run_id.as_deref() != Some(&run_id) {
            return Err(RuntimeError::InvalidCommand("run is not admitted".into()).into());
        }
        let stored = self
            .get(CF_RUNS, run_key(session_id, &run_id).as_bytes())?
            .ok_or_else(|| RuntimeError::InvalidCommand("admitted run is missing".into()))?;
        let mut run: StoredRun = serde_json::from_slice(&stored)?;
        if run.activation_request.is_some() || run.terminal_status.is_some() {
            return Err(RuntimeError::InvalidCommand(
                "run was already activated or finalized".into(),
            )
            .into());
        }
        let mut projection = self
            .read_ui_projection(session_id)?
            .ok_or(RuntimeError::ProjectionMissing)?;
        // A command-generated event carries the committed state just like streamed events.
        document["status"] = serde_json::json!("running");
        document["completedAt"] = serde_json::Value::Null;
        let payload = serde_json::to_vec(&serde_json::json!({"schema":1,
            "chunk":{"type":"run_activated", "run":document},
            "state":{"status":"running", "activeRunId":run_id, "pendingResumeToken":null, "blockedReason":null, "updatedAt":document["startedAt"]}
        }))?;
        let pending = PendingEvent {
            kind: "run_activated".into(),
            payload,
        };
        state.cursor += 1;
        state.revision += 1;
        projection.apply(state.cursor, &run_id, &pending)?;
        run.activation_request = Some(request_id.into());
        run.document = Some(document);
        run.revision = state.revision;
        let event = StreamEvent {
            sequence: state.cursor,
            run_id: run_id.clone(),
            kind: pending.kind,
            payload: pending.payload,
            ephemeral: false,
        };
        let previous_retained = state.retained_from;
        state.retained_from = state.cursor.saturating_sub(EVENT_RETENTION) + 1;
        let result = ActivationReceipt {
            snapshot: state.snapshot(),
            event,
            reused: false,
        };
        let mut batch = WriteBatch::default();
        self.put_batch(
            &mut batch,
            CF_SESSIONS,
            session_key(session_id),
            &serde_json::to_vec(&state)?,
        )?;
        self.put_batch(
            &mut batch,
            CF_RUNS,
            run_key(session_id, &run_id),
            &serde_json::to_vec(&run)?,
        )?;
        self.put_batch(
            &mut batch,
            CF_UI,
            session_key(session_id),
            &projection.encode()?,
        )?;
        self.put_batch(
            &mut batch,
            CF_STREAMS,
            stream_key(session_id, state.cursor),
            &serde_json::to_vec(&result.event)?,
        )?;
        self.put_batch(
            &mut batch,
            CF_ACTIVATIONS,
            key,
            &serde_json::to_vec(&StoredActivation {
                identity,
                result: result.clone(),
            })?,
        )?;
        for sequence in previous_retained..state.retained_from {
            batch.delete_cf(self.cf(CF_STREAMS)?, stream_key(session_id, sequence));
        }
        self.write_with_durability(batch, Durability::Sync)?;
        Ok(result)
    }

    pub async fn finish_run_async(
        &self,
        session_id: String,
        request_id: String,
        run_id: String,
        status: String,
        epoch: u64,
        revision: u64,
        run_json: Vec<u8>,
    ) -> Result<FinishReceipt, StorageError> {
        let store = self.clone();
        let key = session_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            store.finish_run_with_document(
                &session_id,
                &request_id,
                &run_id,
                &status,
                epoch,
                revision,
                &run_json,
            )
        })
        .await
        .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()));
        self.snapshots.invalidate(&key).await;
        result?
    }

    #[cfg(test)]
    fn finish_run(
        &self,
        session_id: &str,
        request_id: &str,
        run_id: &str,
        status: &str,
        epoch: u64,
        revision: u64,
    ) -> Result<SessionSnapshot, StorageError> {
        self.finish_run_with_document(session_id, request_id, run_id, status, epoch, revision, &[])
            .map(|receipt| receipt.snapshot)
    }

    fn finish_run_with_document(
        &self,
        session_id: &str,
        request_id: &str,
        run_id: &str,
        status: &str,
        epoch: u64,
        revision: u64,
        run_json: &[u8],
    ) -> Result<FinishReceipt, StorageError> {
        if request_id.is_empty() || request_id.len() > 256 {
            return Err(
                RuntimeError::InvalidCommand("invalid completion request id".into()).into(),
            );
        }
        let supplied =
            crate::completion::decode_run_document(session_id, run_id, status, run_json)?;
        let key = receipt_key(session_id, request_id);
        let identity = serde_json::to_string(&(run_id, status, &supplied))?;
        if let Some(bytes) = self.get(CF_TRANSITIONS, key.as_bytes())? {
            let record: FinishRecord = serde_json::from_slice(&bytes)?;
            let mut result = match record {
                FinishRecord::Current(saved) if saved.identity == identity => saved.result,
                FinishRecord::Legacy((old, snapshot))
                    if supplied.is_none() && old == serde_json::to_string(&(run_id, status))? =>
                {
                    FinishReceipt {
                        snapshot,
                        event: None,
                        reused: true,
                    }
                }
                _ => return Err(RuntimeError::RequestConflict.into()),
            };
            self.write_with_durability(WriteBatch::default(), Durability::Sync)?;
            result.reused = true;
            return Ok(result);
        }
        let mut state = self.read_session(session_id)?;
        ensure_epoch(&state, epoch)?;
        ensure_revision(&state, revision)?;
        if state.active_run_id.as_deref() != Some(run_id) {
            return Err(RuntimeError::InvalidCommand("run is not active".into()).into());
        }
        let bytes = self
            .get(CF_RUNS, run_key(session_id, run_id).as_bytes())?
            .ok_or_else(|| RuntimeError::InvalidCommand("active run is missing".into()))?;
        let mut run: StoredRun = serde_json::from_slice(&bytes)?;
        let mut projection = self.read_ui_projection(session_id)?;
        let projected_document = projection
            .as_ref()
            .filter(|projection| projection.run["id"].as_str() == Some(run_id))
            .map(|projection| projection.run.clone());
        let previous_reason = projection
            .as_ref()
            .map(|projection| projection.session["blockedReason"].clone())
            .unwrap_or(serde_json::Value::Null);
        let completion = crate::completion::complete(
            run_id,
            status,
            supplied.or(projected_document).or(run.document.clone()),
            previous_reason,
        )?;
        let previous_retained = state.retained_from;
        state.active_run_id = None;
        state.epoch += 1;
        state.revision += 1;
        state.cursor += 1;
        state.retained_from = state.cursor.saturating_sub(EVENT_RETENTION) + 1;
        state.producer_sequences.clear();
        run.terminal_status = Some(status.into());
        run.revision = state.revision;
        run.document = completion.document;
        if let Some(projection) = projection.as_mut() {
            projection.apply(state.cursor, run_id, &completion.event)?;
            projection.session["completedAt"] = serde_json::json!(completion.completed_at);
        }
        let event = StreamEvent {
            sequence: state.cursor,
            run_id: run_id.into(),
            kind: completion.event.kind,
            payload: completion.event.payload,
            ephemeral: false,
        };
        let result = FinishReceipt {
            snapshot: state.snapshot(),
            event: Some(event.clone()),
            reused: false,
        };
        let mut batch = WriteBatch::default();
        self.put_batch(
            &mut batch,
            CF_SESSIONS,
            session_key(session_id),
            &serde_json::to_vec(&state)?,
        )?;
        self.put_batch(
            &mut batch,
            CF_RUNS,
            run_key(session_id, run_id),
            &serde_json::to_vec(&run)?,
        )?;
        self.put_batch(
            &mut batch,
            CF_STREAMS,
            stream_key(session_id, state.cursor),
            &serde_json::to_vec(&event)?,
        )?;
        self.put_batch(
            &mut batch,
            CF_TRANSITIONS,
            key,
            &serde_json::to_vec(&StoredFinish {
                identity,
                result: result.clone(),
            })?,
        )?;
        if let Some(projection) = projection {
            self.put_batch(
                &mut batch,
                CF_UI,
                session_key(session_id),
                &projection.encode()?,
            )?;
        }
        for sequence in previous_retained..state.retained_from {
            batch.delete_cf(self.cf(CF_STREAMS)?, stream_key(session_id, sequence));
        }
        self.write_with_durability(batch, Durability::Sync)?;
        if self.faults.abort_after_finish {
            std::process::abort();
        }
        Ok(result)
    }

    pub fn compact_stream(&self, session_id: &str) -> Result<(), StorageError> {
        let cf = self.cf(CF_STREAMS)?;
        let start = format!("e/{session_id}/");
        let end = format!("e/{session_id}/\u{10ffff}");
        self.db
            .compact_range_cf(cf, Some(start.as_bytes()), Some(end.as_bytes()));
        Ok(())
    }

    pub fn receipt(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> Result<Option<RunAdmission>, StorageError> {
        let key = receipt_key(session_id, request_id);
        let Some(bytes) = self.get(CF_RECEIPTS, key.as_bytes())? else {
            return Ok(None);
        };
        let receipt: StoredReceipt = serde_json::from_slice(&bytes)?;
        Ok(Some(receipt.admission))
    }

    pub fn append_stream(
        &self,
        session_id: &str,
        run_id: &str,
        producer_id: &str,
        producer_sequence: u64,
        epoch: u64,
        events: Vec<PendingEvent>,
    ) -> Result<StreamAppendReceipt, StorageError> {
        self.append_stream_with_durability(
            session_id,
            run_id,
            producer_id,
            producer_sequence,
            epoch,
            Durability::Sync,
            events,
        )
    }

    pub fn append_stream_with_durability(
        &self,
        session_id: &str,
        run_id: &str,
        producer_id: &str,
        producer_sequence: u64,
        epoch: u64,
        durability: Durability,
        events: Vec<PendingEvent>,
    ) -> Result<StreamAppendReceipt, StorageError> {
        if events.len() > 256
            || events.iter().any(|event| {
                event.payload.len() + event.kind.len() + run_id.len() > 1024 * 1024 - 8192
            })
        {
            return Err(RuntimeError::InvalidCommand(
                "stream batch exceeds event or frame budget".into(),
            )
            .into());
        }
        if events.is_empty() {
            return Err(
                RuntimeError::InvalidCommand("stream batch cannot be empty".to_owned()).into(),
            );
        }
        let key = serde_json::to_vec(&(session_id, run_id, epoch, producer_id, producer_sequence))?;
        let fingerprint = append_fingerprint(
            session_id,
            run_id,
            producer_id,
            producer_sequence,
            epoch,
            durability,
            &events,
        );
        if let Some(bytes) = self.get(CF_APPENDS, &key)? {
            let saved: StoredAppendReceipt = serde_json::from_slice(&bytes)?;
            if saved.fingerprint != fingerprint {
                return Err(RuntimeError::RequestConflict.into());
            }
            self.write_with_durability(WriteBatch::default(), Durability::Sync)?;
            let mut receipt = saved.receipt;
            receipt.reused = true;
            return Ok(receipt);
        }
        let mut state = self.read_session(session_id)?;
        ensure_epoch(&state, epoch)?;
        if state.active_run_id.as_deref() != Some(run_id) {
            return Err(RuntimeError::InvalidCommand("run is not active".into()).into());
        }
        let expected = state
            .producer_sequences
            .get(producer_id)
            .copied()
            .unwrap_or(0)
            + 1;
        if producer_sequence < expected {
            return Err(RuntimeError::ProducerSequenceReplay {
                expected,
                actual: producer_sequence,
            }
            .into());
        }
        if producer_sequence > expected {
            return Err(RuntimeError::ProducerSequenceGap {
                expected,
                actual: producer_sequence,
            }
            .into());
        }
        state
            .producer_sequences
            .insert(producer_id.to_owned(), producer_sequence);
        let first_sequence = state.cursor + 1;
        let mut batch = WriteBatch::default();
        let mut projection = self.read_ui_projection(session_id)?;
        for pending in events {
            state.cursor += 1;
            if let Some(projection) = projection.as_mut() {
                projection.apply(state.cursor, run_id, &pending)?;
            }
            let event = StreamEvent {
                sequence: state.cursor,
                run_id: run_id.to_owned(),
                kind: pending.kind,
                payload: pending.payload,
                ephemeral: false,
            };
            self.put_batch(
                &mut batch,
                CF_STREAMS,
                stream_key(session_id, state.cursor),
                &serde_json::to_vec(&event)?,
            )?;
            self.put_batch(
                &mut batch,
                CF_HISTORY_OUTBOX,
                history_outbox_key(session_id, state.cursor),
                &serde_json::to_vec(&event)?,
            )?;
        }
        let previous_retained_from = state.retained_from;
        state.retained_from = state.cursor.saturating_sub(EVENT_RETENTION) + 1;
        let delete_until = state.retained_from.saturating_sub(1);
        for sequence in previous_retained_from..=delete_until {
            batch.delete_cf(self.cf(CF_STREAMS)?, stream_key(session_id, sequence));
        }
        self.put_batch(
            &mut batch,
            CF_SESSIONS,
            session_key(session_id),
            &serde_json::to_vec(&state)?,
        )?;
        let receipt = StreamAppendReceipt {
            reused: false,
            session_id: session_id.to_owned(),
            run_id: run_id.to_owned(),
            first_sequence,
            last_sequence: state.cursor,
            epoch: state.epoch,
        };
        self.put_batch(
            &mut batch,
            CF_APPENDS,
            key,
            &serde_json::to_vec(&StoredAppendReceipt {
                fingerprint,
                receipt: receipt.clone(),
            })?,
        )?;
        if let Some(projection) = projection {
            self.put_batch(
                &mut batch,
                CF_UI,
                session_key(session_id),
                &projection.encode()?,
            )?;
        }
        self.write_with_durability(batch, durability)?;
        if self.faults.abort_after_append {
            std::process::abort();
        }
        Ok(receipt)
    }

    pub fn replay(&self, session_id: &str, after: u64) -> Result<Vec<StreamEvent>, StorageError> {
        self.replay_bounded(session_id, after, EVENT_RETENTION as usize, 4 * 1024 * 1024)
    }

    fn history_outbox(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<StreamEvent>, StorageError> {
        let prefix = format!("o/{session_id}/");
        let acked_through = self.history_outbox_acked_through(session_id)?;
        let mut items = Vec::new();
        for entry in self.db.iterator_cf(
            self.cf(CF_HISTORY_OUTBOX)?,
            rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward),
        ) {
            let (key, value) = entry?;
            if !key.starts_with(prefix.as_bytes()) || items.len() >= limit {
                break;
            }
            let Some(sequence) = history_outbox_sequence(&key) else {
                continue;
            };
            if sequence <= acked_through {
                continue;
            }
            items.push(serde_json::from_slice::<StreamEvent>(&value)?);
        }
        Ok(items)
    }

    fn history_outbox_sessions(
        &self,
        start_after: Option<&str>,
        limit: usize,
    ) -> Result<HistoryOutboxSessionPage, StorageError> {
        let limit = limit.min(4096);
        if limit == 0 {
            return Ok(HistoryOutboxSessionPage::default());
        }
        let prefix = b"o/";
        let start = start_after
            .map(|key| key.as_bytes())
            .unwrap_or(prefix);
        let mut session_ids = Vec::with_capacity(limit);
        let mut seen = std::collections::HashSet::with_capacity(limit);
        for entry in self.db.iterator_cf(
            self.cf(CF_HISTORY_OUTBOX)?,
            rocksdb::IteratorMode::From(start, rocksdb::Direction::Forward),
        ) {
            let (key, _) = entry?;
            if !key.starts_with(prefix) {
                break;
            }
            if start_after.is_some_and(|cursor| key.as_ref() <= cursor.as_bytes()) {
                continue;
            }
            let Some(rest) = key.strip_prefix(prefix) else {
                continue;
            };
            let Some(separator) = rest.iter().position(|byte| *byte == b'/') else {
                continue;
            };
            let session_id = String::from_utf8_lossy(&rest[..separator]).into_owned();
            if session_id.is_empty() || !seen.insert(session_id.clone()) {
                continue;
            }
            session_ids.push(session_id);
            if session_ids.len() >= limit {
                return Ok(HistoryOutboxSessionPage {
                    session_ids,
                    next_key: Some(String::from_utf8_lossy(&key).into_owned()),
                });
            }
        }
        Ok(HistoryOutboxSessionPage {
            session_ids,
            next_key: None,
        })
    }

    fn history_outbox_ack(&self, session_id: &str, through: u64) -> Result<(), StorageError> {
        let state = self.read_session(session_id)?;
        if through > state.cursor {
            return Err(RuntimeError::InvalidCommand(
                "history outbox acknowledgement exceeds stream cursor".into(),
            )
            .into());
        }
        let current = self.history_outbox_acked_through(session_id)?;
        let next = current.max(through);
        let mut batch = WriteBatch::default();
        self.put_batch(
            &mut batch,
            CF_HISTORY_OUTBOX,
            history_outbox_ack_key(session_id),
            &next.to_be_bytes(),
        )?;
        self.write_with_durability(batch, Durability::Sync)
    }

    fn history_outbox_maintain(
        &self,
        session_id: &str,
        max_entries: usize,
    ) -> Result<HistoryOutboxMaintenance, StorageError> {
        let max_entries = max_entries.min(HISTORY_OUTBOX_MAINTENANCE_BATCH);
        let acked_through = self.history_outbox_acked_through(session_id)?;
        let prefix = format!("o/{session_id}/");
        let mut batch = WriteBatch::default();
        let mut removed = 0usize;
        let mut has_more_acked = false;
        for entry in self.db.iterator_cf(
            self.cf(CF_HISTORY_OUTBOX)?,
            rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward),
        ) {
            let (key, _) = entry?;
            if !key.starts_with(prefix.as_bytes()) {
                break;
            }
            let Some(sequence) = history_outbox_sequence(&key) else {
                continue;
            };
            if sequence > acked_through {
                break;
            }
            if removed < max_entries {
                batch.delete_cf(self.cf(CF_HISTORY_OUTBOX)?, key);
                removed += 1;
            } else {
                has_more_acked = true;
                break;
            }
        }
        if removed > 0 {
            self.write_with_durability(batch, Durability::Sync)?;
        }
        Ok(HistoryOutboxMaintenance {
            acked_through,
            removed,
            has_more_acked,
        })
    }

    fn history_outbox_acked_through(&self, session_id: &str) -> Result<u64, StorageError> {
        let Some(bytes) = self.get(
            CF_HISTORY_OUTBOX,
            history_outbox_ack_key(session_id).as_bytes(),
        )?
        else {
            return Ok(0);
        };
        if bytes.len() != std::mem::size_of::<u64>() {
            return Err(RuntimeError::StorageUnavailable(
                "invalid history outbox acknowledgement watermark".into(),
            )
            .into());
        }
        let mut raw = [0u8; std::mem::size_of::<u64>()];
        raw.copy_from_slice(&bytes);
        Ok(u64::from_be_bytes(raw))
    }

    fn replay_bounded(
        &self,
        session_id: &str,
        after: u64,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<Vec<StreamEvent>, StorageError> {
        let state = self.read_session(session_id)?;
        if after > 0 && after + 1 < state.retained_from {
            return Err(RuntimeError::CursorExpired {
                after,
                retained_from: state.retained_from,
            }
            .into());
        }
        let mut events = Vec::new();
        let mut remaining = max_bytes;
        let start = after.max(state.retained_from.saturating_sub(1)) + 1;
        for sequence in start..=state.cursor {
            let Some(bytes) = self.get(CF_STREAMS, stream_key(session_id, sequence).as_bytes())?
            else {
                return Err(
                    RuntimeError::StorageUnavailable("retained event is missing".into()).into(),
                );
            };
            let event: StreamEvent = serde_json::from_slice(&bytes)?;
            let cost = event.payload.len() + event.run_id.len() + event.kind.len() + 32;
            if events.len() >= max_events || cost > remaining {
                break;
            }
            remaining -= cost;
            events.push(event);
        }
        Ok(events)
    }

    fn read_session(&self, session_id: &str) -> Result<StoredSession, StorageError> {
        let Some(bytes) = self.get(CF_SESSIONS, session_key(session_id).as_bytes())? else {
            return Ok(StoredSession::new(session_id.to_owned()));
        };
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn read_control_state(&self, session_id: &str) -> Result<ControlState, StorageError> {
        let Some(bytes) = self.get(CF_CONTROLS, control_state_key(session_id).as_bytes())? else {
            return Ok(ControlState::default());
        };
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn session_list(&self) -> Result<Vec<u8>, StorageError> {
        let mut items = Vec::new();
        for entry in self
            .db
            .iterator_cf(self.cf(CF_UI)?, rocksdb::IteratorMode::Start)
        {
            let (_, value) = entry?;
            let projection: UiSnapshot = serde_json::from_slice(&value)?;
            items.push(projection.session);
        }
        Ok(serde_json::to_vec(&serde_json::json!({"items": items}))?)
    }

    fn import_ui_projection(
        &self,
        session_id: &str,
        snapshot_json: &[u8],
    ) -> Result<Vec<u8>, StorageError> {
        let projection: UiSnapshot = serde_json::from_slice(snapshot_json)
            .map_err(|_| RuntimeError::InvalidCommand("invalid UI projection import".into()))?;
        if projection.session["id"].as_str() != Some(session_id) {
            return Err(RuntimeError::InvalidCommand(
                "projection session identity mismatch".into(),
            )
            .into());
        }
        let bytes = projection.encode()?;
        if let Some(existing) = self.get(CF_UI, session_key(session_id).as_bytes())? {
            if existing != bytes {
                return Err(RuntimeError::RequestConflict.into());
            }
            return Ok(existing);
        }
        let mut state = self.read_session(session_id)?;
        state.active_run_id = projection.session["activeRunId"]
            .as_str()
            .map(str::to_owned);
        state.cursor = projection.cursor;
        state.retained_from = projection.cursor.saturating_sub(EVENT_RETENTION) + 1;
        state.revision = state.revision.max(projection.cursor);
        let mut batch = WriteBatch::default();
        self.put_batch(&mut batch, CF_UI, session_key(session_id), &bytes)?;
        self.put_batch(
            &mut batch,
            CF_SESSIONS,
            session_key(session_id),
            &serde_json::to_vec(&state)?,
        )?;
        self.write_with_durability(batch, Durability::Sync)?;
        Ok(bytes)
    }

    fn import_stream(&self, session_id: &str, events_json: &[u8]) -> Result<Vec<u8>, StorageError> {
        let pending: Vec<PendingEvent> = serde_json::from_slice(events_json)
            .map_err(|_| RuntimeError::InvalidCommand("invalid stream import JSON".into()))?;
        if pending.is_empty() || pending.len() > 1024 || events_json.len() > 4 * 1024 * 1024 {
            return Err(RuntimeError::InvalidCommand("stream import exceeds bounds".into()).into());
        }
        let mut state = self.read_session(session_id)?;
        if state.cursor != 0 {
            return Err(RuntimeError::RequestConflict.into());
        }
        let mut projection = self
            .read_ui_projection(session_id)?
            .ok_or(RuntimeError::ProjectionMissing)?;
        let mut batch = WriteBatch::default();
        for item in pending {
            let value: serde_json::Value = serde_json::from_slice(&item.payload)?;
            let run_id = value["chunk"]["runId"]
                .as_str()
                .or_else(|| value["chunk"]["run"]["id"].as_str())
                .or_else(|| projection.session["activeRunId"].as_str())
                .unwrap_or("")
                .to_owned();
            state.cursor += 1;
            projection.apply(state.cursor, &run_id, &item)?;
            let event = StreamEvent {
                sequence: state.cursor,
                run_id,
                kind: item.kind,
                payload: item.payload,
                ephemeral: false,
            };
            self.put_batch(
                &mut batch,
                CF_STREAMS,
                stream_key(session_id, state.cursor),
                &serde_json::to_vec(&event)?,
            )?;
        }
        state.revision = state.revision.max(state.cursor);
        state.retained_from = state.cursor.saturating_sub(EVENT_RETENTION) + 1;
        for sequence in 1..state.retained_from {
            batch.delete_cf(self.cf(CF_STREAMS)?, stream_key(session_id, sequence));
        }
        self.put_batch(
            &mut batch,
            CF_SESSIONS,
            session_key(session_id),
            &serde_json::to_vec(&state)?,
        )?;
        self.put_batch(
            &mut batch,
            CF_UI,
            session_key(session_id),
            &projection.encode()?,
        )?;
        self.write_with_durability(batch, Durability::Sync)?;
        Ok(serde_json::to_vec(&projection)?)
    }

    fn cf(&self, name: &str) -> Result<&rocksdb::ColumnFamily, StorageError> {
        self.db
            .cf_handle(name)
            .ok_or_else(|| StorageError::MissingColumnFamily(name.to_owned()))
    }

    fn get(&self, cf: &str, key: &[u8]) -> Result<Option<Vec<u8>>, StorageError> {
        Ok(self.db.get_cf(self.cf(cf)?, key)?)
    }

    fn put_batch(
        &self,
        batch: &mut WriteBatch,
        cf: &str,
        key: impl AsRef<[u8]>,
        value: &[u8],
    ) -> Result<(), StorageError> {
        batch.put_cf(self.cf(cf)?, key, value);
        Ok(())
    }

    fn write_with_durability(
        &self,
        batch: WriteBatch,
        durability: Durability,
    ) -> Result<(), StorageError> {
        if matches!(durability, Durability::Ephemeral) {
            return Err(RuntimeError::InvalidCommand(
                "ephemeral events require the live-only channel".into(),
            )
            .into());
        }
        if self.faults.disk_full {
            return Err(StorageError::DiskFull);
        }
        if let Err(error) = self
            .committer
            .commit(batch, matches!(durability, Durability::Sync))
        {
            let message = error.to_string().to_ascii_lowercase();
            if message.contains("no space") || message.contains("disk full") {
                return Err(StorageError::DiskFull);
            }
            return Err(if error.starts_with("DURABILITY_UNKNOWN:") {
                RuntimeError::DurabilityUnknown(error)
            } else {
                RuntimeError::StorageUnavailable(error)
            }
            .into());
        }
        if self.faults.abort_after_commit {
            std::process::abort();
        }
        if self.faults.ack_unknown_after_commit {
            return Err(RuntimeError::DurabilityUnknown(
                "injected acknowledgement loss".to_owned(),
            )
            .into());
        }
        Ok(())
    }
}

fn ensure_epoch(state: &StoredSession, epoch: u64) -> Result<(), StorageError> {
    if state.epoch == epoch {
        Ok(())
    } else {
        Err(RuntimeError::StaleEpoch {
            expected: state.epoch,
            actual: epoch,
        }
        .into())
    }
}

fn ensure_revision(state: &StoredSession, expected: u64) -> Result<(), StorageError> {
    if state.revision == expected {
        Ok(())
    } else {
        Err(RuntimeError::RevisionConflict {
            expected,
            actual: state.revision,
        }
        .into())
    }
}

fn session_key(session_id: &str) -> String {
    format!("s/{session_id}")
}

fn receipt_key(session_id: &str, request_id: &str) -> String {
    format!("i/{session_id}/{request_id}")
}

fn run_key(session_id: &str, run_id: &str) -> String {
    format!("r/{session_id}/{run_id}")
}

fn stream_key(session_id: &str, sequence: u64) -> String {
    format!("e/{session_id}/{sequence:020}")
}

fn history_outbox_key(session_id: &str, sequence: u64) -> String {
    format!("o/{session_id}/{sequence:020}")
}

fn history_outbox_ack_key(session_id: &str) -> String {
    format!("a/{session_id}")
}

fn history_outbox_sequence(key: &[u8]) -> Option<u64> {
    String::from_utf8_lossy(key)
        .rsplit('/')
        .next()
        .and_then(|value| value.parse::<u64>().ok())
}

fn control_state_key(session_id: &str) -> String {
    format!("state/{session_id}")
}

fn control_receipt_key(session_id: &str, request_id: &str) -> String {
    format!("command/{session_id}/{request_id}")
}

fn required_string<'a>(value: &'a serde_json::Value, key: &str) -> Result<&'a str, StorageError> {
    value[key]
        .as_str()
        .filter(|item| !item.is_empty())
        .ok_or_else(|| RuntimeError::InvalidCommand(format!("{key} is required")).into())
}

fn set_projection_state(
    projection: &mut UiSnapshot,
    status: &str,
    active_run_id: Option<&str>,
    pending_resume_token: Option<&str>,
    blocked_reason: Option<&str>,
    updated_at: &str,
) {
    projection.session["status"] = serde_json::json!(status);
    projection.session["activeRunId"] = active_run_id
        .map(serde_json::Value::from)
        .unwrap_or(serde_json::Value::Null);
    projection.session["pendingResumeToken"] = pending_resume_token
        .map(serde_json::Value::from)
        .unwrap_or(serde_json::Value::Null);
    projection.session["blockedReason"] = blocked_reason
        .map(serde_json::Value::from)
        .unwrap_or(serde_json::Value::Null);
    projection.session["updatedAt"] = serde_json::json!(updated_at);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "synax-runtime-hot-{label}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn event(kind: &str) -> PendingEvent {
        PendingEvent {
            kind: kind.to_owned(),
            payload: kind.as_bytes().to_vec(),
        }
    }

    fn ui_seed() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "id":"s", "projectId":"p", "status":"queued", "updatedAt":"2026-10-16" })).unwrap()
    }
    fn ui_event(chunk: serde_json::Value) -> PendingEvent {
        PendingEvent { kind: chunk["type"].as_str().unwrap().into(), payload: serde_json::to_vec(&serde_json::json!({ "schema":1, "chunk":chunk,
            "state":{"status":"running","activeRunId":"r","pendingResumeToken":null,"blockedReason":null,"updatedAt":"2026-10-16"} })).unwrap() }
    }
    fn ui_read(store: &HotStore) -> UiSnapshot {
        serde_json::from_slice(&store.ui_snapshot("s", None).unwrap()).unwrap()
    }

    #[test]
    fn materialized_snapshot_retains_the_full_live_step_after_event_retention_and_restart() {
        let path = temp_path("projection-retention");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        for batch in 0..8 {
            let events = (0..200).map(|index| {
                if batch == 0 && index == 0 { ui_event(serde_json::json!({"type":"step_started","step":{"id":"step","sessionId":"s","runId":"r","index":1}})) }
                else { ui_event(serde_json::json!({"type":"message_delta","stepId":"step","runId":"r","delta":"x"})) }
            }).collect();
            store
                .append_stream_with_durability(
                    "s",
                    "r",
                    "p",
                    batch + 1,
                    1,
                    Durability::GroupCommit,
                    events,
                )
                .unwrap();
        }
        assert_eq!(store.snapshot("s").unwrap().retained_from, 577);
        let projection = ui_read(&store);
        assert_eq!(projection.cursor, 1600);
        assert_eq!(projection.live_chunks.len(), 2);
        assert_eq!(
            projection.live_chunks[1]["delta"].as_str().unwrap().len(),
            1599
        );
        drop(store);
        let store = HotStore::open(&path).unwrap();
        assert_eq!(ui_read(&store), projection);
        // Seed retries are create-if-absent: stale SQL cannot overwrite persisted state.
        assert_eq!(
            serde_json::from_slice::<UiSnapshot>(
                &store.ui_snapshot("s", Some(&ui_seed())).unwrap()
            )
            .unwrap(),
            projection
        );
        store
            .finish_run("s", "finish", "r", "completed", 1, 1)
            .unwrap();
        let completed = ui_read(&store);
        assert_eq!(completed.session["status"], "completed");
        assert!(completed.session["activeRunId"].is_null());
        assert!(completed.live_chunks.is_empty());
        assert_eq!(completed.cursor, 1601);
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn activation_is_idempotent_and_persists_a_command_event_before_provider_output() {
        let path = temp_path("activation");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        let admission = store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        let run = serde_json::json!({
            "id":"r", "sessionId":"s", "status":"queued", "startedAt":"2026-10-16T00:00:00Z",
            "completedAt":null, "metadata":{}
        });
        let first = store
            .activate_run(
                "s",
                "activate:req",
                &serde_json::to_vec(&run).unwrap(),
                admission.epoch,
                admission.revision,
            )
            .unwrap();
        assert!(!first.reused);
        assert_eq!(first.event.kind, "run_activated");
        assert_eq!(first.snapshot.cursor, 1);
        assert_eq!(first.snapshot.revision, 2);
        assert_eq!(
            serde_json::from_slice::<UiSnapshot>(&store.ui_snapshot("s", None).unwrap())
                .unwrap()
                .run["status"],
            "running"
        );
        let retry = store
            .activate_run(
                "s",
                "activate:req",
                &serde_json::to_vec(&run).unwrap(),
                admission.epoch,
                admission.revision,
            )
            .unwrap();
        assert!(retry.reused);
        assert_eq!(store.replay("s", 0).unwrap().len(), 1);
        let changed = serde_json::json!({ "id":"r", "sessionId":"s", "status":"queued", "startedAt":"2026-10-16T00:00:01Z" });
        assert!(matches!(
            store.activate_run(
                "s",
                "activate:req",
                &serde_json::to_vec(&changed).unwrap(),
                admission.epoch,
                admission.revision
            ),
            Err(StorageError::Runtime(RuntimeError::RequestConflict))
        ));
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn projection_validation_failure_rolls_back_events_sequence_and_receipt() {
        let path = temp_path("projection-reject");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        let invalid = ui_event(
            serde_json::json!({"type":"step_started","step":{"id":"step","sessionId":"wrong","runId":"r"}}),
        );
        assert!(
            store
                .append_stream("s", "r", "p", 1, 1, vec![invalid])
                .is_err()
        );
        assert_eq!(store.snapshot("s").unwrap().cursor, 0);
        assert_eq!(ui_read(&store).cursor, 0);
        assert!(store.replay("s", 0).unwrap().is_empty());
        store
            .append_stream(
                "s",
                "r",
                "p",
                1,
                1,
                vec![ui_event(serde_json::json!({"type":"event"}))],
            )
            .unwrap();
        assert_eq!(ui_read(&store).cursor, 1);
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn projection_and_receipt_survive_unknown_ack_without_double_applying_delta() {
        let path = temp_path("projection-unknown-ack");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        let batch = vec![
            ui_event(
                serde_json::json!({"type":"step_started","step":{"id":"step","sessionId":"s","runId":"r"}}),
            ),
            ui_event(serde_json::json!({"type":"message_delta","stepId":"step","delta":"once"})),
        ];
        let mut faulty = store.clone();
        faulty.faults.ack_unknown_after_commit = true;
        assert!(matches!(
            faulty.append_stream("s", "r", "p", 1, 1, batch.clone()),
            Err(StorageError::Runtime(RuntimeError::DurabilityUnknown(_)))
        ));
        drop(faulty);
        drop(store);
        let store = HotStore::open(&path).unwrap();
        assert!(
            store
                .append_stream("s", "r", "p", 1, 1, batch)
                .unwrap()
                .reused
        );
        let projection = ui_read(&store);
        assert_eq!(projection.cursor, 2);
        assert_eq!(projection.live_chunks[1]["delta"], "once");
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn oversized_projection_rejects_the_batch_without_advancing_durable_cursor() {
        let path = temp_path("projection-size");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        store.append_stream("s", "r", "p", 1, 1, vec![ui_event(serde_json::json!({"type":"step_started","step":{"id":"step","sessionId":"s","runId":"r"}}))]).unwrap();
        let large = ui_event(
            serde_json::json!({"type":"message_delta","stepId":"step","delta":"x".repeat(crate::projection::MAX_PROJECTION_BYTES)}),
        );
        assert!(matches!(
            store.append_stream("s", "r", "p", 2, 1, vec![large]),
            Err(StorageError::Runtime(RuntimeError::ProjectionTooLarge))
        ));
        assert_eq!(store.snapshot("s").unwrap().cursor, 1);
        assert_eq!(ui_read(&store).cursor, 1);
        store
            .append_stream(
                "s",
                "r",
                "p",
                2,
                1,
                vec![ui_event(
                    serde_json::json!({"type":"message_delta","stepId":"step","delta":"valid"}),
                )],
            )
            .unwrap();
        assert_eq!(ui_read(&store).live_chunks[1]["delta"], "valid");
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn existing_unprojected_runs_require_migration_instead_of_an_invented_snapshot() {
        let path = temp_path("projection-migration");
        let store = HotStore::open(&path).unwrap();
        store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        assert!(matches!(
            store.ui_snapshot("s", Some(&ui_seed())),
            Err(StorageError::Runtime(
                RuntimeError::ProjectionMigrationRequired
            ))
        ));
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn admission_persists_the_queued_run_document_in_projection_and_survives_reopen() {
        let path = temp_path("admission-run-document");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        let run = serde_json::json!({
            "id": "r",
            "sessionId": "s",
            "status": "queued",
            "startedAt": "2026-10-17T00:00:00Z",
            "completedAt": null,
            "metadata": {"runtime": {"requestId": "req"}}
        });
        store
            .admit_run_with_document(
                "s",
                "req",
                "body",
                "r",
                1,
                0,
                &[],
                &serde_json::to_vec(&run).unwrap(),
            )
            .unwrap();
        assert_eq!(ui_read(&store).run, run);
        drop(store);
        let reopened = HotStore::open(&path).unwrap();
        assert_eq!(ui_read(&reopened).run["id"], "r");
        drop(reopened);
        let _ = std::fs::remove_dir_all(path);
    }

    fn queued_item(id: &str) -> serde_json::Value {
        serde_json::json!({"id":id,"message":id,"enqueuedAt":"2026-10-16T00:00:00Z"})
    }

    #[test]
    fn queued_admission_consumption_is_atomic_idempotent_and_survives_reopen() {
        let path = temp_path("queued-admit");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        let item = queued_item("input");
        let bytes = serde_json::to_vec(&item).unwrap();
        store
            .queue_mutation("s", "enqueue", 1, 0, "enqueue", &bytes)
            .unwrap();
        let mut failed = store.clone();
        failed.faults.disk_full = true;
        assert!(matches!(
            failed.admit_run_with_queue("s", "admit", "hash", "r", 1, 1, &bytes),
            Err(StorageError::DiskFull)
        ));
        assert_eq!(ui_read(&store).queued_inputs, vec![item.clone()]);
        assert!(store.receipt("s", "admit").unwrap().is_none());
        failed.faults.disk_full = false;
        failed.faults.ack_unknown_after_commit = true;
        assert!(matches!(
            failed.admit_run_with_queue("s", "admit", "hash", "r", 1, 1, &bytes),
            Err(StorageError::Runtime(RuntimeError::DurabilityUnknown(_)))
        ));
        drop(failed);
        drop(store);
        let store = HotStore::open(&path).unwrap();
        let retry = store
            .admit_run_with_queue("s", "admit", "hash", "r", 1, 1, &bytes)
            .unwrap();
        assert!(retry.reused);
        assert_eq!(store.snapshot("s").unwrap().cursor, 2);
        assert_eq!(
            store.snapshot("s").unwrap().active_run_id.as_deref(),
            Some("r")
        );
        assert!(ui_read(&store).queued_inputs.is_empty());
        assert!(ui_read(&store).pending_queue_input.is_none());
        assert_eq!(store.replay("s", 0).unwrap().len(), 2);
        let mut changed = item;
        changed["message"] = serde_json::json!("changed");
        assert!(matches!(
            store.admit_run_with_queue(
                "s",
                "admit",
                "hash",
                "r",
                1,
                1,
                &serde_json::to_vec(&changed).unwrap()
            ),
            Err(StorageError::Runtime(RuntimeError::RequestConflict))
        ));
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn forced_delivery_and_ack_are_durable_and_fenced() {
        let path = temp_path("queued-delivery");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        store.admit_run("s", "admit", "hash", "r", 1, 0).unwrap();
        store
            .queue_mutation(
                "s",
                "enqueue",
                1,
                1,
                "enqueue",
                &serde_json::to_vec(&queued_item("q")).unwrap(),
            )
            .unwrap();
        store
            .queue_mutation("s", "force", 1, 2, "force", br#"{"id":"q"}"#)
            .unwrap();
        assert!(
            store
                .queue_mutation(
                    "s",
                    "wrong",
                    1,
                    3,
                    "consume",
                    br#"{"id":"q","runId":"wrong"}"#
                )
                .is_err()
        );
        let receipt = store
            .queue_mutation(
                "s",
                "consume",
                1,
                3,
                "consume",
                br#"{"id":"q","runId":"r"}"#,
            )
            .unwrap();
        assert_eq!(receipt.queue.consumed.unwrap()["id"], "q");
        assert!(receipt.queue.items.is_empty());
        drop(store);
        let store = HotStore::open(&path).unwrap();
        assert_eq!(
            ui_read(&store).pending_queue_input.as_ref().unwrap()["item"]["id"],
            "q"
        );
        assert!(
            store
                .queue_mutation(
                    "s",
                    "wrong-ack",
                    1,
                    4,
                    "ack_consume",
                    br#"{"id":"q","runId":"wrong"}"#
                )
                .is_err()
        );
        store
            .queue_mutation(
                "s",
                "ack",
                1,
                4,
                "ack_consume",
                br#"{"id":"q","runId":"r"}"#,
            )
            .unwrap();
        assert!(
            store
                .queue_mutation(
                    "s",
                    "ack",
                    1,
                    4,
                    "ack_consume",
                    br#"{"id":"q","runId":"r"}"#
                )
                .unwrap()
                .reused
        );
        assert!(ui_read(&store).pending_queue_input.is_none());
        assert_eq!(store.snapshot("s").unwrap().cursor, 4);
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn queue_bounds_conflicts_and_noops_do_not_change_committed_state() {
        let path = temp_path("queue-bounds");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        for index in 0..20 {
            store
                .queue_mutation(
                    "s",
                    &format!("e{index}"),
                    1,
                    index,
                    "enqueue",
                    &serde_json::to_vec(&queued_item(&format!("q{index}"))).unwrap(),
                )
                .unwrap();
        }
        assert!(
            store
                .queue_mutation(
                    "s",
                    "full",
                    1,
                    20,
                    "enqueue",
                    &serde_json::to_vec(&queued_item("q20")).unwrap()
                )
                .is_err()
        );
        assert!(
            store
                .queue_mutation(
                    "s",
                    "bad-id",
                    1,
                    20,
                    "enqueue",
                    br#"{"id":"","message":"x","enqueuedAt":"2026-10-16T00:00:00Z"}"#
                )
                .is_err()
        );
        let boundary = store
            .queue_mutation(
                "s",
                "boundary",
                1,
                20,
                "move",
                br#"{"id":"q0","direction":"up"}"#,
            )
            .unwrap();
        assert!(boundary.event.is_none());
        assert_eq!(boundary.snapshot.cursor, 20);
        assert!(matches!(
            store.queue_mutation(
                "s",
                "e0",
                1,
                0,
                "enqueue",
                &serde_json::to_vec(&queued_item("changed")).unwrap()
            ),
            Err(StorageError::Runtime(RuntimeError::RequestConflict))
        ));
        assert_eq!(ui_read(&store).queued_inputs.len(), 20);
        assert_eq!(store.snapshot("s").unwrap().revision, 20);
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn queue_command_is_persisted_fenced_and_idempotent_across_reopen() {
        let path = temp_path("queue-command");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        let item = serde_json::json!({ "id":"inq_1", "message":"queued", "enqueuedAt":"2026-10-16T00:00:00Z" });
        let first = store
            .queue_mutation_async(
                "s".into(),
                "q1".into(),
                1,
                0,
                "enqueue".into(),
                serde_json::to_vec(&item).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.queue.items.len(), 1);
        let retry = store
            .queue_mutation_async(
                "s".into(),
                "q1".into(),
                1,
                0,
                "enqueue".into(),
                serde_json::to_vec(&item).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(retry.queue, first.queue);
        drop(store);
        let store = HotStore::open(&path).unwrap();
        let moved = store
            .queue_mutation_async(
                "s".into(),
                "q2".into(),
                1,
                1,
                "force".into(),
                br#"{"id":"inq_1"}"#.to_vec(),
            )
            .await
            .unwrap();
        assert_eq!(moved.queue.force_inject_item_id.as_deref(), Some("inq_1"));
        assert_eq!(
            store
                .queue_mutation_async(
                    "s".into(),
                    "q2".into(),
                    1,
                    1,
                    "force".into(),
                    br#"{"id":"inq_1"}"#.to_vec()
                )
                .await
                .unwrap()
                .queue
                .force_inject_item_id
                .as_deref(),
            Some("inq_1")
        );
        assert!(matches!(
            store
                .queue_mutation_async(
                    "s".into(),
                    "q3".into(),
                    1,
                    1,
                    "remove".into(),
                    br#"{"id":"inq_1"}"#.to_vec()
                )
                .await,
            Err(StorageError::Runtime(RuntimeError::RevisionConflict { .. }))
        ));
        assert!(matches!(
            store
                .queue_mutation_async(
                    "s".into(),
                    "q3".into(),
                    2,
                    2,
                    "remove".into(),
                    br#"{"id":"inq_1"}"#.to_vec()
                )
                .await,
            Err(StorageError::Runtime(RuntimeError::StaleEpoch { .. }))
        ));
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn append_retry_returns_the_original_receipt_after_reopen_and_completion() {
        let path = temp_path("append-receipt");
        let store = HotStore::open(&path).unwrap();
        store.admit_run("s", "start", "body", "r", 1, 0).unwrap();
        let first = store
            .append_stream_with_durability(
                "s",
                "r",
                "p",
                1,
                1,
                Durability::GroupCommit,
                vec![event("one"), event("two")],
            )
            .unwrap();
        assert!(!first.reused);
        drop(store);
        let store = HotStore::open(&path).unwrap();
        store
            .finish_run("s", "finish", "r", "completed", 1, 1)
            .unwrap();
        store
            .admit_run("s", "start-next", "next", "next", 2, 2)
            .unwrap();
        let retry = store
            .append_stream_with_durability(
                "s",
                "r",
                "p",
                1,
                1,
                Durability::GroupCommit,
                vec![event("one"), event("two")],
            )
            .unwrap();
        assert!(retry.reused);
        assert_eq!(
            (retry.first_sequence, retry.last_sequence),
            (first.first_sequence, first.last_sequence)
        );
        assert_eq!(store.replay("s", 0).unwrap().len(), 3);
        assert_eq!(
            store.replay("s", 2).unwrap().first().unwrap().kind,
            "run_finished"
        );
        assert_eq!(
            store.snapshot("s").unwrap().active_run_id.as_deref(),
            Some("next")
        );
        assert!(matches!(
            store.append_stream_with_durability(
                "s",
                "r",
                "p",
                1,
                1,
                Durability::GroupCommit,
                vec![event("changed")]
            ),
            Err(StorageError::Runtime(RuntimeError::RequestConflict))
        ));
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn uncertain_append_closes_live_observers_and_retry_does_not_duplicate() {
        let path = temp_path("append-uncertain");
        let store = HotStore::open(&path).unwrap();
        store.admit_run("s", "start", "body", "r", 1, 0).unwrap();
        let mut faulty = store.clone();
        faulty.faults.ack_unknown_after_commit = true;
        let router = crate::actor::SessionShardRouter::with_store(1, 16, Arc::new(faulty)).unwrap();
        let (_, _, mut live) = router.subscribe("s", 0).await.unwrap();
        assert!(matches!(
            router
                .append_stream("s", "r", "p", 1, 1, vec![event("one")])
                .await,
            Err(RuntimeError::DurabilityUnknown(_))
        ));
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), live.recv())
                .await
                .unwrap()
                .is_none()
        );
        let retry = store
            .append_stream("s", "r", "p", 1, 1, vec![event("one")])
            .unwrap();
        assert!(retry.reused);
        assert_eq!(store.snapshot("s").unwrap().cursor, 1);
        drop(router);
        tokio::task::yield_now().await;
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    fn terminal_document(status: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "id":"r", "sessionId":"s", "status":status,
            "completedAt":"2026-10-16T07:00:00.123Z", "currentStep":7, "stopReason":"provider error",
            "metadata":{"executionLease":{"epoch":"lease1","closed":false}}
        })).unwrap()
    }

    #[test]
    fn completion_atomically_persists_final_document_event_and_receipt_across_restarts() {
        for status in ["completed", "failed", "cancelled", "interrupted", "blocked"] {
            let path = temp_path("finish-document");
            let store = HotStore::open(&path).unwrap();
            store.ui_snapshot("s", Some(&ui_seed())).unwrap();
            store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
            let final_run = terminal_document(status);
            let first = store
                .finish_run_with_document("s", "finish", "r", status, 1, 1, &final_run)
                .unwrap();
            assert!(!first.reused);
            assert_eq!(first.snapshot.cursor, 1);
            assert_eq!(first.snapshot.epoch, 2);
            assert_eq!(first.snapshot.revision, 2);
            let event = first.event.clone().unwrap();
            let payload: serde_json::Value = serde_json::from_slice(&event.payload).unwrap();
            let projection = ui_read(&store);
            assert_eq!(projection.run["currentStep"], 7);
            assert_eq!(projection.run["completedAt"], "2026-10-16T07:00:00.123Z");
            assert_eq!(projection.run["metadata"]["executionLease"]["closed"], true);
            assert_eq!(projection.run, payload["chunk"]["run"]);
            assert_eq!(
                projection.session["updatedAt"],
                projection.run["completedAt"]
            );
            assert_eq!(
                projection.session["completedAt"],
                projection.run["completedAt"]
            );
            assert_eq!(
                projection.session["status"],
                if status == "blocked" {
                    "completed"
                } else {
                    status
                }
            );
            if status == "blocked" {
                assert_eq!(projection.run["status"], "blocked");
                assert_eq!(projection.session["blockedReason"], "provider error");
            }
            assert_eq!(projection.cursor, event.sequence);
            assert!(projection.session["activeRunId"].is_null());
            let stored: StoredRun = serde_json::from_slice(
                &store
                    .get(CF_RUNS, run_key("s", "r").as_bytes())
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(stored.document.as_ref(), Some(&projection.run));
            drop(store);
            let store = HotStore::open(&path).unwrap();
            store.admit_run("s", "next", "hash2", "next", 2, 2).unwrap();
            let retry = store
                .finish_run_with_document("s", "finish", "r", status, 1, 1, &final_run)
                .unwrap();
            assert!(retry.reused);
            assert_eq!(retry.event.unwrap(), event);
            assert_eq!(store.replay("s", 0).unwrap().len(), 1);
            assert_eq!(
                store.snapshot("s").unwrap().active_run_id.as_deref(),
                Some("next")
            );
            let mut changed: serde_json::Value = serde_json::from_slice(&final_run).unwrap();
            changed["currentStep"] = serde_json::json!(8);
            assert!(matches!(
                store.finish_run_with_document(
                    "s",
                    "finish",
                    "r",
                    status,
                    1,
                    1,
                    &serde_json::to_vec(&changed).unwrap()
                ),
                Err(StorageError::Runtime(RuntimeError::RequestConflict))
            ));
            drop(store);
            let _ = std::fs::remove_dir_all(path);
        }
    }

    #[test]
    fn completion_commit_then_unknown_ack_keeps_exact_event_timestamp_and_new_fence() {
        let path = temp_path("finish-unknown");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        let mut faulty = store.clone();
        faulty.faults.ack_unknown_after_commit = true;
        assert!(matches!(
            faulty.finish_run_with_document("s", "finish", "r", "failed", 1, 1, &[]),
            Err(StorageError::Runtime(RuntimeError::DurabilityUnknown(_)))
        ));
        let original = store.replay("s", 0).unwrap()[0].clone();
        drop(faulty);
        drop(store);
        let store = HotStore::open(&path).unwrap();
        let retry = store
            .finish_run_with_document("s", "finish", "r", "failed", 1, 1, &[])
            .unwrap();
        assert!(retry.reused);
        assert_eq!(retry.event.unwrap(), original);
        assert_eq!(ui_read(&store).cursor, 1);
        assert_eq!(store.snapshot("s").unwrap().epoch, 2);
        assert_eq!(store.replay("s", 0).unwrap().len(), 1);
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn failed_completion_validation_or_disk_write_does_not_mutate_state_or_notify() {
        let path = temp_path("finish-failure");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        let before = ui_read(&store);
        let mut wrong: serde_json::Value =
            serde_json::from_slice(&terminal_document("failed")).unwrap();
        wrong["id"] = serde_json::json!("other");
        assert!(
            store
                .finish_run_with_document(
                    "s",
                    "finish",
                    "r",
                    "failed",
                    1,
                    1,
                    &serde_json::to_vec(&wrong).unwrap()
                )
                .is_err()
        );
        let mut faulty = store.clone();
        faulty.faults.disk_full = true;
        assert!(matches!(
            faulty.finish_run_with_document(
                "s",
                "finish",
                "r",
                "failed",
                1,
                1,
                &terminal_document("failed")
            ),
            Err(StorageError::DiskFull)
        ));
        assert_eq!(ui_read(&store), before);
        assert_eq!(store.snapshot("s").unwrap().cursor, 0);
        assert!(store.replay("s", 0).unwrap().is_empty());
        assert!(
            store
                .get(CF_TRANSITIONS, receipt_key("s", "finish").as_bytes())
                .unwrap()
                .is_none()
        );
        assert!(
            !store
                .finish_run_with_document(
                    "s",
                    "finish",
                    "r",
                    "failed",
                    1,
                    1,
                    &terminal_document("failed")
                )
                .unwrap()
                .reused
        );
        drop(faulty);
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn a_legacy_completion_receipt_is_replayed_without_synthesizing_an_event() {
        let path = temp_path("finish-legacy");
        let store = HotStore::open(&path).unwrap();
        let snapshot = SessionSnapshot {
            session_id: "s".into(),
            epoch: 2,
            revision: 2,
            active_run_id: None,
            cursor: 12,
            retained_from: 1,
        };
        let identity = serde_json::to_string(&("r", "completed")).unwrap();
        let mut batch = WriteBatch::default();
        store
            .put_batch(
                &mut batch,
                CF_TRANSITIONS,
                receipt_key("s", "legacy"),
                &serde_json::to_vec(&(identity, &snapshot)).unwrap(),
            )
            .unwrap();
        store
            .write_with_durability(batch, Durability::Sync)
            .unwrap();
        let retry = store
            .finish_run_with_document("s", "legacy", "r", "completed", 1, 1, &[])
            .unwrap();
        assert!(retry.reused);
        assert!(retry.event.is_none());
        assert_eq!(retry.snapshot, snapshot);
        assert!(store.replay("s", 0).unwrap().is_empty());
        assert!(matches!(
            store.finish_run_with_document(
                "s",
                "legacy",
                "r",
                "completed",
                1,
                1,
                &terminal_document("completed")
            ),
            Err(StorageError::Runtime(RuntimeError::RequestConflict))
        ));
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn completion_persists_fences_and_idempotent_receipt() {
        let path = temp_path("finish");
        let store = HotStore::open(&path).unwrap();
        store.admit_run("s", "start-1", "body", "r1", 1, 0).unwrap();
        let done = store
            .finish_run("s", "finish-1", "r1", "completed", 1, 1)
            .unwrap();
        assert_eq!(
            (done.epoch, done.revision, done.active_run_id),
            (2, 2, None)
        );
        drop(store);
        let store = HotStore::open(&path).unwrap();
        store
            .admit_run("s", "start-2", "body2", "r2", 2, 2)
            .unwrap();
        assert_eq!(
            store
                .finish_run("s", "finish-1", "r1", "completed", 1, 1)
                .unwrap()
                .epoch,
            2
        );
        assert_eq!(
            store.snapshot("s").unwrap().active_run_id.as_deref(),
            Some("r2")
        );
        assert!(matches!(
            store.finish_run("s", "finish-1", "r1", "failed", 1, 1),
            Err(StorageError::Runtime(RuntimeError::RequestConflict))
        ));
        assert!(matches!(
            store.append_stream("s", "r1", "old", 1, 1, vec![event("late")]),
            Err(StorageError::Runtime(RuntimeError::StaleEpoch { .. }))
        ));
        assert!(
            store
                .append_stream("s", "r1", "old", 1, 2, vec![event("wrong-run")])
                .is_err()
        );
        store
            .append_stream("s", "r2", "new", 1, 2, vec![event("valid")])
            .unwrap();
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn run_patch_persists_execution_lease_in_projection_and_run_document() {
        let path = temp_path("run-patch");
        let store = HotStore::open(&path).unwrap();
        store
            .ui_snapshot(
                "s",
                Some(br#"{"id":"s","projectId":"p","status":"queued","updatedAt":"2026-10-17T00:00:00Z"}"#),
            )
            .unwrap();
        let run = serde_json::json!({
            "id":"r",
            "sessionId":"s",
            "status":"queued",
            "startedAt":"2026-10-17T00:00:00Z",
            "completedAt":null,
            "metadata":{}
        });
        store
            .admit_run_with_document(
                "s",
                "admit",
                "body",
                "r",
                1,
                0,
                &[],
                &serde_json::to_vec(&run).unwrap(),
            )
            .unwrap();
        let result = store
            .control_command(
                "s",
                "lease",
                1,
                1,
                "run_patch",
                br#"{"runId":"r","patch":{"status":"running","metadata":{"executionLease":{"epoch":"lease-1","closed":false}}}}"#,
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&result.state_json).unwrap()["runtimeControl"],
            serde_json::Value::Null
        );
        let projection = store.read_ui_projection("s").unwrap().unwrap();
        assert_eq!(projection.run["status"], "running");
        assert_eq!(
            projection.run["metadata"]["executionLease"]["epoch"],
            "lease-1"
        );
        let stored: StoredRun = serde_json::from_slice(
            &store
                .get(CF_RUNS, run_key("s", "r").as_bytes())
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            stored.document.unwrap()["metadata"]["executionLease"]["closed"],
            false
        );
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn async_snapshot_cache_tracks_committed_cursor() {
        let path = temp_path("async-cache");
        let store = HotStore::open(&path).unwrap();
        assert_eq!(store.snapshot_async("s".into()).await.unwrap().cursor, 0);
        store
            .admit_run_async(
                "s".into(),
                "req".into(),
                "hash".into(),
                "r".into(),
                1,
                0,
                Vec::new(),
            )
            .await
            .unwrap();
        let snapshot = store.snapshot_async("s".into()).await.unwrap();
        assert_eq!(snapshot.active_run_id.as_deref(), Some("r"));
        store
            .append_stream_async(
                "s".into(),
                "r".into(),
                "p".into(),
                1,
                1,
                Durability::GroupCommit,
                vec![event("delta")],
            )
            .await
            .unwrap();
        assert_eq!(store.snapshot_async("s".into()).await.unwrap().cursor, 1);
        drop(store);
        let reopened = HotStore::open(&path).unwrap();
        assert_eq!(reopened.snapshot_async("s".into()).await.unwrap().cursor, 1);
        drop(reopened);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn write_batch_persists_admission_and_stream_atomically() {
        let path = temp_path("batch");
        let store = HotStore::open(&path).unwrap();
        let admission = store.admit_run("s", "req", "body", "r", 1, 0).unwrap();
        assert_eq!(admission.revision, 1);
        store
            .append_stream_with_durability(
                "s",
                "r",
                "producer",
                1,
                1,
                Durability::GroupCommit,
                vec![event("delta-1"), event("delta-2")],
            )
            .unwrap();
        assert_eq!(store.snapshot("s").unwrap().cursor, 2);
        drop(store);

        let reopened = HotStore::open(&path).unwrap();
        assert_eq!(
            reopened.snapshot("s").unwrap().active_run_id.as_deref(),
            Some("r")
        );
        let replay = reopened.replay("s", 0).unwrap();
        reopened.compact_stream("s").unwrap();
        let replay_after_compaction = reopened.replay("s", 0).unwrap();
        assert_eq!(
            replay
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(
            replay_after_compaction
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        drop(reopened);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn receipt_is_idempotent_and_cache_does_not_change_revision() {
        let path = temp_path("receipt");
        let store = HotStore::open(&path).unwrap();
        let first = store.admit_run("s", "req", "body", "r", 1, 0).unwrap();
        assert_eq!(store.receipt("s", "req").unwrap().unwrap().run_id, "r");
        let reused = store.admit_run("s", "req", "body", "r2", 99, 99).unwrap();
        assert!(!first.reused);
        assert!(reused.reused);
        assert_eq!(reused.run_id, "r");
        assert_eq!(store.snapshot("s").unwrap().revision, 1);
        assert!(matches!(
            store.admit_run("s", "req", "other", "r3", 1, 1),
            Err(StorageError::Runtime(RuntimeError::RequestConflict))
        ));
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn ack_unknown_after_commit_converges_via_receipt_after_reopen() {
        let path = temp_path("ack-unknown");
        let faulty = HotStore::open_with_faults(
            &path,
            FaultConfig {
                ack_unknown_after_commit: true,
                abort_after_commit: false,
                abort_after_append: false,
                abort_after_finish: false,
                disk_full: false,
            },
        )
        .unwrap();
        assert!(matches!(
            faulty.admit_run("s", "req", "body", "r", 1, 0),
            Err(StorageError::Runtime(RuntimeError::DurabilityUnknown(_)))
        ));
        drop(faulty);

        let reopened = HotStore::open(&path).unwrap();
        assert_eq!(reopened.receipt("s", "req").unwrap().unwrap().run_id, "r");
        let reused = reopened
            .admit_run("s", "req", "body", "r-retry", 99, 99)
            .unwrap();
        assert!(reused.reused);
        assert_eq!(reused.run_id, "r");
        drop(reopened);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn concurrent_group_writes_and_compaction_preserve_replay() {
        let path = temp_path("concurrent");
        let store = HotStore::open(&path).unwrap();
        let session_count = 8usize;
        let batches_per_session = 24u64;
        for index in 0..session_count {
            let session = format!("s-{index}");
            let run = format!("r-{index}");
            store
                .admit_run(&session, &format!("req-{index}"), "body", &run, 1, 0)
                .unwrap();
        }
        let shared = Arc::new(store);
        std::thread::scope(|scope| {
            for index in 0..session_count {
                let store = shared.clone();
                scope.spawn(move || {
                    let session = format!("s-{index}");
                    let run = format!("r-{index}");
                    let producer = format!("p-{index}");
                    for sequence in 1..=batches_per_session {
                        store
                            .append_stream_with_durability(
                                &session,
                                &run,
                                &producer,
                                sequence,
                                1,
                                Durability::GroupCommit,
                                vec![event("delta-1"), event("delta-2")],
                            )
                            .unwrap();
                    }
                });
            }
        });
        std::thread::scope(|scope| {
            for index in 0..session_count {
                let store = shared.clone();
                scope.spawn(move || {
                    store.compact_stream(&format!("s-{index}")).unwrap();
                });
            }
        });
        for index in 0..session_count {
            let events = shared.replay(&format!("s-{index}"), 0).unwrap();
            assert_eq!(events.len(), (batches_per_session * 2) as usize);
            assert_eq!(events.first().unwrap().sequence, 1);
            assert_eq!(events.last().unwrap().sequence, batches_per_session * 2);
        }
        drop(shared);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn disk_full_is_a_stable_write_error_without_a_receipt() {
        let path = temp_path("disk-full");
        let store = HotStore::open_with_faults(
            &path,
            FaultConfig {
                ack_unknown_after_commit: false,
                abort_after_commit: false,
                abort_after_append: false,
                abort_after_finish: false,
                disk_full: true,
            },
        )
        .unwrap();
        assert!(matches!(
            store.admit_run("s", "req", "body", "r", 1, 0),
            Err(StorageError::DiskFull)
        ));
        drop(store);
        let reopened = HotStore::open(&path).unwrap();
        assert!(reopened.receipt("s", "req").unwrap().is_none());
        drop(reopened);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn stale_epoch_and_cursor_retention_are_enforced() {
        let path = temp_path("fence");
        let store = HotStore::open(&path).unwrap();
        store.admit_run("s", "req", "body", "r", 1, 0).unwrap();
        assert!(matches!(
            store.append_stream("s", "r", "p", 1, 2, vec![event("bad")]),
            Err(StorageError::Runtime(RuntimeError::StaleEpoch { .. }))
        ));
        for n in 1..=EVENT_RETENTION + 2 {
            store
                .append_stream("s", "r", "p", n, 1, vec![event("x")])
                .unwrap();
        }
        assert!(store.replay("s", 0).unwrap().len() <= EVENT_RETENTION as usize);
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn control_commands_are_fenced_idempotent_and_recoverable() {
        let path = temp_path("controls");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();

        let permission = serde_json::json!({
            "id": "permission-1",
            "sessionId": "s",
            "runId": "r",
            "action": "ask",
            "reason": "write requires approval",
            "resumeToken": "resume:permission-1",
            "userReply": null,
            "resolvedAt": null
        });
        let requested = store
            .control_command(
                "s",
                "permission-request",
                1,
                0,
                "permission_request",
                &serde_json::to_vec(&permission).unwrap(),
            )
            .unwrap();
        assert!(!requested.reused);
        assert_eq!(requested.snapshot.revision, 1);
        assert_eq!(requested.snapshot.cursor, 1);
        assert_eq!(
            serde_json::from_slice::<ControlState>(&requested.state_json)
                .unwrap()
                .permissions
                .len(),
            1
        );

        let retry = store
            .control_command(
                "s",
                "permission-request",
                1,
                0,
                "permission_request",
                &serde_json::to_vec(&permission).unwrap(),
            )
            .unwrap();
        assert!(retry.reused);
        assert_eq!(store.snapshot("s").unwrap().revision, 1);

        let resolved = store
            .control_command(
                "s",
                "permission-reply",
                1,
                1,
                "permission_reply",
                br#"{"id":"permission-1","reply":"once"}"#,
            )
            .unwrap();
        assert_eq!(resolved.snapshot.revision, 2);
        assert_eq!(resolved.event.unwrap().kind, "permission_resolved");

        let stop = store
            .control_command(
                "s",
                "stop",
                1,
                2,
                "stop_begin",
                br#"{"runId":"r","reason":"user requested"}"#,
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<ControlState>(&stop.state_json)
                .unwrap()
                .runtime_control
                .unwrap()["state"],
            "stopping"
        );
        drop(store);

        let reopened = HotStore::open(&path).unwrap();
        let state = reopened.control_state("s").unwrap();
        let state: ControlState = serde_json::from_slice(&state).unwrap();
        assert_eq!(state.permissions[0]["userReply"], "once");
        assert_eq!(state.runtime_control.unwrap()["state"], "stopping");
        assert_eq!(reopened.replay("s", 0).unwrap().len(), 3);
        drop(reopened);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn session_patch_can_close_a_recovery_fence_atomically() {
        let path = temp_path("session-patch-recovery");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        store
            .control_command(
                "s",
                "stopping",
                1,
                0,
                "stop_begin",
                br#"{"runId":"r","reason":"restart"}"#,
            )
            .unwrap();
        let patched = store
            .control_command(
                "s",
                "recovered",
                1,
                1,
                "session_patch",
                br#"{"patch":{"status":"paused","activeRunId":null,"completedAt":null,"updatedAt":"2026-10-17T00:00:00Z","blockedReason":"restart"}}"#,
            )
            .unwrap();
        assert_eq!(patched.snapshot.revision, 2);
        let projection: crate::projection::UiSnapshot =
            serde_json::from_slice(&store.ui_snapshot("s", None).unwrap()).unwrap();
        assert_eq!(projection.session["status"], "paused");
        assert_eq!(projection.session["activeRunId"], serde_json::Value::Null);
        assert_eq!(projection.session["blockedReason"], "restart");
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn durable_history_outbox_survives_stream_retention_until_ack() {
        let path = temp_path("history-outbox");
        let store = HotStore::open(&path).unwrap();
        store.ui_snapshot("s", Some(&ui_seed())).unwrap();
        store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        store
            .append_stream_with_durability("s", "r", "p", 1, 1, Durability::Sync, vec![ui_event(serde_json::json!({
                "type": "step_started", "step": {"id":"step","sessionId":"s","runId":"r","index":1}
            }))])
            .unwrap();
        assert_eq!(store.replay("s", 0).unwrap().len(), 1);
        assert_eq!(store.history_outbox("s", 10).unwrap().len(), 1);
        store
            .append_stream_with_durability(
                "s",
                "r",
                "p",
                2,
                1,
                Durability::Sync,
                vec![ui_event(serde_json::json!({
                    "type": "message_delta", "runId":"r", "stepId":"step", "delta":"x"
                }))],
            )
            .unwrap();
        store.history_outbox_ack("s", 1).unwrap();
        assert_eq!(store.history_outbox("s", 10).unwrap().len(), 1);
        drop(store);
        let reopened = HotStore::open(&path).unwrap();
        assert_eq!(reopened.history_outbox("s", 10).unwrap().len(), 1);
        reopened.history_outbox_ack("s", 2).unwrap();
        assert!(reopened.history_outbox("s", 10).unwrap().is_empty());
        drop(reopened);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn history_outbox_maintenance_is_bounded_and_preserves_unacknowledged_events() {
        let path = temp_path("history-outbox-maintenance");
        let store = HotStore::open(&path).unwrap();
        store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        for (producer_sequence, chunk) in (0..300)
            .map(|index| event(&format!("event-{index}")))
            .collect::<Vec<_>>()
            .chunks(256)
            .enumerate()
        {
            store
                .append_stream_with_durability(
                    "s",
                    "r",
                    "p",
                    producer_sequence as u64 + 1,
                    1,
                    Durability::Sync,
                    chunk.to_vec(),
                )
                .unwrap();
        }

        store.history_outbox_ack("s", 300).unwrap();
        let first = store.history_outbox_maintain("s", 10).unwrap();
        assert_eq!(first.acked_through, 300);
        assert_eq!(first.removed, 10);
        assert!(first.has_more_acked);
        let mut passes = 1;
        let mut last = first;
        while last.has_more_acked {
            last = store.history_outbox_maintain("s", 10).unwrap();
            passes += 1;
        }
        assert_eq!(passes, 30);
        assert_eq!(last.removed, 10);
        assert!(store.history_outbox("s", 10).unwrap().is_empty());

        // Repeating maintenance is idempotent and cannot delete anything new.
        let repeated = store.history_outbox_maintain("s", 10).unwrap();
        assert_eq!(repeated.removed, 0);
        assert!(!repeated.has_more_acked);

        // A watermark cannot make an unacknowledged event disappear.
        store
            .append_stream_with_durability(
                "s",
                "r",
                "p",
                3,
                1,
                Durability::Sync,
                vec![event("unacknowledged")],
            )
            .unwrap();
        let pending = store.history_outbox("s", 10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].sequence, 301);
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn history_outbox_ack_watermark_survives_restart_and_duplicate_reconcile() {
        let path = temp_path("history-outbox-restart-idempotent");
        let store = HotStore::open(&path).unwrap();
        store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        store
            .append_stream_with_durability(
                "s",
                "r",
                "p",
                1,
                1,
                Durability::Sync,
                vec![event("one"), event("two")],
            )
            .unwrap();
        assert_eq!(store.history_outbox("s", 10).unwrap().len(), 2);

        // A reconcile pass can read the same durable batch more than once.
        let first_pass = store.history_outbox("s", 10).unwrap();
        let second_pass = store.history_outbox("s", 10).unwrap();
        assert_eq!(first_pass, second_pass);
        store.history_outbox_ack("s", 2).unwrap();
        // A duplicate ack is monotonic and safe.
        store.history_outbox_ack("s", 1).unwrap();
        drop(store);

        let reopened = HotStore::open(&path).unwrap();
        assert!(reopened.history_outbox("s", 10).unwrap().is_empty());
        let maintenance = reopened.history_outbox_maintain("s", 10).unwrap();
        assert_eq!(maintenance.acked_through, 2);
        assert_eq!(maintenance.removed, 2);
        drop(reopened);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn history_outbox_unknown_ack_is_recoverable_without_losing_pending_events() {
        let path = temp_path("history-outbox-unknown-ack");
        let store = HotStore::open(&path).unwrap();
        store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        store
            .append_stream_with_durability(
                "s",
                "r",
                "p",
                1,
                1,
                Durability::Sync,
                vec![event("one"), event("two")],
            )
            .unwrap();

        let mut faulty = store.clone();
        faulty.faults.ack_unknown_after_commit = true;
        assert!(matches!(
            faulty.history_outbox_ack("s", 1),
            Err(StorageError::Runtime(RuntimeError::DurabilityUnknown(_)))
        ));
        drop(faulty);
        drop(store);

        // The acknowledgement may have committed despite the lost reply. The
        // first event may therefore be gone, but the unacknowledged tail must
        // remain available after restart and repeated reconciliation.
        let reopened = HotStore::open(&path).unwrap();
        assert_eq!(reopened.replay("s", 0).unwrap().len(), 2);
        let pending = reopened.history_outbox("s", 10).unwrap();
        assert_eq!(
            pending
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![2]
        );
        let again = reopened.history_outbox("s", 10).unwrap();
        assert_eq!(pending, again);
        reopened.history_outbox_ack("s", 2).unwrap();
        assert!(reopened.history_outbox("s", 10).unwrap().is_empty());
        drop(reopened);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn history_outbox_disk_fault_keeps_ack_and_pending_events_retryable() {
        let path = temp_path("history-outbox-disk-fault");
        let store = HotStore::open(&path).unwrap();
        store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        store
            .append_stream_with_durability(
                "s",
                "r",
                "p",
                1,
                1,
                Durability::Sync,
                vec![event("one"), event("two")],
            )
            .unwrap();
        drop(store);

        let faulty = HotStore::open_with_faults(
            &path,
            FaultConfig {
                ack_unknown_after_commit: false,
                abort_after_commit: false,
                abort_after_append: false,
                abort_after_finish: false,
                disk_full: true,
            },
        )
        .unwrap();
        assert!(matches!(
            faulty.history_outbox_ack("s", 1),
            Err(StorageError::DiskFull)
        ));
        drop(faulty);

        let reopened = HotStore::open(&path).unwrap();
        assert_eq!(
            reopened
                .history_outbox("s", 10)
                .unwrap()
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(matches!(
            reopened.history_outbox_ack("s", 3),
            Err(StorageError::Runtime(RuntimeError::InvalidCommand(_)))
        ));
        reopened.history_outbox_ack("s", 2).unwrap();
        let maintenance = reopened.history_outbox_maintain("s", 10).unwrap();
        assert_eq!(maintenance.removed, 2);
        assert!(reopened.history_outbox("s", 10).unwrap().is_empty());
        drop(reopened);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn history_outbox_retention_is_independent_from_stream_retention_after_restart() {
        let path = temp_path("history-outbox-retention");
        let store = HotStore::open(&path).unwrap();
        store.admit_run("s", "start", "hash", "r", 1, 0).unwrap();
        let events = (0..(EVENT_RETENTION as usize + 32))
            .map(|index| event(&format!("retained-{index}")))
            .collect::<Vec<_>>();
        for (producer_sequence, chunk) in events.chunks(256).enumerate() {
            store
                .append_stream_with_durability(
                    "s",
                    "r",
                    "p",
                    producer_sequence as u64 + 1,
                    1,
                    Durability::Sync,
                    chunk.to_vec(),
                )
                .unwrap();
        }
        assert_eq!(
            store.replay("s", 0).unwrap().len(),
            EVENT_RETENTION as usize
        );
        assert_eq!(
            store
                .history_outbox("s", EVENT_RETENTION as usize + 64)
                .unwrap()
                .len(),
            EVENT_RETENTION as usize + 32
        );
        drop(store);

        let reopened = HotStore::open(&path).unwrap();
        let pending = reopened
            .history_outbox("s", EVENT_RETENTION as usize + 64)
            .unwrap();
        assert_eq!(pending.first().unwrap().sequence, 1);
        assert_eq!(pending.last().unwrap().sequence, EVENT_RETENTION + 32);
        drop(reopened);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn history_outbox_session_scan_finds_records_without_ui_projections() {
        let path = temp_path("history-outbox-session-scan");
        let store = HotStore::open(&path).unwrap();
        for session_id in ["alpha", "beta"] {
            store
                .admit_run(session_id, "start", "hash", "r", 1, 0)
                .unwrap();
            store
                .append_stream_with_durability(
                    session_id,
                    "r",
                    "p",
                    1,
                    1,
                    Durability::Sync,
                    vec![event(session_id)],
                )
                .unwrap();
        }

        let first = store.history_outbox_sessions(None, 1).unwrap();
        assert_eq!(first.session_ids, vec!["alpha"]);
        let cursor = first.next_key.clone().expect("bounded page cursor");
        let second = store.history_outbox_sessions(Some(&cursor), 1).unwrap();
        assert_eq!(second.session_ids, vec!["beta"]);
        let final_page = store
            .history_outbox_sessions(second.next_key.as_deref(), 1)
            .unwrap();
        assert!(final_page.session_ids.is_empty());
        assert!(final_page.next_key.is_none());

        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }
}
