use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use moka::sync::Cache;
use rocksdb::{ColumnFamilyDescriptor, DB, Options, WriteBatch, WriteOptions};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::actor::{
    PendingEvent, RunAdmission, RuntimeError, SessionSnapshot, StreamAppendReceipt, StreamEvent,
};

const CF_SESSIONS: &str = "sessions";
const CF_RUNS: &str = "runs";
const CF_RECEIPTS: &str = "receipts";
const CF_STREAMS: &str = "streams";
const SNAPSHOT_CACHE_CAPACITY: u64 = 4096;
const EVENT_RETENTION: u64 = 1024;

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredRun {
    run_id: String,
    session_id: String,
    epoch: u64,
    revision: u64,
}

#[derive(Clone)]
pub struct HotStore {
    db: Arc<DB>,
    snapshots: Cache<String, SessionSnapshot>,
}

impl HotStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let mut options = Options::default();
        options.create_if_missing(true);
        options.create_missing_column_families(true);
        let descriptors = [CF_SESSIONS, CF_RUNS, CF_RECEIPTS, CF_STREAMS]
            .into_iter()
            .map(|name| ColumnFamilyDescriptor::new(name, Options::default()))
            .collect::<Vec<_>>();
        let db = DB::open_cf_descriptors(&options, path, descriptors)?;
        Ok(Self {
            db: Arc::new(db),
            snapshots: Cache::builder()
                .max_capacity(SNAPSHOT_CACHE_CAPACITY)
                .build(),
        })
    }

    pub async fn snapshot_async(
        &self,
        session_id: String,
    ) -> Result<SessionSnapshot, StorageError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.snapshot(&session_id))
            .await
            .map_err(|error| {
                StorageError::Runtime(RuntimeError::InvalidCommand(format!(
                    "storage task failed: {error}"
                )))
            })?
    }

    pub async fn admit_run_async(
        &self,
        session_id: String,
        request_id: String,
        body_hash: String,
        run_id: String,
        epoch: u64,
        expected_revision: u64,
    ) -> Result<RunAdmission, StorageError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            store.admit_run(
                &session_id,
                &request_id,
                &body_hash,
                &run_id,
                epoch,
                expected_revision,
            )
        })
        .await
        .map_err(|error| {
            StorageError::Runtime(RuntimeError::InvalidCommand(format!(
                "storage task failed: {error}"
            )))
        })?
    }

    pub async fn append_stream_async(
        &self,
        session_id: String,
        run_id: String,
        producer_id: String,
        producer_sequence: u64,
        epoch: u64,
        events: Vec<PendingEvent>,
    ) -> Result<StreamAppendReceipt, StorageError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            store.append_stream(
                &session_id,
                &run_id,
                &producer_id,
                producer_sequence,
                epoch,
                events,
            )
        })
        .await
        .map_err(|error| {
            StorageError::Runtime(RuntimeError::InvalidCommand(format!(
                "storage task failed: {error}"
            )))
        })?
    }

    pub async fn replay_async(
        &self,
        session_id: String,
        after: u64,
    ) -> Result<Vec<StreamEvent>, StorageError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.replay(&session_id, after))
            .await
            .map_err(|error| {
                StorageError::Runtime(RuntimeError::InvalidCommand(format!(
                    "storage task failed: {error}"
                )))
            })?
    }

    pub fn snapshot(&self, session_id: &str) -> Result<SessionSnapshot, StorageError> {
        if let Some(snapshot) = self.snapshots.get(session_id) {
            return Ok(snapshot);
        }
        let state = self.read_session(session_id)?;
        let snapshot = state.snapshot();
        self.snapshots
            .insert(session_id.to_owned(), snapshot.clone());
        Ok(snapshot)
    }

    pub fn admit_run(
        &self,
        session_id: &str,
        request_id: &str,
        body_hash: &str,
        run_id: &str,
        epoch: u64,
        expected_revision: u64,
    ) -> Result<RunAdmission, StorageError> {
        let mut state = self.read_session(session_id)?;
        let receipt_key = receipt_key(session_id, request_id);
        if let Some(bytes) = self.get(CF_RECEIPTS, receipt_key.as_bytes())? {
            let receipt: StoredReceipt = serde_json::from_slice(&bytes)?;
            if receipt.body_hash != body_hash {
                return Err(RuntimeError::RequestConflict.into());
            }
            let mut reused = receipt.admission;
            reused.reused = true;
            return Ok(reused);
        }
        ensure_epoch(&state, epoch)?;
        ensure_revision(&state, expected_revision)?;
        if state.active_run_id.is_some() {
            return Err(RuntimeError::SessionBusy.into());
        }
        state.revision += 1;
        state.active_run_id = Some(run_id.to_owned());
        let admission = RunAdmission {
            session_id: session_id.to_owned(),
            run_id: run_id.to_owned(),
            epoch: state.epoch,
            revision: state.revision,
            reused: false,
        };
        let receipt = StoredReceipt {
            body_hash: body_hash.to_owned(),
            admission: admission.clone(),
        };
        let run = StoredRun {
            run_id: run_id.to_owned(),
            session_id: session_id.to_owned(),
            epoch: state.epoch,
            revision: state.revision,
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
        self.write_sync(batch)?;
        self.update_snapshot_cache(&state);
        Ok(admission)
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
        if events.is_empty() {
            return Err(
                RuntimeError::InvalidCommand("stream batch cannot be empty".to_owned()).into(),
            );
        }
        let mut state = self.read_session(session_id)?;
        ensure_epoch(&state, epoch)?;
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
        for pending in events {
            state.cursor += 1;
            let event = StreamEvent {
                sequence: state.cursor,
                run_id: run_id.to_owned(),
                kind: pending.kind,
                payload: pending.payload,
            };
            self.put_batch(
                &mut batch,
                CF_STREAMS,
                stream_key(session_id, state.cursor),
                &serde_json::to_vec(&event)?,
            )?;
        }
        state.retained_from = state.cursor.saturating_sub(EVENT_RETENTION) + 1;
        let delete_until = state.retained_from.saturating_sub(1);
        for sequence in 1..=delete_until {
            batch.delete_cf(self.cf(CF_STREAMS)?, stream_key(session_id, sequence));
        }
        self.put_batch(
            &mut batch,
            CF_SESSIONS,
            session_key(session_id),
            &serde_json::to_vec(&state)?,
        )?;
        self.write_sync(batch)?;
        self.update_snapshot_cache(&state);
        Ok(StreamAppendReceipt {
            session_id: session_id.to_owned(),
            run_id: run_id.to_owned(),
            first_sequence,
            last_sequence: state.cursor,
            epoch: state.epoch,
        })
    }

    pub fn replay(&self, session_id: &str, after: u64) -> Result<Vec<StreamEvent>, StorageError> {
        let state = self.read_session(session_id)?;
        if after > 0 && after + 1 < state.retained_from {
            return Err(RuntimeError::CursorExpired {
                after,
                retained_from: state.retained_from,
            }
            .into());
        }
        let mut events = Vec::new();
        let start = after.max(state.retained_from.saturating_sub(1)) + 1;
        for sequence in start..=state.cursor {
            let Some(bytes) = self.get(CF_STREAMS, stream_key(session_id, sequence).as_bytes())?
            else {
                continue;
            };
            events.push(serde_json::from_slice(&bytes)?);
        }
        Ok(events)
    }

    fn read_session(&self, session_id: &str) -> Result<StoredSession, StorageError> {
        let Some(bytes) = self.get(CF_SESSIONS, session_key(session_id).as_bytes())? else {
            return Ok(StoredSession::new(session_id.to_owned()));
        };
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn update_snapshot_cache(&self, state: &StoredSession) {
        self.snapshots
            .insert(state.session_id.clone(), state.snapshot());
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

    fn write_sync(&self, batch: WriteBatch) -> Result<(), StorageError> {
        let mut options = WriteOptions::default();
        options.set_sync(true);
        self.db.write_opt(batch, &options)?;
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

    #[test]
    fn write_batch_persists_admission_and_stream_atomically() {
        let path = temp_path("batch");
        let store = HotStore::open(&path).unwrap();
        let admission = store.admit_run("s", "req", "body", "r", 1, 0).unwrap();
        assert_eq!(admission.revision, 1);
        store
            .append_stream("s", "r", "producer", 1, 1, vec![event("delta")])
            .unwrap();
        assert_eq!(store.snapshot("s").unwrap().cursor, 1);
        drop(store);

        let reopened = HotStore::open(&path).unwrap();
        assert_eq!(
            reopened.snapshot("s").unwrap().active_run_id.as_deref(),
            Some("r")
        );
        assert_eq!(reopened.replay("s", 0).unwrap()[0].kind, "delta");
        drop(reopened);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn receipt_is_idempotent_and_cache_does_not_change_revision() {
        let path = temp_path("receipt");
        let store = HotStore::open(&path).unwrap();
        let first = store.admit_run("s", "req", "body", "r", 1, 0).unwrap();
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
}
