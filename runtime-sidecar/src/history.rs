//! Immutable runtime history storage.
//!
//! The hot store owns the live session fence and bounded replay window. This
//! store owns immutable transcript objects and named heads, so checkpoint,
//! fork, rollback and garbage collection never copy the full conversation.

use moka::future::Cache;
use rocksdb::{ColumnFamilyDescriptor, DB, Options, WriteBatch, WriteOptions};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use thiserror::Error;
use tokio::sync::Semaphore;
mod files;

const CF_OBJECTS: &str = "objects";
const CF_HEADS: &str = "heads";
const CF_PINS: &str = "pins";
const CF_RECEIPTS: &str = "receipts";
const CF_INDEXES: &str = "indexes";
const CF_ENTITIES: &str = "visible_entities";
const CF_FILES: &str = "file_operations";
const CF_BLOBS: &str = "blobs";
const CF_ASSETS: &str = "assets";
const CF_ASSET_BINDINGS: &str = "asset_bindings";
const CF_OUTBOX: &str = "outbox";
const CF_GC_STATE: &str = "gc_state";
const CF_GC_MARKS: &str = "gc_marks";
const CF_GC_QUEUE: &str = "gc_queue";
const MAX_OBJECT_BYTES: usize = 4 * 1024 * 1024;
const MAX_COMMAND_BYTES: usize = 8 * 1024 * 1024;
const MAX_BLOB_CHUNK_BYTES: usize = 256 * 1024;
const MAX_BLOB_CHUNKS: u64 = 16_384;
const PAGE_LIMIT: usize = 256;
const PAGE_CURSOR_MAX_ITEMS: usize = 4096;
const ENTITY_PAGE_BYTES: usize = 768 * 1024;
const GC_DEFAULT_BATCH: usize = 128;
const GC_MAX_BATCH: usize = 512;

#[derive(Debug, Error)]
pub enum HistoryError {
    #[error("file operation: {0}")]
    FileIo(#[from] std::io::Error),
    #[error("file operation conflicts: {0}")]
    FileBusy(String),
    #[error("rocksdb: {0}")]
    Rocks(#[from] rocksdb::Error),
    #[error("serialization: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("history object not found: {0}")]
    ObjectMissing(String),
    #[error("history request was reused with different input")]
    RequestConflict,
    #[error("history revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("history command is invalid: {0}")]
    InvalidCommand(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryObject {
    object_id: String,
    kind: String,
    value: serde_json::Value,
    #[serde(default)]
    refs: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryHead {
    session_id: String,
    object_id: Option<String>,
    revision: u64,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HistoryReceipt {
    identity: String,
    result: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntityIndexEntry {
    object_id: String,
    order_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntityCursor {
    session_id: String,
    kind: String,
    revision: u64,
    reverse: bool,
    after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GcState {
    phase: String,
    source: usize,
    key: Vec<u8>,
    queue_head: u64,
    queue_tail: u64,
    root_epoch: String,
    marked: u64,
    scanned: u64,
    deleted: u64,
}

#[derive(Clone)]
pub struct HistoryStore {
    db: Arc<DB>,
    object_cache: Cache<String, Vec<u8>>,
    command_locks: Arc<[Mutex<()>; 64]>,
    asset_lock: Arc<Mutex<()>>,
    file_lock: Arc<Mutex<()>>,
    maintenance_lock: Arc<RwLock<()>>,
    blocking_slots: Arc<Semaphore>,
}

impl HistoryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, HistoryError> {
        let mut options = Options::default();
        options.create_if_missing(true);
        options.create_missing_column_families(true);
        let descriptors = [
            CF_OBJECTS,
            CF_HEADS,
            CF_PINS,
            CF_RECEIPTS,
            CF_INDEXES,
            CF_ENTITIES,
            CF_FILES,
            CF_BLOBS,
            CF_ASSETS,
            CF_ASSET_BINDINGS,
            CF_OUTBOX,
            CF_GC_STATE,
            CF_GC_MARKS,
            CF_GC_QUEUE,
        ]
        .into_iter()
        .map(|name| ColumnFamilyDescriptor::new(name, Options::default()))
        .collect::<Vec<_>>();
        let db = Arc::new(DB::open_cf_descriptors(&options, path, descriptors)?);
        Ok(Self {
            db,
            object_cache: Cache::builder()
                .weigher(|_key: &String, value: &Vec<u8>| value.len().min(u32::MAX as usize) as u32)
                .max_capacity(64 * 1024 * 1024).build(),
            command_locks: Arc::new(std::array::from_fn(|_| Mutex::new(()))),
            asset_lock: Arc::new(Mutex::new(())),
            file_lock: Arc::new(Mutex::new(())),
            maintenance_lock: Arc::new(RwLock::new(())),
            blocking_slots: Arc::new(Semaphore::new(32)),
        })
    }

    pub async fn command_async(
        &self,
        session_id: String,
        request_id: String,
        operation: String,
        payload: Vec<u8>,
    ) -> Result<Vec<u8>, HistoryError> {
        let permit = self
            .blocking_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| HistoryError::InvalidCommand("history executor closed".into()))?;
        let store = self.clone();
        let operation_for_task = operation.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            store.command(&session_id, &request_id, &operation_for_task, &payload)
        })
        .await
        .map_err(|error| HistoryError::InvalidCommand(format!("history task failed: {error}")))?;
        if operation == "gc" {
            self.object_cache.invalidate_all();
        }
        result
    }

    pub async fn object_async(&self, object_id: String) -> Result<Vec<u8>, HistoryError> {
        if let Some(bytes) = self.object_cache.get(&object_id).await {
            return Ok(bytes);
        }
        let store = self.clone();
        let key = object_id.clone();
        let bytes = tokio::task::spawn_blocking(move || store.read_object(&key))
            .await
            .map_err(|error| {
                HistoryError::InvalidCommand(format!("history task failed: {error}"))
            })??;
        self.object_cache.insert(object_id, bytes.clone()).await;
        Ok(bytes)
    }

    fn command(
        &self,
        session_id: &str,
        request_id: &str,
        operation: &str,
        payload: &[u8],
    ) -> Result<Vec<u8>, HistoryError> {
        if session_id.is_empty()
            || request_id.is_empty()
            || request_id.len() > 256
            || operation.is_empty()
            || operation.len() > 64
            || payload.len() > MAX_COMMAND_BYTES
        {
            return Err(HistoryError::InvalidCommand(
                "history command exceeds bounds".into(),
            ));
        }
        let value: serde_json::Value = if payload.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(payload)?
        };
        // GC must not collect a newly staged object or a root being published.
        // Ordinary sessions use independent stripes; blocking never occupies a Tokio worker.
        // GC takes this read-side maintenance lock only for one bounded
        // invocation. The lock prevents a root publication from racing the
        // mark/sweep step, while the persisted cursor keeps the lock window
        // independent of total history size.
        let exclusive = matches!(operation, "gc" | "rebuild_index");
        let _maintenance_write = if exclusive {
            Some(self.maintenance_lock.write().map_err(|_| {
                HistoryError::InvalidCommand("history maintenance lock poisoned".into())
            })?)
        } else {
            None
        };
        let _maintenance_read = if exclusive {
            None
        } else {
            Some(self.maintenance_lock.read().map_err(|_| {
                HistoryError::InvalidCommand("history maintenance lock poisoned".into())
            })?)
        };
        let _assets =
            if operation.starts_with("asset_") || operation.contains("blob") {
                Some(self.asset_lock.lock().map_err(|_| {
                    HistoryError::InvalidCommand("history asset lock poisoned".into())
                })?)
            } else {
                None
            };
        let _files = if operation.starts_with("file_") || operation == "restore_checkpoint" {
            Some(self.file_lock.lock().map_err(|_| HistoryError::InvalidCommand("file operation lock poisoned".into()))?)
        } else { None };
        let stripe =
            usize::from(Sha256::digest(session_id.as_bytes())[0]) % self.command_locks.len();
        let _session = self.command_locks[stripe]
            .lock()
            .map_err(|_| HistoryError::InvalidCommand("history session lock poisoned".into()))?;
        let readonly = matches!(
            operation,
            "head_read"
                | "get_object"
                | "get_blob_chunk"
                | "get_blob_manifest"
                | "asset_get"
                | "asset_page"
                | "asset_has_binding"
                | "asset_list_bindings"
                | "list_checkpoints"
                | "page"
                | "list_runs"
                | "list_messages"
                | "list_steps"
                | "list_parts"
                | "list_tool_calls"
                | "list_events"
                | "list_artifacts"
                | "list_plans"
                | "list_work"
                | "list_contexts"
                | "list_aux_usage"
                | "list_terminals"
                | "list_thinking"
                | "list_compactions"
                | "list_permissions"
                | "list_interactions"
                | "list_file_changes"
                | "file_cursor"
                | "file_pending"
                | "file_preview"
                | "verify"
        );
        let identity = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "history.v1",
                session_id,
                operation,
                &value
            ))?)
        );
        let receipt_key = format!("r/{session_id}/{request_id}");
        // Query ids are correlation only. Old versions persisted query results:
        // ignoring those receipts also repairs stale reads after upgrade.
        if !readonly {
            if let Some(bytes) = self.get(CF_RECEIPTS, receipt_key.as_bytes())? {
                let receipt: HistoryReceipt = serde_json::from_slice(&bytes)?;
                if receipt.identity != identity {
                    return Err(HistoryError::RequestConflict);
                }
                return Ok(receipt.result);
            }
        }
        let mut batch = WriteBatch::default();
        let result = match operation {
            "append_entities" => self.append_entities(session_id, &value, &mut batch)?,
            "put_object" => self.put_object(&value, &mut batch)?,
            "put_blob_chunk" => self.put_blob_chunk(&value, &mut batch)?,
            "put_blob_manifest" => self.put_blob_manifest(&value, &mut batch)?,
            "get_blob_chunk" => self.get_blob_chunk(&value)?,
            "get_blob_manifest" => self.get_blob_manifest(&value)?,
            "delete_blob" => self.delete_blob(&value, &mut batch)?,
            "asset_put" => self.asset_put(&value, &mut batch)?,
            "asset_get" => self.asset_get(&value)?,
            "asset_page" => self.asset_page(&value)?,
            "asset_bind" => self.asset_bind(&value, &mut batch)?,
            "asset_unbind" => self.asset_unbind(&value, &mut batch)?,
            "asset_has_binding" => self.asset_has_binding(&value)?,
            "asset_list_bindings" => self.asset_list_bindings(&value)?,
            "asset_delete" => self.asset_delete(&value, &mut batch)?,
            "get_object" => {
                let object_id = required_string(&value, "objectId")?;
                self.read_object(object_id)?
            }
            "head_read" => self.head_read(session_id)?,
            "head_switch" | "checkpoint" => {
                self.head_switch(session_id, &value, operation, &mut batch)?
            }
            "list_checkpoints" => self.list_checkpoints(session_id, &value)?,
            "fork" => self.fork(session_id, &value, &mut batch)?,
            "rollback" => self.head_switch(session_id, &value, "head_switch", &mut batch)?,
            "pin" => self.pin(session_id, &value, &mut batch)?,
            "unpin" => self.unpin(session_id, &value, &mut batch)?,
            "page" => self.page(&value)?,
            "list_runs" => self.list_indexed(session_id, "run", &value)?,
            "list_messages" => self.list_indexed(session_id, "message", &value)?,
            "list_steps" => self.list_indexed(session_id, "step", &value)?,
            "list_parts" => self.list_indexed(session_id, "part", &value)?,
            "list_tool_calls" => self.list_indexed(session_id, "tool", &value)?,
            "list_events" => self.list_indexed(session_id, "event", &value)?,
            "list_artifacts" => self.list_indexed(session_id, "artifact", &value)?,
            "list_plans" => self.list_indexed(session_id, "plan", &value)?,
            "list_work" => self.list_indexed(session_id, "work", &value)?,
            "list_contexts" => self.list_indexed(session_id, "context", &value)?,
            "list_aux_usage" => self.list_indexed(session_id, "aux", &value)?,
            "list_thinking" => self.list_indexed(session_id, "thinking", &value)?,
            "list_compactions" => self.list_indexed(session_id, "compaction", &value)?,
            "list_terminals" => self.list_indexed(session_id, "terminal", &value)?,
            "list_permissions" => self.list_indexed(session_id, "permission", &value)?,
            "list_interactions" => self.list_indexed(session_id, "interaction", &value)?,
            "list_file_changes" => self.list_indexed(session_id, "file_change", &value)?,
            "file_begin" | "file_finish" | "file_abandon" | "file_import" | "file_cursor" | "file_checkpoint" | "file_pending" | "file_preview" | "restore_checkpoint" | "file_recover" | "file_restore_ack" =>
                self.file_command(session_id, request_id, operation, &value, &mut batch)?,
            "verify" => self.verify()?,
            "rebuild_index" => self.rebuild_index(&mut batch)?,
            "gc" => self.gc(&value)?,
            _ => {
                return Err(HistoryError::InvalidCommand(format!(
                    "unknown history operation: {operation}"
                )));
            }
        };
        if readonly {
            return Ok(result);
        }
        let receipt = serde_json::to_vec(&HistoryReceipt {
            identity,
            result: result.clone(),
        })?;
        batch.put_cf(self.cf(CF_RECEIPTS)?, receipt_key.as_bytes(), receipt);
        let mut options = WriteOptions::default();
        options.set_sync(true);
        self.db.write_opt(batch, &options)?;
        Ok(result)
    }

    fn put_object(
        &self,
        value: &serde_json::Value,
        batch: &mut WriteBatch,
    ) -> Result<Vec<u8>, HistoryError> {
        let kind = required_string(value, "kind")?;
        let object_value = value
            .get("value")
            .cloned()
            .ok_or_else(|| HistoryError::InvalidCommand("object value is required".into()))?;
        let refs = value
            .get("refs")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        let refs: Vec<String> = serde_json::from_value(refs)
            .map_err(|_| HistoryError::InvalidCommand("object refs must be strings".into()))?;
        let identity = serde_json::to_vec(&(kind, &object_value, &refs))?;
        if identity.len() > MAX_OBJECT_BYTES {
            return Err(HistoryError::InvalidCommand(
                "history object exceeds bounds".into(),
            ));
        }
        for object_id in &refs {
            if self
                .get(CF_OBJECTS, object_key(object_id).as_bytes())?
                .is_none()
            {
                return Err(HistoryError::ObjectMissing(object_id.clone()));
            }
        }
        let object_id = format!("sha256:{:x}", Sha256::digest(&identity));
        let object = HistoryObject {
            object_id: object_id.clone(),
            kind: kind.to_owned(),
            value: object_value,
            refs,
        };
        let bytes = serde_json::to_vec(&object)?;
        batch.put_cf(
            self.cf(CF_OBJECTS)?,
            object_key(&object_id).as_bytes(),
            &bytes,
        );
        Ok(serde_json::to_vec(
            &serde_json::json!({"objectId":object_id,"bytes":bytes.len()}),
        )?)
    }

    /// Persist bounded entity updates, the root that retains them and the
    /// command receipt in the same WAL-synced batch (committed by command()).
    fn append_entities(
        &self,
        session_id: &str,
        value: &serde_json::Value,
        batch: &mut WriteBatch,
    ) -> Result<Vec<u8>, HistoryError> {
        let objects = value["objects"]
            .as_array()
            .filter(|objects| !objects.is_empty() && objects.len() <= PAGE_LIMIT)
            .ok_or_else(|| {
                HistoryError::InvalidCommand("append requires 1..256 entities".into())
            })?;
        let mut head = self.read_head(session_id)?;
        self.require_entity_index(session_id, &head)?;
        if let Some(expected) = value.get("expectedRevision").and_then(|v| v.as_u64()) {
            if expected != head.revision {
                return Err(HistoryError::RevisionConflict {
                    expected,
                    actual: head.revision,
                });
            }
        }
        // New entities come first so bounded graph pages can serve the latest
        // transcript without walking the entire historical root chain.
        let mut refs = Vec::with_capacity(objects.len() + 1);
        let mut indexed = HashSet::new();
        // Outbox batches arrive chronologically. The newest value of each id
        // must win both graph traversal and the materialized current-head index.
        for object in objects.iter().rev() {
            let kind = required_string(object, "kind")?;
            if indexed_kind(kind, &object["value"]).is_none()
                || object["value"]["sessionId"].as_str() != Some(session_id)
            {
                return Err(HistoryError::InvalidCommand(
                    "entity kind or session does not match append scope".into(),
                ));
            }
            required_string(&object["value"], "id")?;
            let result: serde_json::Value =
                serde_json::from_slice(&self.put_object(object, batch)?)?;
            let object_id = required_string(&result, "objectId")?.to_owned();
            if indexed.insert((indexed_kind(kind, &object["value"]).unwrap(), required_string(&object["value"], "id")?)) {
                self.index_entity(session_id, &object_id, kind, &object["value"], batch)?;
            }
            refs.push(object_id);
        }
        if let Some(previous) = &head.object_id {
            self.read_object(previous)?;
            refs.push(previous.clone());
        }
        head.revision = head
            .revision
            .checked_add(1)
            .ok_or_else(|| HistoryError::InvalidCommand("history revision overflow".into()))?;
        let kind = "runtime.session.root";
        let root_value = serde_json::json!({"sessionId":session_id,"revision":head.revision});
        let identity = serde_json::to_vec(&(kind, &root_value, &refs))?;
        let root = HistoryObject {
            object_id: format!("sha256:{:x}", Sha256::digest(&identity)),
            kind: kind.into(),
            value: root_value,
            refs,
        };
        batch.put_cf(
            self.cf(CF_OBJECTS)?,
            object_key(&root.object_id).as_bytes(),
            serde_json::to_vec(&root)?,
        );
        head.session_id = session_id.to_owned();
        head.object_id = Some(root.object_id.clone());
        head.updated_at = now_iso();
        batch.put_cf(
            self.cf(CF_HEADS)?,
            head_key(session_id).as_bytes(),
            serde_json::to_vec(&head)?,
        );
        self.bump_root_epoch(batch)?;
        batch.put_cf(self.cf(CF_ENTITIES)?, entity_head_key(session_id), root.object_id.as_bytes());
        Ok(serde_json::to_vec(&head)?)
    }

    fn put_blob_chunk(
        &self,
        value: &serde_json::Value,
        batch: &mut WriteBatch,
    ) -> Result<Vec<u8>, HistoryError> {
        let blob_id = required_string(value, "blobId")?;
        let index = required_u64(value, "index")?;
        let total = required_u64(value, "total")?;
        let bytes_hex = value
            .get("bytesHex")
            .and_then(|item| item.as_str())
            .unwrap_or_default();
        if total == 0 || total > MAX_BLOB_CHUNKS || index >= total {
            return Err(HistoryError::InvalidCommand(
                "invalid blob chunk bounds".into(),
            ));
        }
        let bytes = decode_hex(bytes_hex)?;
        if bytes.len() > MAX_BLOB_CHUNK_BYTES {
            return Err(HistoryError::InvalidCommand(
                "blob chunk exceeds bounds".into(),
            ));
        }
        let key = blob_chunk_key(blob_id, index);
        if let Some(previous) = self.get(CF_BLOBS, key.as_bytes())? {
            if previous != bytes {
                return Err(HistoryError::RequestConflict);
            }
        } else {
            batch.put_cf(self.cf(CF_BLOBS)?, key.as_bytes(), bytes.as_slice());
        }
        Ok(serde_json::to_vec(
            &serde_json::json!({"blobId":blob_id,"index":index,"total":total,"bytes":bytes.len()}),
        )?)
    }

    fn put_blob_manifest(
        &self,
        value: &serde_json::Value,
        batch: &mut WriteBatch,
    ) -> Result<Vec<u8>, HistoryError> {
        let blob_id = required_string(value, "blobId")?;
        let total = required_u64(value, "total")?;
        let size = required_u64(value, "size")?;
        if total == 0 || total > MAX_BLOB_CHUNKS {
            return Err(HistoryError::InvalidCommand(
                "invalid blob manifest bounds".into(),
            ));
        }
        let mut digest = Sha256::new();
        let mut actual_size = 0u64;
        for index in 0..total {
            let key = blob_chunk_key(blob_id, index);
            let Some(bytes) = self.get(CF_BLOBS, key.as_bytes())? else {
                return Err(HistoryError::InvalidCommand(format!(
                    "missing blob chunk {index}"
                )));
            };
            actual_size = actual_size.saturating_add(bytes.len() as u64);
            digest.update(&bytes);
        }
        if actual_size != size {
            return Err(HistoryError::InvalidCommand(
                "blob manifest size does not match chunks".into(),
            ));
        }
        let actual_sha256 = format!("{:x}", digest.finalize());
        if let Some(expected) = value.get("sha256").and_then(|item| item.as_str()) {
            if expected != actual_sha256 {
                return Err(HistoryError::InvalidCommand(
                    "blob manifest digest does not match chunks".into(),
                ));
            }
        }
        let manifest =
            serde_json::json!({"blobId":blob_id,"total":total,"size":size,"sha256":actual_sha256});
        batch.put_cf(
            self.cf(CF_BLOBS)?,
            blob_manifest_key(blob_id).as_bytes(),
            serde_json::to_vec(&manifest)?,
        );
        Ok(serde_json::to_vec(&manifest)?)
    }

    fn get_blob_chunk(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let blob_id = required_string(value, "blobId")?;
        let index = required_u64(value, "index")?;
        let bytes = self
            .get(CF_BLOBS, blob_chunk_key(blob_id, index).as_bytes())?
            .ok_or_else(|| HistoryError::ObjectMissing(format!("blob chunk {blob_id}/{index}")))?;
        let total = self
            .get_blob_manifest_value(blob_id)?
            .and_then(|manifest| manifest["total"].as_u64());
        Ok(serde_json::to_vec(
            &serde_json::json!({"blobId":blob_id,"index":index,"total":total,"bytesHex":encode_hex(&bytes)}),
        )?)
    }

    fn get_blob_manifest(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let blob_id = required_string(value, "blobId")?;
        self.get_blob_manifest_value(blob_id)?
            .map(|manifest| serde_json::to_vec(&manifest))
            .transpose()?
            .ok_or_else(|| HistoryError::ObjectMissing(format!("blob manifest {blob_id}")))
    }

    fn get_blob_manifest_value(
        &self,
        blob_id: &str,
    ) -> Result<Option<serde_json::Value>, HistoryError> {
        self.get(CF_BLOBS, blob_manifest_key(blob_id).as_bytes())?
            .map(|bytes| serde_json::from_slice(&bytes).map_err(HistoryError::Serialization))
            .transpose()
    }

    fn delete_blob(
        &self,
        value: &serde_json::Value,
        batch: &mut WriteBatch,
    ) -> Result<Vec<u8>, HistoryError> {
        let blob_id = required_string(value, "blobId")?;
        let prefix = format!("c/{blob_id}/");
        let mut deleted = 0u64;
        for item in self.db.iterator_cf(
            self.cf(CF_BLOBS)?,
            rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward),
        ) {
            let (key, _) = item?;
            if !key.starts_with(prefix.as_bytes()) {
                break;
            }
            batch.delete_cf(self.cf(CF_BLOBS)?, key);
            deleted += 1;
        }
        let manifest_key = blob_manifest_key(blob_id);
        if self.get(CF_BLOBS, manifest_key.as_bytes())?.is_some() {
            batch.delete_cf(self.cf(CF_BLOBS)?, manifest_key.as_bytes());
            deleted += 1;
        }
        Ok(serde_json::to_vec(
            &serde_json::json!({"blobId":blob_id,"deleted":deleted}),
        )?)
    }

    fn asset_put(
        &self,
        value: &serde_json::Value,
        batch: &mut WriteBatch,
    ) -> Result<Vec<u8>, HistoryError> {
        let asset = value
            .get("asset")
            .cloned()
            .ok_or_else(|| HistoryError::InvalidCommand("asset is required".into()))?;
        let id = required_string(&asset, "id")?;
        let project_id = required_string(&asset, "projectId")?;
        let filename = required_string(&asset, "filename")?;
        let media_type = required_string(&asset, "mediaType")?;
        let size = asset
            .get("size")
            .and_then(|item| item.as_u64())
            .ok_or_else(|| HistoryError::InvalidCommand("asset size is required".into()))?;
        let sha256 = required_string(&asset, "sha256")?;
        let created_at = required_string(&asset, "createdAt")?;
        if id.len() > 128
            || project_id.len() > 256
            || filename.len() > 512
            || media_type.len() > 256
            || sha256.len() != 64
            || size > 50 * 1024 * 1024
        {
            return Err(HistoryError::InvalidCommand(
                "asset metadata exceeds bounds".into(),
            ));
        }
        let key = format!("a/{id}");
        if let Some(previous) = self.get(CF_ASSETS, key.as_bytes())? {
            let saved: serde_json::Value = serde_json::from_slice(&previous)?;
            if saved != asset {
                return Err(HistoryError::RequestConflict);
            }
        } else {
            batch.put_cf(
                self.cf(CF_ASSETS)?,
                key.as_bytes(),
                serde_json::to_vec(&asset)?,
            );
        }
        Ok(serde_json::to_vec(&serde_json::json!({
            "asset": asset,
            "createdAt": created_at,
        }))?)
    }

    fn asset_get(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let id = required_string(value, "assetId")?;
        self.get(CF_ASSETS, format!("a/{id}").as_bytes())?
            .ok_or_else(|| HistoryError::ObjectMissing(format!("asset {id}")))
    }

    fn asset_page(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let after = value["after"].as_str().unwrap_or("");
        let start = format!("a/{after}");
        let mut items = Vec::new();
        for entry in self.db.iterator_cf(self.cf(CF_ASSETS)?, rocksdb::IteratorMode::From(start.as_bytes(), rocksdb::Direction::Forward)) {
            let (key, bytes) = entry?;
            if !key.starts_with(b"a/") { break; }
            if !after.is_empty() && key.as_ref() <= start.as_bytes() { continue; }
            let asset: serde_json::Value = serde_json::from_slice(&bytes)?;
            let next = required_string(&asset, "id")?.to_owned();
            items.push(asset);
            if items.len() == 64 { return Ok(serde_json::to_vec(&serde_json::json!({"items":items,"next":next}))?); }
        }
        Ok(serde_json::to_vec(&serde_json::json!({"items":items,"next":null}))?)
    }

    fn asset_bind(
        &self,
        value: &serde_json::Value,
        batch: &mut WriteBatch,
    ) -> Result<Vec<u8>, HistoryError> {
        let asset_id = required_string(value, "assetId")?;
        let session_id = required_string(value, "sessionId")?;
        if self
            .get(CF_ASSETS, format!("a/{asset_id}").as_bytes())?
            .is_none()
        {
            return Err(HistoryError::ObjectMissing(format!("asset {asset_id}")));
        }
        let key = format!("b/{session_id}/{asset_id}");
        batch.put_cf(self.cf(CF_ASSET_BINDINGS)?, key.as_bytes(), b"1");
        Ok(serde_json::to_vec(
            &serde_json::json!({"assetId":asset_id,"sessionId":session_id,"bound":true}),
        )?)
    }

    fn asset_unbind(
        &self,
        value: &serde_json::Value,
        batch: &mut WriteBatch,
    ) -> Result<Vec<u8>, HistoryError> {
        let asset_id = required_string(value, "assetId")?;
        let session_id = required_string(value, "sessionId")?;
        batch.delete_cf(
            self.cf(CF_ASSET_BINDINGS)?,
            format!("b/{session_id}/{asset_id}").as_bytes(),
        );
        Ok(serde_json::to_vec(
            &serde_json::json!({"assetId":asset_id,"sessionId":session_id,"bound":false}),
        )?)
    }

    fn asset_has_binding(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let asset_id = required_string(value, "assetId")?;
        let session_id = required_string(value, "sessionId")?;
        let bound = self
            .get(
                CF_ASSET_BINDINGS,
                format!("b/{session_id}/{asset_id}").as_bytes(),
            )?
            .is_some();
        Ok(serde_json::to_vec(
            &serde_json::json!({"assetId":asset_id,"sessionId":session_id,"bound":bound}),
        )?)
    }

    fn asset_list_bindings(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let session_id = required_string(value, "sessionId")?;
        let prefix = format!("b/{session_id}/");
        let mut assets = Vec::new();
        for item in self.db.iterator_cf(
            self.cf(CF_ASSET_BINDINGS)?,
            rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward),
        ) {
            let (key, _) = item?;
            if !key.starts_with(prefix.as_bytes()) {
                break;
            }
            let key = String::from_utf8_lossy(&key);
            if let Some(asset_id) = key.strip_prefix(&prefix) {
                if let Some(bytes) = self.get(CF_ASSETS, format!("a/{asset_id}").as_bytes())? {
                    assets.push(serde_json::from_slice::<serde_json::Value>(&bytes)?);
                }
            }
        }
        Ok(serde_json::to_vec(&serde_json::json!({"items":assets}))?)
    }

    fn asset_delete(
        &self,
        value: &serde_json::Value,
        batch: &mut WriteBatch,
    ) -> Result<Vec<u8>, HistoryError> {
        let asset_id = required_string(value, "assetId")?;
        let asset_key = format!("a/{asset_id}");
        if self.get(CF_ASSETS, asset_key.as_bytes())?.is_none() {
            return Err(HistoryError::ObjectMissing(format!("asset {asset_id}")));
        }
        let prefix = format!("b/");
        for item in self.db.iterator_cf(
            self.cf(CF_ASSET_BINDINGS)?,
            rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward),
        ) {
            let (key, _) = item?;
            let key = String::from_utf8_lossy(&key);
            if key.ends_with(&format!("/{asset_id}")) {
                return Err(HistoryError::InvalidCommand(
                    "asset is retained by a session".into(),
                ));
            }
        }
        batch.delete_cf(self.cf(CF_ASSETS)?, asset_key.as_bytes());
        Ok(serde_json::to_vec(
            &serde_json::json!({"assetId":asset_id,"deleted":true}),
        )?)
    }

    fn head_read(&self, session_id: &str) -> Result<Vec<u8>, HistoryError> {
        let head = self.read_head(session_id)?;
        Ok(serde_json::to_vec(&head)?)
    }

    fn head_switch(
        &self,
        session_id: &str,
        value: &serde_json::Value,
        operation: &str,
        batch: &mut WriteBatch,
    ) -> Result<Vec<u8>, HistoryError> {
        let object_id = required_string(value, "objectId")?;
        if self
            .get(CF_OBJECTS, object_key(object_id).as_bytes())?
            .is_none()
        {
            return Err(HistoryError::ObjectMissing(object_id.to_owned()));
        }
        let mut head = self.read_head(session_id)?;
        if let Some(expected) = value.get("expectedRevision").and_then(|item| item.as_u64()) {
            if expected != head.revision {
                return Err(HistoryError::RevisionConflict {
                    expected,
                    actual: head.revision,
                });
            }
        }
        head.session_id = session_id.to_owned();
        if operation == "checkpoint" {
            let pin_id = value
                .get("pinId")
                .and_then(|item| item.as_str())
                .unwrap_or(object_id);
            let metadata = value
                .get("metadata")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            batch.put_cf(
                self.cf(CF_PINS)?,
                pin_key(session_id, pin_id).as_bytes(),
                serde_json::to_vec(&serde_json::json!({"objectId":object_id,"metadata":metadata}))?,
            );
            self.bump_root_epoch(batch)?;
            return Ok(serde_json::to_vec(
                &serde_json::json!({"pinId":pin_id,"objectId":object_id,"metadata":metadata}),
            )?);
        }
        head.object_id = Some(object_id.to_owned());
        head.revision += 1;
        head.updated_at = now_iso();
        batch.put_cf(
            self.cf(CF_HEADS)?,
            head_key(session_id).as_bytes(),
            serde_json::to_vec(&head)?,
        );
        self.bump_root_epoch(batch)?;
        self.rebuild_session_entities(session_id, object_id, batch)?;
        Ok(serde_json::to_vec(&head)?)
    }

    fn list_checkpoints(&self, session_id: &str, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let prefix = format!("p/{session_id}/");
        let after=value["cursor"]["after"].as_str().unwrap_or("");
        if !after.is_empty() && value["cursor"]["sessionId"]!=session_id {return Err(HistoryError::InvalidCommand("checkpoint cursor scope mismatch".into()));}
        let start=format!("{prefix}{after}");
        let mut items=Vec::new();let mut bytes=2048;let mut last=None;let mut more=false;
        for entry in self.db.iterator_cf(self.cf(CF_PINS)?, rocksdb::IteratorMode::From(start.as_bytes(),rocksdb::Direction::Forward)) {
            let (key,value)=entry?;
            if !key.starts_with(prefix.as_bytes()){break;}
            if !after.is_empty() && key.as_ref()<=start.as_bytes(){continue;}
            let saved:serde_json::Value=serde_json::from_slice(&value)?;
            let id=String::from_utf8_lossy(&key).trim_start_matches(&prefix).to_owned();
            let item=serde_json::json!({"id":id,"objectId":saved["objectId"],"metadata":saved["metadata"]});
            let cost=serde_json::to_vec(&item)?.len()+1;
            if items.len()==64 || bytes+cost>900*1024 {more=true;break;}
            bytes+=cost;last=Some(id);items.push(item);
        }
        let cursor=if more {last.map(|after|serde_json::json!({"sessionId":session_id,"after":after}))} else {None};
        Ok(serde_json::to_vec(&serde_json::json!({"items":items,"cursor":cursor}))?)
    }

    fn pin(
        &self,
        session_id: &str,
        value: &serde_json::Value,
        batch: &mut WriteBatch,
    ) -> Result<Vec<u8>, HistoryError> {
        let pin_id = required_string(value, "pinId")?;
        let object_id = required_string(value, "objectId")?;
        if self
            .get(CF_OBJECTS, object_key(object_id).as_bytes())?
            .is_none()
        {
            return Err(HistoryError::ObjectMissing(object_id.to_owned()));
        }
        batch.put_cf(
            self.cf(CF_PINS)?,
            pin_key(session_id, pin_id).as_bytes(),
            serde_json::to_vec(&serde_json::json!({"objectId":object_id,"metadata":{}}))?,
        );
        self.bump_root_epoch(batch)?;
        Ok(serde_json::to_vec(
            &serde_json::json!({"pinId":pin_id,"objectId":object_id}),
        )?)
    }

    fn fork(
        &self,
        target_session_id: &str,
        value: &serde_json::Value,
        batch: &mut WriteBatch,
    ) -> Result<Vec<u8>, HistoryError> {
        let source_session_id = required_string(value, "sourceSessionId")?;
        let source = self.read_head(source_session_id)?;
        let object_id = source
            .object_id
            .as_deref()
            .ok_or_else(|| HistoryError::InvalidCommand("source history has no head".into()))?;
        let target = self.read_head(target_session_id)?;
        if target.revision != 0 {
            return Err(HistoryError::RevisionConflict {
                expected: 0,
                actual: target.revision,
            });
        }
        let next = HistoryHead {
            session_id: target_session_id.to_owned(),
            object_id: Some(object_id.to_owned()),
            revision: 1,
            updated_at: now_iso(),
        };
        batch.put_cf(
            self.cf(CF_HEADS)?,
            head_key(target_session_id).as_bytes(),
            serde_json::to_vec(&next)?,
        );
        self.bump_root_epoch(batch)?;
        self.rebuild_session_entities(target_session_id, object_id, batch)?;
        Ok(serde_json::to_vec(
            &serde_json::json!({"sourceSessionId":source_session_id,"head":next}),
        )?)
    }

    fn unpin(
        &self,
        session_id: &str,
        value: &serde_json::Value,
        batch: &mut WriteBatch,
    ) -> Result<Vec<u8>, HistoryError> {
        let pin_id = required_string(value, "pinId")?;
        batch.delete_cf(self.cf(CF_PINS)?, pin_key(session_id, pin_id).as_bytes());
        self.bump_root_epoch(batch)?;
        Ok(serde_json::to_vec(
            &serde_json::json!({"pinId":pin_id,"removed":true}),
        )?)
    }

    fn page(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        if value.get("cursor").is_some() && value.get("objectId").is_some() {
            return Err(HistoryError::InvalidCommand(
                "history page cursor cannot be combined with objectId".into(),
            ));
        }
        let limit = match value.get("limit") {
            None => 64,
            Some(item) => item
                .as_u64()
                .filter(|limit| (1..=PAGE_LIMIT as u64).contains(limit))
                .ok_or_else(|| {
                    HistoryError::InvalidCommand(format!(
                        "history page limit must be between 1 and {PAGE_LIMIT}"
                    ))
                })? as usize,
        };
        let (mut queue, mut seen) = if let Some(cursor) = value.get("cursor") {
            if !cursor.is_object() {
                return Err(HistoryError::InvalidCommand(
                    "history page cursor must be an object".into(),
                ));
            }
            if cursor.get("version").and_then(|item| item.as_u64()) != Some(1) {
                return Err(HistoryError::InvalidCommand(
                    "history page cursor version is invalid".into(),
                ));
            }
            let queue = cursor["queue"]
                .as_array()
                .ok_or_else(|| {
                    HistoryError::InvalidCommand("history page cursor queue is required".into())
                })?
                .iter()
                .map(|item| item.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| {
                    HistoryError::InvalidCommand("history page cursor queue is invalid".into())
                })?;
            let seen = cursor["seen"]
                .as_array()
                .ok_or_else(|| {
                    HistoryError::InvalidCommand("history page cursor seen is required".into())
                })?
                .iter()
                .map(|item| item.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| {
                    HistoryError::InvalidCommand("history page cursor seen is invalid".into())
                })?;
            if queue.is_empty()
                || queue.len() > PAGE_CURSOR_MAX_ITEMS
                || seen.len() > PAGE_CURSOR_MAX_ITEMS
                || queue.len().saturating_add(seen.len()) > PAGE_CURSOR_MAX_ITEMS * 2
            {
                return Err(HistoryError::InvalidCommand(
                    "history page cursor exceeds bounds".into(),
                ));
            }
            let mut unique_seen = HashSet::with_capacity(seen.len());
            for object_id in queue.iter().chain(seen.iter()) {
                validate_object_id(object_id)?;
            }
            for object_id in &seen {
                if !unique_seen.insert(object_id) {
                    return Err(HistoryError::InvalidCommand(
                        "history page cursor seen contains duplicates".into(),
                    ));
                }
            }
            (VecDeque::from(queue), seen.into_iter().collect())
        } else {
            if value.get("cursor").is_none() && value.get("objectId").is_none() {
                return Err(HistoryError::InvalidCommand(
                    "history page objectId is required without a cursor".into(),
                ));
            }
            if value.get("objectId").is_none() {
                return Err(HistoryError::InvalidCommand(
                    "history page objectId is required without a cursor".into(),
                ));
            }
            let object_id = required_string(value, "objectId")?;
            validate_object_id(object_id)?;
            (VecDeque::from([object_id.to_owned()]), HashSet::new())
        };
        let mut objects = Vec::new();
        while objects.len() < limit {
            let Some(current) = queue.pop_front() else {
                break;
            };
            if !seen.insert(current.clone()) {
                continue;
            }
            let bytes = self.read_object(&current)?;
            let object: HistoryObject = serde_json::from_slice(&bytes)?;
            for reference in &object.refs {
                queue.push_back(reference.clone());
            }
            objects.push(object);
        }
        let cursor = if queue.is_empty() {
            None
        } else {
            Some(
                serde_json::json!({"version":1,"queue":queue,"seen":seen.into_iter().collect::<Vec<_>>() }),
            )
        };
        Ok(serde_json::to_vec(&serde_json::json!({
            "items": objects,
            "next": cursor.as_ref().and_then(|value| value["queue"].as_array()).and_then(|items| items.first()),
            "cursor": cursor,
        }))?)
    }

    fn index_entity(
        &self, scope: &str, object_id: &str, object_kind: &str,
        value: &serde_json::Value, batch: &mut WriteBatch,
    ) -> Result<(), HistoryError> {
        let Some(kind) = indexed_kind(object_kind,value) else { return Ok(()); };
        let owner = required_string(value, "sessionId")?;
        let id = required_string(value, "id")?;
        let identity_key = format!("{}id/{kind}/{}/{}", entity_prefix(scope), encode_hex(owner.as_bytes()), encode_hex(id.as_bytes()));
        if let Some(previous) = self.get(CF_ENTITIES, identity_key.as_bytes())? {
            let previous: EntityIndexEntry = serde_json::from_slice(&previous)?;
            batch.delete_cf(self.cf(CF_ENTITIES)?, previous.order_key.as_bytes());
        }
        if object_kind=="runtime.tombstone" {
            batch.delete_cf(self.cf(CF_ENTITIES)?,identity_key.as_bytes());
            return Ok(());
        }
        let order_key = format!("{}sort/{kind}/{}/{}/{}", entity_prefix(scope), entity_order(kind, value), encode_hex(id.as_bytes()), encode_hex(owner.as_bytes()));
        let entry = EntityIndexEntry { object_id: object_id.to_owned(), order_key };
        batch.put_cf(self.cf(CF_ENTITIES)?, entry.order_key.as_bytes(), object_id.as_bytes());
        batch.put_cf(self.cf(CF_ENTITIES)?, identity_key.as_bytes(), serde_json::to_vec(&entry)?);
        Ok(())
    }

    fn rebuild_session_entities(&self, session_id: &str, root: &str, batch: &mut WriteBatch) -> Result<(), HistoryError> {
        let prefix = entity_prefix(session_id);
        for row in self.db.iterator_cf(self.cf(CF_ENTITIES)?, rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward)) {
            let (key, _) = row?;
            if !key.starts_with(prefix.as_bytes()) { break; }
            batch.delete_cf(self.cf(CF_ENTITIES)?, key);
        }
        let mut stack = vec![root.to_owned()];
        let mut visited = HashSet::new();
        let mut entities = HashSet::new();
        while let Some(id) = stack.pop() {
            if !visited.insert(id.clone()) { continue; }
            let object: HistoryObject = serde_json::from_slice(&self.read_object(&id)?)?;
            stack.extend(object.refs.iter().rev().cloned());
            if let Some(kind) = indexed_kind(&object.kind,&object.value) {
                let owner = required_string(&object.value, "sessionId")?;
                let entity = required_string(&object.value, "id")?;
                if entities.insert((kind, owner.to_owned(), entity.to_owned())) {
                    self.index_entity(session_id, &object.object_id, &object.kind, &object.value, batch)?;
                }
            }
        }
        batch.put_cf(self.cf(CF_ENTITIES)?, entity_head_key(session_id), root.as_bytes());
        Ok(())
    }

    fn require_entity_index(&self, session_id: &str, head: &HistoryHead) -> Result<(), HistoryError> {
        if let Some(root) = &head.object_id {
            if self.get(CF_ENTITIES, entity_head_key(session_id).as_bytes())?.as_deref() != Some(root.as_bytes()) {
                return Err(HistoryError::InvalidCommand("current history index is missing; rebuild_index required".into()));
            }
        }
        Ok(())
    }

    fn list_indexed(&self, session_id: &str, kind: &str, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let head = self.read_head(session_id)?;
        self.require_entity_index(session_id, &head)?;
        let reverse = value["reverse"].as_bool().unwrap_or(matches!(kind, "run" | "plan"));
        let limit = value["limit"].as_u64().unwrap_or(128).clamp(1, PAGE_LIMIT as u64) as usize;
        let max_bytes = value["maxBytes"].as_u64().unwrap_or(512 * 1024).clamp(8192, ENTITY_PAGE_BYTES as u64) as usize;
        let prefix = format!("{}sort/{kind}/", entity_prefix(session_id));
        let cursor: Option<EntityCursor> = value.get("cursor").filter(|v| !v.is_null())
            .map(|v| serde_json::from_value(v.clone())).transpose()?;
        if let Some(cursor) = &cursor {
            if cursor.session_id != session_id || cursor.kind != kind || cursor.reverse != reverse || !cursor.after.starts_with(&prefix) {
                return Err(HistoryError::InvalidCommand("history entity cursor scope mismatch".into()));
            }
            if cursor.revision != head.revision {
                return Err(HistoryError::RevisionConflict { expected: cursor.revision, actual: head.revision });
            }
        }
        let start = cursor.as_ref().map(|c| c.after.clone()).unwrap_or_else(|| if reverse { format!("{prefix}~") } else { prefix.clone() });
        let direction = if reverse { rocksdb::Direction::Reverse } else { rocksdb::Direction::Forward };
        let mut items = Vec::new();
        let mut used = 4096; // Envelope and cursor are reserved before any body is read.
        let mut last_key = None;
        let mut more = false;
        for row in self.db.iterator_cf(self.cf(CF_ENTITIES)?, rocksdb::IteratorMode::From(start.as_bytes(), direction)) {
            let (key, reference) = row?;
            if !key.starts_with(prefix.as_bytes()) { break; }
            if cursor.as_ref().is_some_and(|c| c.after.as_bytes() == key.as_ref()) { continue; }
            if items.len() == limit { more = true; break; }
            let object: HistoryObject = serde_json::from_slice(&self.read_object(&String::from_utf8_lossy(&reference))?)?;
            let size = serde_json::to_vec(&object.value)?.len() + 1;
            if used + size > max_bytes {
                if items.is_empty() { return Err(HistoryError::InvalidCommand("entity exceeds history page byte budget".into())); }
                more = true; break;
            }
            used += size;
            last_key = Some(String::from_utf8_lossy(&key).into_owned());
            items.push(object.value);
        }
        let next = if more { last_key.map(|after| EntityCursor { session_id: session_id.to_owned(), kind: kind.to_owned(), revision: head.revision, reverse, after }) } else { None };
        Ok(serde_json::to_vec(&serde_json::json!({"items":items,"cursor":next,"revision":head.revision}))?)
    }

    fn verify(&self) -> Result<Vec<u8>, HistoryError> {
        let mut objects = 0u64;
        let mut invalid = Vec::new();
        for item in self
            .db
            .iterator_cf(self.cf(CF_OBJECTS)?, rocksdb::IteratorMode::Start)
        {
            let (key, value) = item?;
            match serde_json::from_slice::<HistoryObject>(&value) {
                Ok(object) => {
                    objects += 1;
                    let key_id = String::from_utf8_lossy(&key)
                        .trim_start_matches("o/")
                        .to_owned();
                    let identity = serde_json::to_vec(&(
                        object.kind.clone(),
                        object.value.clone(),
                        object.refs.clone(),
                    ))?;
                    let digest_id = format!("sha256:{:x}", Sha256::digest(&identity));
                    if object.object_id != key_id || object.object_id != digest_id {
                        invalid.push(format!("{key_id}:content-hash"));
                    }
                    for reference in &object.refs {
                        if self
                            .get(CF_OBJECTS, object_key(reference).as_bytes())?
                            .is_none()
                        {
                            invalid.push(format!("{key_id}:missing-ref:{reference}"));
                        }
                    }
                }
                Err(_) => invalid.push(String::from_utf8_lossy(&key).to_string()),
            }
        }
        for item in self
            .db
            .iterator_cf(self.cf(CF_HEADS)?, rocksdb::IteratorMode::Start)
        {
            let (key, value) = item?;
            let head: HistoryHead = serde_json::from_slice(&value)?;
            if let Some(object_id) = head.object_id.as_deref() {
                if self
                    .get(CF_OBJECTS, object_key(object_id).as_bytes())?
                    .is_none()
                {
                    invalid.push(format!(
                        "{}:missing-head:{object_id}",
                        String::from_utf8_lossy(&key)
                    ));
                }
            }
        }
        for item in self
            .db
            .iterator_cf(self.cf(CF_PINS)?, rocksdb::IteratorMode::Start)
        {
            let (key, value) = item?;
            let object_id = serde_json::from_slice::<serde_json::Value>(&value)
                .ok()
                .and_then(|saved| saved["objectId"].as_str().map(str::to_owned))
                .unwrap_or_else(|| String::from_utf8_lossy(&value).to_string());
            if self
                .get(CF_OBJECTS, object_key(&object_id).as_bytes())?
                .is_none()
            {
                invalid.push(format!(
                    "{}:missing-pin:{object_id}",
                    String::from_utf8_lossy(&key)
                ));
            }
        }
        Ok(serde_json::to_vec(
            &serde_json::json!({"objects":objects,"invalid":invalid,"ok":invalid.is_empty()}),
        )?)
    }

    fn rebuild_index(&self, batch: &mut WriteBatch) -> Result<Vec<u8>, HistoryError> {
        let mut sessions = 0u64;
        for item in self
            .db
            .iterator_cf(self.cf(CF_HEADS)?, rocksdb::IteratorMode::Start)
        {
            let (key, value) = item?;
            let session_id = String::from_utf8_lossy(&key)
                .trim_start_matches("h/")
                .to_owned();
            batch.put_cf(
                self.cf(CF_INDEXES)?,
                format!("session/{session_id}").as_bytes(),
                &value,
            );
            let head: HistoryHead = serde_json::from_slice(&value)?;
            if let Some(root) = &head.object_id {
                self.rebuild_session_entities(&session_id, root, batch)?;
            }
            sessions += 1;
        }
        Ok(serde_json::to_vec(
            &serde_json::json!({"sessions":sessions,"rebuilt":true}),
        )?)
    }

    /// Advance a resumable mark/sweep GC by a bounded number of records.
    ///
    /// The queue, mark set, phase and iterator keys are all persisted in
    /// RocksDB. A process crash therefore resumes the current phase instead
    /// of restarting a full graph walk. Each invocation performs only a small
    /// batch while holding the maintenance lock, so normal history operations
    /// are blocked for a bounded window rather than for a full database scan.
    fn gc(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let budget = value
            .get("batchSize")
            .or_else(|| value.get("limit"))
            .map(|item| {
                item.as_u64()
                    .filter(|size| (1..=GC_MAX_BATCH as u64).contains(size))
                    .ok_or_else(|| {
                        HistoryError::InvalidCommand(format!(
                            "history gc batchSize must be between 1 and {GC_MAX_BATCH}"
                        ))
                    })
            })
            .transpose()?
            .unwrap_or(GC_DEFAULT_BATCH as u64) as usize;
        let epoch = self.gc_epoch()?;
        let state_key = b"state";
        let mut state = self
            .get(CF_GC_STATE, state_key)?
            .map(|bytes| serde_json::from_slice::<GcState>(&bytes))
            .transpose()?;
        let restart = state
            .as_ref()
            .is_some_and(|saved| saved.phase == "done" || saved.root_epoch != epoch);
        if restart {
            state = Some(GcState {
                phase: "reset".into(),
                source: 0,
                key: Vec::new(),
                queue_head: 0,
                queue_tail: 0,
                root_epoch: epoch.clone(),
                marked: 0,
                scanned: 0,
                deleted: 0,
            });
        } else if state.is_none() {
            state = Some(GcState {
                phase: "reset".into(),
                source: 0,
                key: Vec::new(),
                queue_head: 0,
                queue_tail: 0,
                root_epoch: epoch.clone(),
                marked: 0,
                scanned: 0,
                deleted: 0,
            });
        }
        let mut state = state.expect("gc state initialized");
        let mut steps = 0usize;
        while steps < budget {
            let progressed = match state.phase.as_str() {
                "reset" => self.gc_reset_step(&mut state)?,
                "roots" => self.gc_roots_step(&mut state)?,
                "mark" => self.gc_mark_step(&mut state)?,
                "sweep" => self.gc_sweep_step(&mut state)?,
                "index" => self.gc_index_step(&mut state)?,
                "done" => false,
                phase => {
                    return Err(HistoryError::InvalidCommand(format!(
                        "invalid persisted history gc phase: {phase}"
                    )));
                }
            };
            self.persist_gc_state(&state)?;
            steps += 1;
            if !progressed {
                break;
            }
        }
        let pending = state.phase != "done";
        Ok(serde_json::to_vec(&serde_json::json!({
            "phase": state.phase,
            "pending": pending,
            "marked": state.marked,
            "scanned": state.scanned,
            "deleted": state.deleted,
            "batchSize": budget,
            "queueDepth": state.queue_tail.saturating_sub(state.queue_head),
        }))?)
    }

    fn gc_reset_step(&self, state: &mut GcState) -> Result<bool, HistoryError> {
        let (cf_name, next_source) = if state.source == 0 {
            (CF_GC_MARKS, 1)
        } else {
            (CF_GC_QUEUE, 2)
        };
        let item = self.next_after(cf_name, &state.key)?;
        let Some((key, _)) = item else {
            if state.source == 0 {
                state.source = next_source;
                state.key.clear();
                return Ok(true);
            }
            state.phase = "roots".into();
            state.source = 0;
            state.key.clear();
            return Ok(true);
        };
        let mut batch = WriteBatch::default();
        batch.delete_cf(self.cf(cf_name)?, &key);
        state.key = key;
        self.commit_gc_step(batch, state)?;
        Ok(true)
    }

    fn gc_roots_step(&self, state: &mut GcState) -> Result<bool, HistoryError> {
        let cf_name = match state.source {
            0 => CF_HEADS,
            1 => CF_PINS,
            2 => CF_OUTBOX,
            _ => {
                state.phase = "mark".into();
                state.source = 0;
                state.key.clear();
                return Ok(true);
            }
        };
        let item = self.next_after(cf_name, &state.key)?;
        let Some((key, value)) = item else {
            state.source += 1;
            state.key.clear();
            return Ok(true);
        };
        let mut roots = Vec::new();
        if cf_name == CF_HEADS {
            if let Ok(head) = serde_json::from_slice::<HistoryHead>(&value) {
                if let Some(object_id) = head.object_id {
                    roots.push(object_id);
                }
            }
        } else if cf_name == CF_PINS {
            if let Ok(saved) = serde_json::from_slice::<serde_json::Value>(&value) {
                collect_object_roots(&saved, &mut roots);
            } else if let Ok(object_id) = String::from_utf8(value.clone()) {
                roots.push(object_id);
            }
        } else if let Ok(saved) = serde_json::from_slice::<serde_json::Value>(&value) {
            collect_object_roots(&saved, &mut roots);
        }
        let mut batch = WriteBatch::default();
        for object_id in roots {
            if validate_object_id(&object_id).is_ok() {
                let key = format!("q/{:020}", state.queue_tail);
                batch.put_cf(self.cf(CF_GC_QUEUE)?, key.as_bytes(), object_id.as_bytes());
                state.queue_tail = state.queue_tail.saturating_add(1);
            }
        }
        state.key = key;
        self.commit_gc_step(batch, state)?;
        Ok(true)
    }

    fn gc_mark_step(&self, state: &mut GcState) -> Result<bool, HistoryError> {
        if state.queue_head >= state.queue_tail {
            state.phase = "sweep".into();
            state.source = 0;
            state.key.clear();
            return Ok(true);
        }
        let queue_key = format!("q/{:020}", state.queue_head);
        state.queue_head = state.queue_head.saturating_add(1);
        let object_id = self
            .get(CF_GC_QUEUE, queue_key.as_bytes())?
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string());
        let mut batch = WriteBatch::default();
        batch.delete_cf(self.cf(CF_GC_QUEUE)?, queue_key.as_bytes());
        let Some(object_id) = object_id else {
            self.commit_gc_step(batch, state)?;
            return Ok(true);
        };
        if validate_object_id(&object_id).is_err()
            || self
                .get(CF_GC_MARKS, mark_key(&object_id).as_bytes())?
                .is_some()
        {
            self.commit_gc_step(batch, state)?;
            return Ok(true);
        }
        batch.put_cf(self.cf(CF_GC_MARKS)?, mark_key(&object_id).as_bytes(), b"1");
        state.marked = state.marked.saturating_add(1);
        if let Ok(bytes) = self.read_object(&object_id) {
            if let Ok(object) = serde_json::from_slice::<HistoryObject>(&bytes) {
                for reference in object.refs {
                    if validate_object_id(&reference).is_ok() {
                        let key = format!("q/{:020}", state.queue_tail);
                        batch.put_cf(self.cf(CF_GC_QUEUE)?, key.as_bytes(), reference.as_bytes());
                        state.queue_tail = state.queue_tail.saturating_add(1);
                    }
                }
            }
        }
        self.commit_gc_step(batch, state)?;
        Ok(true)
    }

    fn gc_sweep_step(&self, state: &mut GcState) -> Result<bool, HistoryError> {
        let item = self.next_after(CF_OBJECTS, &state.key)?;
        let Some((key, _)) = item else {
            state.phase = "index".into();
            state.key.clear();
            return Ok(true);
        };
        let object_id = String::from_utf8_lossy(&key)
            .strip_prefix("o/")
            .unwrap_or_default()
            .to_owned();
        let mut batch = WriteBatch::default();
        if self
            .get(CF_GC_MARKS, mark_key(&object_id).as_bytes())?
            .is_none()
        {
            batch.delete_cf(self.cf(CF_OBJECTS)?, &key);
            state.deleted = state.deleted.saturating_add(1);
        }
        state.scanned = state.scanned.saturating_add(1);
        state.key = key;
        self.commit_gc_step(batch, state)?;
        Ok(true)
    }

    fn gc_index_step(&self, state: &mut GcState) -> Result<bool, HistoryError> {
        let item = self.next_after(CF_INDEXES, &state.key)?;
        let Some((key, value)) = item else {
            state.phase = "done".into();
            state.key.clear();
            return Ok(true);
        };
        let mut batch = WriteBatch::default();
        if self
            .get(
                CF_OBJECTS,
                object_key(&String::from_utf8_lossy(&value)).as_bytes(),
            )?
            .is_none()
        {
            batch.delete_cf(self.cf(CF_INDEXES)?, &key);
        }
        state.key = key;
        self.commit_gc_step(batch, state)?;
        Ok(true)
    }

    fn persist_gc_state(&self, state: &GcState) -> Result<(), HistoryError> {
        let mut batch = WriteBatch::default();
        batch.put_cf(self.cf(CF_GC_STATE)?, b"state", serde_json::to_vec(state)?);
        self.commit_gc_batch(batch)
    }

    fn commit_gc_step(
        &self,
        mut batch: WriteBatch,
        state: &GcState,
    ) -> Result<(), HistoryError> {
        batch.put_cf(self.cf(CF_GC_STATE)?, b"state", serde_json::to_vec(state)?);
        self.commit_gc_batch(batch)
    }

    fn commit_gc_batch(&self, batch: WriteBatch) -> Result<(), HistoryError> {
        let mut options = WriteOptions::default();
        options.set_sync(true);
        self.db.write_opt(batch, &options)?;
        Ok(())
    }

    fn next_after(
        &self,
        cf_name: &str,
        key: &[u8],
    ) -> Result<Option<(Vec<u8>, Vec<u8>)>, HistoryError> {
        let start = if key.is_empty() {
            rocksdb::IteratorMode::Start
        } else {
            rocksdb::IteratorMode::From(key, rocksdb::Direction::Forward)
        };
        for item in self.db.iterator_cf(self.cf(cf_name)?, start) {
            let (candidate, value) = item?;
            if key.is_empty() || candidate.as_ref() > key {
                return Ok(Some((candidate.to_vec(), value.to_vec())));
            }
        }
        Ok(None)
    }

    fn gc_epoch(&self) -> Result<String, HistoryError> {
        Ok(self
            .get(CF_GC_STATE, b"epoch")?
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
            .unwrap_or_else(|| "0".into()))
    }

    fn bump_root_epoch(&self, batch: &mut WriteBatch) -> Result<(), HistoryError> {
        let current = self
            .get(CF_GC_STATE, b"epoch")?
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_add(1);
        batch.put_cf(
            self.cf(CF_GC_STATE)?,
            b"epoch",
            current.to_string().as_bytes(),
        );
        Ok(())
    }

    fn read_object(&self, object_id: &str) -> Result<Vec<u8>, HistoryError> {
        self.get(CF_OBJECTS, object_key(object_id).as_bytes())?
            .ok_or_else(|| HistoryError::ObjectMissing(object_id.to_owned()))
    }

    fn read_head(&self, session_id: &str) -> Result<HistoryHead, HistoryError> {
        let Some(bytes) = self.get(CF_HEADS, head_key(session_id).as_bytes())? else {
            return Ok(HistoryHead {
                session_id: session_id.to_owned(),
                ..HistoryHead::default()
            });
        };
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn cf(&self, name: &str) -> Result<&rocksdb::ColumnFamily, HistoryError> {
        self.db
            .cf_handle(name)
            .ok_or_else(|| HistoryError::InvalidCommand(format!("missing column family: {name}")))
    }

    fn get(&self, cf: &str, key: &[u8]) -> Result<Option<Vec<u8>>, HistoryError> {
        Ok(self.db.get_cf(self.cf(cf)?, key)?)
    }
}

fn entity_index_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "runtime.run" => Some("run"),
        "runtime.message" => Some("message"),
        "runtime.step" => Some("step"),
        "runtime.part" => Some("part"),
        "runtime.tool_call" => Some("tool"),
        "runtime.event" => Some("event"),
        "runtime.artifact" => Some("artifact"),
        "runtime.plan" => Some("plan"),
        "runtime.work" => Some("work"),
        "runtime.context" => Some("context"),
        "runtime.aux_usage" => Some("aux"),
        "runtime.thinking" => Some("thinking"),
        "runtime.compaction" => Some("compaction"),
        "runtime.permission" => Some("permission"),
        "runtime.interaction" => Some("interaction"),
        "runtime.file_change" => Some("file_change"),
        "runtime.terminal" => Some("terminal"),
        _ => None,
    }
}
fn indexed_kind(kind:&str,value:&serde_json::Value)->Option<&'static str> {
    entity_index_kind(if kind=="runtime.tombstone" {value["entityKind"].as_str()?} else {kind})
}

fn entity_prefix(session_id: &str) -> String {
    format!("s/{}/", encode_hex(session_id.as_bytes()))
}
fn entity_head_key(session_id: &str) -> String { format!("{}head", entity_prefix(session_id)) }
fn entity_order(kind: &str, value: &serde_json::Value) -> String {
    let number = match kind {
        "message" | "part" | "file_change" => value["sequence"].as_u64(),
        "plan" => value["revision"].as_u64(),
        _ => None,
    };
    if let Some(number) = number { return format!("0/{number:020}"); }
    let timestamp = ["createdAt", "startedAt", "timestamp"].iter()
        .find_map(|field| value[*field].as_str()).unwrap_or("");
    format!("1/{}", encode_hex(timestamp.as_bytes()))
}

fn required_string<'a>(value: &'a serde_json::Value, key: &str) -> Result<&'a str, HistoryError> {
    value[key]
        .as_str()
        .filter(|item| !item.is_empty())
        .ok_or_else(|| HistoryError::InvalidCommand(format!("{key} is required")))
}

fn required_u64(value: &serde_json::Value, key: &str) -> Result<u64, HistoryError> {
    value[key]
        .as_u64()
        .ok_or_else(|| HistoryError::InvalidCommand(format!("{key} is required")))
}

fn validate_object_id(object_id: &str) -> Result<(), HistoryError> {
    let digest = object_id
        .strip_prefix("sha256:")
        .filter(|digest| digest.len() == 64)
        .ok_or_else(|| HistoryError::InvalidCommand("history object id is invalid".into()))?;
    if !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(HistoryError::InvalidCommand(
            "history object id is invalid".into(),
        ));
    }
    Ok(())
}

fn mark_key(object_id: &str) -> String {
    format!("m/{object_id}")
}

fn collect_object_roots(value: &serde_json::Value, roots: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                if matches!(key.as_str(), "objectId" | "object_id") {
                    if let Some(object_id) = child.as_str() {
                        roots.push(object_id.to_owned());
                    }
                }
                collect_object_roots(child, roots);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items {
                collect_object_roots(child, roots);
            }
        }
        _ => {}
    }
}

fn decode_hex(value: &str) -> Result<Vec<u8>, HistoryError> {
    if value.len() % 2 != 0 {
        return Err(HistoryError::InvalidCommand(
            "hex payload must have an even length".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    let chars = value.as_bytes();
    for index in (0..chars.len()).step_by(2) {
        let high = (chars[index] as char)
            .to_digit(16)
            .ok_or_else(|| HistoryError::InvalidCommand("invalid hex payload".into()))?;
        let low = (chars[index + 1] as char)
            .to_digit(16)
            .ok_or_else(|| HistoryError::InvalidCommand("invalid hex payload".into()))?;
        bytes.push(((high << 4) | low) as u8);
    }
    Ok(bytes)
}

fn encode_hex(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn object_key(object_id: &str) -> String {
    format!("o/{object_id}")
}
fn head_key(session_id: &str) -> String {
    format!("h/{session_id}")
}
fn pin_key(session_id: &str, pin_id: &str) -> String {
    format!("p/{session_id}/{pin_id}")
}
fn blob_chunk_key(blob_id: &str, index: u64) -> String {
    format!("c/{blob_id}/{index:08}")
}
fn blob_manifest_key(blob_id: &str) -> String {
    format!("m/{blob_id}")
}
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "synax-runtime-history-{label}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn invoke(
        store: &HistoryStore,
        session: &str,
        request: &str,
        operation: &str,
        payload: serde_json::Value,
    ) -> serde_json::Value {
        serde_json::from_slice(
            &store
                .command(
                    session,
                    request,
                    operation,
                    &serde_json::to_vec(&payload).unwrap(),
                )
                .unwrap(),
        )
        .unwrap()
    }

    fn entity(id: &str, text: &str) -> serde_json::Value {
        serde_json::json!({"kind":"runtime.message","value":{"id":id,"sessionId":"s","content":text,"sequence":1}})
    }

    #[test]
    fn append_is_atomic_replayable_and_reachable_after_restart() {
        let path = temp_path("append-atomic");
        let store = HistoryStore::open(&path).unwrap();
        let payload = serde_json::json!({"objects":[entity("m", "hello")]});
        let first = invoke(&store, "s", "append", "append_entities", payload.clone());
        assert_eq!(first["revision"], 1);
        assert_eq!(
            invoke(&store, "s", "read", "list_messages", serde_json::json!({}))["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        // No subset of a rejected multi-entity command may be published, even
        // though the first object has already been staged in its WriteBatch.
        assert!(store.command("s", "bad", "append_entities", &serde_json::to_vec(&serde_json::json!({"objects":[entity("orphan", "no"), {"kind":"runtime.message","value":{"id":"foreign","sessionId":"other"}}]})).unwrap()).is_err());
        assert_eq!(
            invoke(&store, "s", "read", "head_read", serde_json::json!({})),
            first
        );
        assert_eq!(
            invoke(&store, "s", "verify", "verify", serde_json::json!({}))["objects"],
            2
        );
        assert!(store.get(CF_RECEIPTS, b"r/s/bad").unwrap().is_none());
        drop(store);
        let store = HistoryStore::open(&path).unwrap();
        assert_eq!(
            invoke(&store, "s", "append", "append_entities", payload),
            first
        );
        assert!(matches!(
            store.command(
                "s",
                "append",
                "append_entities",
                &serde_json::to_vec(&serde_json::json!({"objects":[entity("m", "changed")]}))
                    .unwrap()
            ),
            Err(HistoryError::RequestConflict)
        ));
        assert_eq!(
            invoke(&store, "s", "gc", "gc", serde_json::json!({}))["deleted"],
            0
        );
        assert_eq!(
            invoke(&store, "s", "read", "list_messages", serde_json::json!({}))["items"][0]["content"],
            "hello"
        );
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_appends_do_not_lose_entities_and_duplicate_commands_commit_once() {
        let path = temp_path("append-concurrent");
        let store = HistoryStore::open(&path).unwrap();
        let mut tasks = tokio::task::JoinSet::new();
        for i in 0..64 {
            let clone = store.clone();
            tasks.spawn(async move {
                clone.command_async("s".into(), format!("append-{}", i % 32), "append_entities".into(),
                    serde_json::to_vec(&serde_json::json!({"objects":[entity(&format!("m-{}", i % 32), "value")]})).unwrap()).await.unwrap();
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
        assert_eq!(
            invoke(&store, "s", "read", "head_read", serde_json::json!({}))["revision"],
            32
        );
        assert_eq!(
            invoke(&store, "s", "read", "list_messages", serde_json::json!({}))["items"]
                .as_array()
                .unwrap()
                .len(),
            32
        );
        assert_eq!(
            invoke(&store, "s", "verify", "verify", serde_json::json!({}))["ok"],
            true
        );
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn reads_are_fresh_without_receipts_and_history_selects_latest_reachable_versions() {
        let path = temp_path("fresh-reads");
        let store = HistoryStore::open(&path).unwrap();
        let read = serde_json::json!({});
        assert_eq!(
            invoke(&store, "s", "same-query-id", "list_messages", read.clone())["items"],
            serde_json::json!([])
        );
        // Simulate a persisted query receipt from the old implementation.
        let key = b"r/s/same-query-id";
        store
            .db
            .put_cf(
                store.cf(CF_RECEIPTS).unwrap(),
                key,
                serde_json::to_vec(&HistoryReceipt {
                    identity: "old".into(),
                    result: b"{\"items\":[]}".to_vec(),
                })
                .unwrap(),
            )
            .unwrap();
        let first = invoke(
            &store,
            "s",
            "first",
            "append_entities",
            serde_json::json!({"objects":[entity("m", "old")]}),
        );
        invoke(
            &store,
            "s",
            "pin",
            "checkpoint",
            serde_json::json!({"pinId":"cp", "objectId":first["objectId"]}),
        );
        invoke(
            &store,
            "s",
            "next",
            "append_entities",
            serde_json::json!({"objects":[entity("m", "new"), entity("n", "second")]}),
        );
        let messages = invoke(&store, "s", "same-query-id", "list_messages", read.clone());
        assert_eq!(messages["items"].as_array().unwrap().len(), 2);
        assert_eq!(messages["items"][0]["content"], "new");
        let before = store
            .db
            .iterator_cf(store.cf(CF_RECEIPTS).unwrap(), rocksdb::IteratorMode::Start)
            .count();
        for i in 0..50 {
            invoke(&store, "s", &format!("poll-{i}"), "head_read", read.clone());
        }
        assert_eq!(
            store
                .db
                .iterator_cf(store.cf(CF_RECEIPTS).unwrap(), rocksdb::IteratorMode::Start)
                .count(),
            before
        );
        let rolled = invoke(
            &store,
            "s",
            "rollback",
            "head_switch",
            serde_json::json!({"objectId":first["objectId"], "expectedRevision":2}),
        );
        assert_eq!(
            invoke(&store, "s", "same-query-id", "list_messages", read.clone())["items"],
            serde_json::json!([entity("m", "old")["value"]])
        );
        assert_eq!(
            invoke(
                &store,
                "s",
                "rollback",
                "head_switch",
                serde_json::json!({"objectId":first["objectId"], "expectedRevision":2})
            ),
            rolled
        );
        assert!(matches!(store.command("s", "stale-append", "append_entities", &serde_json::to_vec(&serde_json::json!({"expectedRevision":2,"objects":[entity("n", "wrong branch")]})).unwrap()), Err(HistoryError::RevisionConflict { .. })));
        invoke(
            &store,
            "s",
            "branch",
            "append_entities",
            serde_json::json!({"objects":[entity("n", "branch")]}),
        );
        assert_eq!(
            invoke(&store, "s", "same-query-id", "list_messages", read)["items"][0]["content"],
            "old"
        );
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn protocol_float_precision_survives_persistence_and_reopen() {
        let path = temp_path("numeric-roundtrip");
        let store = HistoryStore::open(&path).unwrap();
        store.command("s", "write", "append_entities", br#"{"objects":[{"kind":"runtime.step","value":{"id":"step","sessionId":"s","metadata":{"create_time":1792047838.6933553}}}]}"#).unwrap();
        drop(store);
        let store = HistoryStore::open(&path).unwrap();
        let page = invoke(&store, "s", "read", "list_steps", serde_json::json!({}));
        assert_eq!(page["items"][0]["metadata"]["create_time"].as_f64().unwrap().to_bits(), 1792047838.6933553_f64.to_bits());
        assert_eq!(invoke(&store, "system", "verify", "verify", serde_json::json!({}))["ok"], true);
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn entity_pages_bound_bytes_preserve_order_and_survive_restart() {
        let path = temp_path("entity-pages");
        let store = HistoryStore::open(&path).unwrap();
        let objects: Vec<_> = (1..=24).map(|i| serde_json::json!({"kind":"runtime.step","value":{
            "id":format!("step-{i:03}"),"sessionId":"s","startedAt":format!("2026-10-18T00:00:{i:02}Z"),"metadata":{"evidence":"x".repeat(100_000)}
        }})).collect();
        invoke(&store, "s", "append", "append_entities", serde_json::json!({"objects":objects}));
        drop(store);
        let store = HistoryStore::open(&path).unwrap();
        for reverse in [false, true] {
            let mut cursor = serde_json::Value::Null;
            let mut ids = Vec::new();
            loop {
                let page = invoke(&store, "s", "page", "list_steps", serde_json::json!({"cursor":cursor,"reverse":reverse,"maxBytes":240_000}));
                assert!(serde_json::to_vec(&page).unwrap().len() <= 240_000);
                let items = page["items"].as_array().unwrap();
                assert!(!items.is_empty() && items.len() <= 2);
                for item in items {
                    assert_eq!(item["metadata"]["evidence"].as_str().unwrap().len(), 100_000);
                    ids.push(item["id"].as_str().unwrap().to_owned());
                }
                cursor = page["cursor"].clone();
                if cursor.is_null() { break; }
            }
            let mut expected: Vec<_> = (1..=24).map(|i| format!("step-{i:03}")).collect();
            if reverse { expected.reverse(); }
            assert_eq!(ids, expected);
        }
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn visible_index_changes_atomically_with_head_and_rejects_stale_pages() {
        let path = temp_path("entity-head-index");
        let store = HistoryStore::open(&path).unwrap();
        let entity = |id: &str, sequence: u64| serde_json::json!({"kind":"runtime.message","value":{"id":id,"sessionId":"s","sequence":sequence}});
        let first = invoke(&store, "s", "first", "append_entities", serde_json::json!({"objects":[entity("a",1),entity("b",2)]}));
        let page = invoke(&store, "s", "page", "list_messages", serde_json::json!({"limit":1}));
        invoke(&store, "s", "staged", "put_object", entity("not-published", 0));
        assert_eq!(invoke(&store, "s", "stable", "list_messages", serde_json::json!({}))["items"].as_array().unwrap().len(), 2);
        invoke(&store, "fork", "fork", "fork", serde_json::json!({"sourceSessionId":"s"}));
        invoke(&store, "s", "replace", "append_entities", serde_json::json!({"objects":[entity("a",3),entity("a",4)]}));
        let updated = invoke(&store, "s", "updated", "list_messages", serde_json::json!({}));
        assert_eq!(updated["items"].as_array().unwrap().len(), 2);
        assert_eq!(updated["items"][0]["id"], "b");
        assert_eq!(updated["items"][1]["sequence"], 4);
        assert!(matches!(store.command("s", "stale", "list_messages", &serde_json::to_vec(&serde_json::json!({"cursor":page["cursor"]})).unwrap()), Err(HistoryError::RevisionConflict { .. })));
        assert_eq!(invoke(&store, "fork", "isolated", "list_messages", serde_json::json!({}))["items"][0]["sequence"], 1);
        invoke(&store, "s", "rollback", "head_switch", serde_json::json!({"objectId":first["objectId"]}));
        invoke(&store, "system", "rebuild", "rebuild_index", serde_json::json!({}));
        assert_eq!(invoke(&store, "s", "restored", "list_messages", serde_json::json!({}))["items"], serde_json::json!([entity("a",1)["value"],entity("b",2)["value"]]));
        invoke(&store,"s","remove","append_entities",serde_json::json!({"objects":[{"kind":"runtime.tombstone","value":{"id":"a","sessionId":"s","entityKind":"runtime.message"}}]}));
        invoke(&store,"system","rebuild-deleted","rebuild_index",serde_json::json!({}));
        assert_eq!(invoke(&store,"s","without-a","list_messages",serde_json::json!({}))["items"],serde_json::json!([entity("b",2)["value"]]));
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn page_cursor_walks_the_entire_graph_without_repeating_nodes() {
        let path = temp_path("page-cursor");
        let store = HistoryStore::open(&path).unwrap();
        let first = invoke(
            &store,
            "s",
            "first",
            "put_object",
            serde_json::json!({"kind":"runtime.message","value":{"id":"m1","sessionId":"s","sequence":1}}),
        );
        let second = invoke(
            &store,
            "s",
            "second",
            "put_object",
            serde_json::json!({"kind":"runtime.message","value":{"id":"m2","sessionId":"s","sequence":2},"refs":[first["objectId"]]}),
        );
        let third = invoke(
            &store,
            "s",
            "third",
            "put_object",
            serde_json::json!({"kind":"runtime.message","value":{"id":"m3","sessionId":"s","sequence":3},"refs":[second["objectId"], first["objectId"]]}),
        );
        let first_page = invoke(
            &store,
            "s",
            "page-1",
            "page",
            serde_json::json!({"objectId":third["objectId"],"limit":2}),
        );
        assert_eq!(first_page["items"].as_array().unwrap().len(), 2);
        let cursor = first_page["cursor"].clone();
        assert!(cursor.is_object());
        let second_page = invoke(
            &store,
            "s",
            "page-2",
            "page",
            serde_json::json!({"cursor":cursor,"limit":2}),
        );
        assert_eq!(second_page["items"].as_array().unwrap().len(), 1);
        assert!(second_page["cursor"].is_null());
        let mut ids = first_page["items"]
            .as_array()
            .unwrap()
            .iter()
            .chain(second_page["items"].as_array().unwrap())
            .map(|item| item["objectId"].as_str().unwrap())
            .collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 3);
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn page_cursor_rejects_invalid_bounds_and_ambiguous_boundaries() {
        let path = temp_path("page-cursor-bounds");
        let store = HistoryStore::open(&path).unwrap();
        let object = invoke(
            &store,
            "s",
            "object",
            "put_object",
            serde_json::json!({"kind":"runtime.message","value":{"id":"m","sessionId":"s"}}),
        )["objectId"]
            .as_str()
            .unwrap()
            .to_owned();
        for payload in [
            serde_json::json!({"objectId":object,"limit":0}),
            serde_json::json!({"objectId":object,"limit":PAGE_LIMIT + 1}),
            serde_json::json!({"cursor":{"version":2,"queue":[object],"seen":[]}}),
            serde_json::json!({"cursor":{"version":1,"queue":["bad"],"seen":[]}}),
            serde_json::json!({"cursor":{"version":1,"queue":[],"seen":[]}}),
            serde_json::json!({"cursor":{"version":1,"queue":[object],"seen":[object, object]}}),
            serde_json::json!({"objectId":object,"cursor":{"version":1,"queue":[object],"seen":[]}}),
        ] {
            assert!(matches!(
                store.command(
                    "s",
                    &format!("invalid-{}", uuid::Uuid::new_v4()),
                    "page",
                    &serde_json::to_vec(&payload).unwrap(),
                ),
                Err(HistoryError::InvalidCommand(_))
            ));
        }
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn gc_is_bounded_resumable_and_protects_heads_pins_and_outbox_roots() {
        let path = temp_path("gc-resumable");
        let store = HistoryStore::open(&path).unwrap();
        let head_object = invoke(
            &store,
            "s",
            "head-object",
            "put_object",
            serde_json::json!({"kind":"runtime.message","value":{"id":"head","sessionId":"s"}}),
        )["objectId"]
            .as_str()
            .unwrap()
            .to_owned();
        invoke(
            &store,
            "s",
            "head-switch",
            "head_switch",
            serde_json::json!({"objectId":head_object}),
        );
        let pinned_object = invoke(
            &store,
            "s",
            "pinned-object",
            "put_object",
            serde_json::json!({"kind":"runtime.message","value":{"id":"pinned","sessionId":"s"}}),
        )["objectId"]
            .as_str()
            .unwrap()
            .to_owned();
        invoke(
            &store,
            "s",
            "pin",
            "pin",
            serde_json::json!({"pinId":"checkpoint","objectId":pinned_object}),
        );
        let outbox_object = invoke(
            &store,
            "s",
            "outbox-object",
            "put_object",
            serde_json::json!({"kind":"runtime.message","value":{"id":"outbox","sessionId":"s"}}),
        )["objectId"]
            .as_str()
            .unwrap()
            .to_owned();
        store
            .db
            .put_cf(
                store.cf(CF_OUTBOX).unwrap(),
                b"s/0000000001",
                serde_json::to_vec(&serde_json::json!({"objectId":outbox_object})).unwrap(),
            )
            .unwrap();
        let orphan = invoke(
            &store,
            "s",
            "orphan",
            "put_object",
            serde_json::json!({"kind":"runtime.message","value":{"id":"orphan","sessionId":"s"}}),
        )["objectId"]
            .as_str()
            .unwrap()
            .to_owned();

        let first = invoke(
            &store,
            "s",
            "gc-0",
            "gc",
            serde_json::json!({"batchSize":1}),
        );
        assert!(first["pending"].as_bool().unwrap());
        drop(store);

        let store = HistoryStore::open(&path).unwrap();
        let mut last = first;
        for index in 1..4096 {
            if !last["pending"].as_bool().unwrap() {
                break;
            }
            last = invoke(
                &store,
                "s",
                &format!("gc-{index}"),
                "gc",
                serde_json::json!({"batchSize":8}),
            );
        }
        assert_eq!(last["pending"], false);
        assert!(matches!(
            store.command(
                "s",
                "orphan-read",
                "get_object",
                &serde_json::to_vec(&serde_json::json!({"objectId":orphan})).unwrap(),
            ),
            Err(HistoryError::ObjectMissing(_))
        ));
        for (request, object_id) in [
            ("head-read", head_object),
            ("pin-read", pinned_object),
            ("outbox-read", outbox_object),
        ] {
            assert!(
                store
                    .command(
                        "s",
                        request,
                        "get_object",
                        &serde_json::to_vec(&serde_json::json!({"objectId":object_id})).unwrap(),
                    )
                    .is_ok()
            );
        }
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn immutable_objects_heads_pins_and_gc_are_content_addressed() {
        let path = temp_path("cas");
        let store = HistoryStore::open(&path).unwrap();
        let first = store
            .command(
                "s",
                "put-1",
                "put_object",
                br#"{"kind":"message","value":{"text":"hello"}}"#,
            )
            .unwrap();
        let first_id = serde_json::from_slice::<serde_json::Value>(&first).unwrap()["objectId"]
            .as_str()
            .unwrap()
            .to_owned();
        let second = store.command("s", "put-2", "put_object", serde_json::to_vec(&serde_json::json!({"kind":"message","value":{"text":"world"},"refs":[first_id]})).unwrap().as_slice()).unwrap();
        let second_id = serde_json::from_slice::<serde_json::Value>(&second).unwrap()["objectId"]
            .as_str()
            .unwrap()
            .to_owned();
        let head = store
            .command(
                "s",
                "head",
                "head_switch",
                serde_json::to_vec(&serde_json::json!({"objectId":second_id,"expectedRevision":0}))
                    .unwrap()
                    .as_slice(),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<HistoryHead>(&head)
                .unwrap()
                .revision,
            1
        );
        store
            .command(
                "s",
                "pin",
                "pin",
                serde_json::to_vec(&serde_json::json!({"pinId":"checkpoint","objectId":first_id}))
                    .unwrap()
                    .as_slice(),
            )
            .unwrap();
        store.command("s", "event-1", "put_object", serde_json::to_vec(&serde_json::json!({"kind":"runtime.event","value":{"id":"event-1","sessionId":"s","type":"run_started"}})).unwrap().as_slice()).unwrap();
        let events = store
            .command("s", "list-events", "list_events", b"{}")
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&events).unwrap()["items"],
            serde_json::json!([]),
            "unpublished objects must not leak through the old global index"
        );
        let gc = store.command("s", "gc", "gc", b"{}").unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&gc).unwrap()["deleted"],
            1,
            "the unreferenced event is collected"
        );
        store
            .command("s", "unpin", "unpin", br#"{"pinId":"checkpoint"}"#)
            .unwrap();
        let gc = store.command("s", "gc-2", "gc", b"{}").unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&gc).unwrap()["deleted"],
            0,
            "head still retains both referenced objects"
        );
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn chunked_blobs_are_verified_before_manifest_publication() {
        let path = temp_path("blob");
        let store = HistoryStore::open(&path).unwrap();
        let digest = format!("{:x}", Sha256::digest(b"hello world"));
        store
            .command(
                "s",
                "blob-1",
                "put_blob_chunk",
                br#"{"blobId":"asset-1","index":0,"total":2,"bytesHex":"68656c6c6f20"}"#,
            )
            .unwrap();
        store
            .command(
                "s",
                "blob-2",
                "put_blob_chunk",
                br#"{"blobId":"asset-1","index":1,"total":2,"bytesHex":"776f726c64"}"#,
            )
            .unwrap();
        let manifest = store
            .command(
                "s",
                "blob-manifest",
                "put_blob_manifest",
                serde_json::to_vec(
                    &serde_json::json!({"blobId":"asset-1","total":2,"size":11,"sha256":digest}),
                )
                .unwrap()
                .as_slice(),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&manifest).unwrap()["size"],
            11
        );
        let chunk = store
            .command(
                "s",
                "blob-read",
                "get_blob_chunk",
                br#"{"blobId":"asset-1","index":1}"#,
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&chunk).unwrap()["bytesHex"],
            "776f726c64"
        );
        assert!(
            store
                .command(
                    "s",
                    "blob-bad",
                    "put_blob_manifest",
                    br#"{"blobId":"asset-1","total":2,"size":11,"sha256":"deadbeef"}"#
                )
                .is_err()
        );
        store
            .command(
                "s",
                "blob-delete",
                "delete_blob",
                br#"{"blobId":"asset-1"}"#,
            )
            .unwrap();
        assert!(
            store
                .command(
                    "s",
                    "blob-missing",
                    "get_blob_manifest",
                    br#"{"blobId":"asset-1"}"#
                )
                .is_err()
        );
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn asset_pages_are_bounded_and_continue_without_repeating_keys() {
        let path = temp_path("asset-page");
        let store = HistoryStore::open(&path).unwrap();
        for index in 0..65 {
            let id = format!("asset-{index:03}");
            invoke(&store, "__assets__", &id, "asset_put", serde_json::json!({"asset":{
                "id":id,"projectId":"p","filename":"test.txt","mediaType":"text/plain",
                "size":0,"sha256":"0".repeat(64),"createdAt":"2026-10-18T00:00:00Z"
            }}));
        }
        let first = invoke(&store,"__assets__","poll","asset_page",serde_json::json!({}));
        assert_eq!(first["items"].as_array().unwrap().len(),64);
        let second = invoke(&store,"__assets__","poll","asset_page",serde_json::json!({"after":first["next"]}));
        assert_eq!(second["items"].as_array().unwrap().len(),1);
        assert_eq!(second["items"][0]["id"],"asset-064");
        assert!(second["next"].is_null());
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn asset_metadata_and_bindings_are_durable_and_delete_is_fenced() {
        let path = temp_path("assets");
        let store = HistoryStore::open(&path).unwrap();
        let asset = serde_json::json!({
            "id": "asset_0123456789abcdef0123456789abcdef",
            "projectId": "project-1",
            "filename": "image.png",
            "mediaType": "image/png",
            "size": 3,
            "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "createdAt": "2026-10-17T00:00:00.000Z"
        });
        let put = store
            .command(
                "assets",
                "asset-put",
                "asset_put",
                serde_json::to_vec(&serde_json::json!({"asset":asset}))
                    .unwrap()
                    .as_slice(),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&put).unwrap()["asset"]["id"],
            "asset_0123456789abcdef0123456789abcdef"
        );
        store
            .command(
                "assets",
                "asset-bind",
                "asset_bind",
                br#"{"assetId":"asset_0123456789abcdef0123456789abcdef","sessionId":"s"}"#,
            )
            .unwrap();
        let bound = store
            .command(
                "assets",
                "asset-bound",
                "asset_has_binding",
                br#"{"assetId":"asset_0123456789abcdef0123456789abcdef","sessionId":"s"}"#,
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bound).unwrap()["bound"],
            true
        );
        assert!(
            store
                .command(
                    "assets",
                    "asset-delete",
                    "asset_delete",
                    br#"{"assetId":"asset_0123456789abcdef0123456789abcdef"}"#
                )
                .is_err()
        );
        store
            .command(
                "assets",
                "asset-unbind",
                "asset_unbind",
                br#"{"assetId":"asset_0123456789abcdef0123456789abcdef","sessionId":"s"}"#,
            )
            .unwrap();
        store
            .command(
                "assets",
                "asset-delete",
                "asset_delete",
                br#"{"assetId":"asset_0123456789abcdef0123456789abcdef"}"#,
            )
            .unwrap();
        assert!(
            store
                .command(
                    "assets",
                    "asset-get",
                    "asset_get",
                    br#"{"assetId":"asset_0123456789abcdef0123456789abcdef"}"#
                )
                .is_err()
        );
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn checkpoint_pins_are_listed_without_switching_the_current_head() {
        let path = temp_path("checkpoints");
        let store = HistoryStore::open(&path).unwrap();
        let object = store
            .command(
                "s",
                "put",
                "put_object",
                br#"{"kind":"runtime.message","value":{"id":"m","sessionId":"s","sequence":1}}"#,
            )
            .unwrap();
        let object_id = serde_json::from_slice::<serde_json::Value>(&object).unwrap()["objectId"]
            .as_str()
            .unwrap()
            .to_owned();
        let before = store
            .command("s", "head-before", "head_read", b"{}")
            .unwrap();
        store.command("s", "checkpoint", "checkpoint", serde_json::to_vec(&serde_json::json!({"pinId":"cp-1","objectId":object_id,"metadata":{"messageId":"m","kind":"reply"}})).unwrap().as_slice()).unwrap();
        let after = store
            .command("s", "head-after", "head_read", b"{}")
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<HistoryHead>(&before)
                .unwrap()
                .revision,
            serde_json::from_slice::<HistoryHead>(&after)
                .unwrap()
                .revision
        );
        let listed = store
            .command("s", "list", "list_checkpoints", b"{}")
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&listed).unwrap()["items"][0]["id"],
            "cp-1"
        );
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }
}
