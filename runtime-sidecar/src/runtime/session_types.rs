//! Session types shared by the transport, the shard actors and the JSONL store.
//!
//! These were part of the RocksDB `HotStore` module. They are plain data the
//! wire layer and the actors exchange, so they live on their own now.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::runtime::actor::{Durability, PendingEvent, RuntimeError, SessionSnapshot, StreamEvent};

#[derive(Debug, Clone, Default)]
pub struct HistoryOutboxSessionPage {
    pub session_ids: Vec<String>,
    pub next_key: Option<String>,
}

/// The persistent half of an RPC: a request either ran completely or not at all.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
    #[error("serialization: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("storage disk full")]
    DiskFull,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivationReceipt {
    pub snapshot: SessionSnapshot,
    pub event: StreamEvent,
    #[serde(default)]
    pub reused: bool,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueueMutationReceipt {
    pub queue: crate::runtime::input_queue::QueueState,
    pub snapshot: SessionSnapshot,
    pub event: Option<StreamEvent>,
    pub reused: bool,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_lease: Option<crate::runtime::execution::ExecutionLease>,
    #[serde(default)]
    pub permissions: Vec<serde_json::Value>,
    #[serde(default)]
    pub interactions: Vec<serde_json::Value>,
    #[serde(default)]
    pub runtime_control: Option<serde_json::Value>,
    #[serde(default)]
    pub process_leases: Vec<serde_json::Value>,
}
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

impl From<StorageError> for RuntimeError {
    fn from(error: StorageError) -> Self {
        match error {
            StorageError::Runtime(error) => error,
            StorageError::Serialization(error) => {
                RuntimeError::StorageUnavailable(error.to_string())
            }
            StorageError::DiskFull => RuntimeError::DiskFull,
        }
    }
}

impl From<StorageError> for crate::storage::jsonl::history::HistoryError {
    fn from(error: StorageError) -> Self {
        match error {
            StorageError::Runtime(error) => Self::InvalidCommand(error.to_string()),
            StorageError::Serialization(error) => Self::InvalidCommand(error.to_string()),
            StorageError::DiskFull => Self::InvalidCommand("storage disk full".into()),
        }
    }
}
