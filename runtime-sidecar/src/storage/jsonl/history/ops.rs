//! The command façade: one entry point per history RPC, receipt fencing and
//! the append-then-publish write path shared by every operation.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use super::files::{self, FileStore};
use super::json::{array, boolean, convert_value, empty, number, object, text};
use super::metadata::MetadataStore;
use super::sync::history_sync;
use super::wire::HistoryError;
use super::{
    change_collection, decode_hex, encode_hex, history_path, indexed_kind, map_end, now_iso,
    required_string, required_u64, validate_object_id, AuxRecord, ChangeEntry, EntityCursor,
    HistoryEntities, HistoryHead, HistoryObject, HistoryReceipt, HistorySession, SessionIndex,
    SessionState, ENTITY_PAGE_BYTES, MAX_BLOB_CHUNK_BYTES, MAX_BLOB_CHUNKS, MAX_COMMAND_BYTES,
    MAX_OBJECT_BYTES, PAGE_CURSOR_MAX_ITEMS, PAGE_LIMIT,
};
use crate::storage::jsonl::layout;
use crate::storage::jsonl::record::Record;
use crate::storage::jsonl::store::JsonlStore;
use crate::storage::session_cache::SessionCache;

/// Objects are referenced by content hash and fully contained in their bytes.
const OBJECT_DIGEST: &str = "sha256";

pub struct HistoryOps {
    store: Arc<JsonlStore>,
    sessions: Arc<SessionCache<Arc<HistorySession>>>,
    slots: Arc<Semaphore>,
}

impl HistoryOps {
    pub(crate) fn clear_cache_for_tests(&self) { self.sessions.clear(); }
    pub fn evict_idle(&self) -> usize {
        self.evict_with_policy(4, std::time::Duration::from_secs(300))
    }
    pub(crate) fn evict_with_policy(&self, capacity: usize, idle: std::time::Duration) -> usize {
        let store = self.store.clone();
        self.sessions.evict(capacity, idle, |session| {
            Arc::strong_count(session) == 1 && store.cached_session_idle(&session.session_id)
        })
    }
    pub fn new(store: Arc<JsonlStore>) -> Self {
        Self {
            store,
            sessions: Arc::new(SessionCache::default()),
            slots: Arc::new(Semaphore::new(32)),
        }
    }

    /// Run one history command off the async workers.
    pub async fn command_async(
        &self,
        session_id: String,
        request_id: String,
        operation: String,
        payload: Vec<u8>,
    ) -> Result<Vec<u8>, HistoryError> {
        let permit = self
            .slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| HistoryError::InvalidCommand("history executor closed".into()))?;
        let task = HistoryTask {
            store: self.store.clone(),
            sessions: self.sessions.clone(),
        };
        let span = tracing::Span::current();
        tokio::task::spawn_blocking(move || {
            let _entered = span.enter();
            let _permit = permit;
            task.command(&session_id, &request_id, &operation, &payload)
        })
        .await
        .map_err(|error| HistoryError::InvalidCommand(format!("history task failed: {error}")))?
    }
}

struct HistoryTask {
    store: Arc<JsonlStore>,
    sessions: Arc<SessionCache<Arc<HistorySession>>>,
}

/// Query ids are correlation only: persisted query results are never
/// replayed, so a read always observes the latest committed state.
fn readonly_operation(operation: &str) -> bool {
    matches!(
        operation,
        "metadata_get"
            | "metadata_page"
            | "head_read"
            | "history_sync"
            | "object_value_chunk"
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
            | "reconcile_stream"
            | "ack_history_outbox"
    )
}

/// `sha256(json!(["history.v1", session_id, operation, value]))`, scope
/// "history".
fn receipt_identity(
    session_id: &str,
    operation: &str,
    value: &Value,
) -> Result<String, HistoryError> {
    let tuple = ("history.v1", session_id, operation, value);
    Ok(layout::sha256_hex(&serialized(&tuple)?))
}

fn serialized<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, HistoryError> {
    serde_json::to_vec(value)
        .map_err(|error| HistoryError::InvalidCommand(format!("serialization: {error}")))
}

fn receipt_key(session_id: &str, request_id: &str) -> String {
    format!("{session_id}\0{request_id}")
}

fn binding_key(session_id: &str, asset_id: &str) -> String {
    format!("{session_id}\0{asset_id}")
}

fn blob_key(blob_id: &str) -> String {
    layout::sha256_hex(blob_id.as_bytes())
}

impl HistoryTask {
    fn root(&self) -> &std::path::Path {
        self.store.root()
    }

    fn session(&self, session_id: &str) -> Result<Arc<HistorySession>, HistoryError> {
        let session = self.sessions.get_or_try_init(session_id, || HistorySession::open(self.root(), session_id).map(Arc::new))?;
        self.sessions.evict(4, std::time::Duration::from_secs(300), |cached| {
            Arc::strong_count(cached) == 1 && self.store.cached_session_idle(&cached.session_id)
        });
        Ok(session)
    }

    #[allow(clippy::too_many_lines)]
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
        layout::validate_session_id(session_id).map_err(convert_io)?;
        let value: Value = if payload.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(payload).map_err(|error| {
                HistoryError::InvalidCommand(format!("serialization: {error}"))
            })?
        };
        let readonly = readonly_operation(operation);
        let key = receipt_key(session_id, request_id);
        let session = self.session(session_id)?;
        let mut guard = session.lock.lock();
        if !readonly {
            if let Some(receipt) = guard.index.receipts.get(&key) {
                if receipt.identity != receipt_identity(session_id, operation, &value)? {
                    return Err(HistoryError::RequestConflict);
                }
                return Ok(receipt.result.clone());
            }
        }
        let mut ops = SessionOps {
            task: self,
            session_id,
            state: &mut guard,
            staged: Vec::new(),
            index: None,
        };
        let result = match operation {
            "reconcile_stream" => serialized(&object(&[("reconciled", number(0))]))?,
            "ack_history_outbox" => {
                let through = required_u64(&value, "through")?;
                serialized(&object(&[("ackedThrough", number(through))]))?
            }
            "history_sync" => serialized(&history_sync(ops.index(), session_id, &value)?)?,
            "object_value_chunk" => ops.object_value_chunk(&value)?,
            "append_entities" => ops.append_entities(&value)?,
            "append_entities_blob" => ops.append_entities_blob(&value)?,
            "put_object" => ops.put_object(&value)?,
            "put_blob_chunk" => ops.put_blob_chunk(&value)?,
            "put_blob_manifest" => ops.put_blob_manifest(&value)?,
            "get_blob_chunk" => ops.get_blob_chunk(&value)?,
            "get_blob_manifest" => ops.get_blob_manifest(&value)?,
            "delete_blob" => ops.delete_blob(&value)?,
            "asset_put" => ops.asset_put(&value)?,
            "asset_get" => ops.asset_get(&value)?,
            "asset_page" => ops.asset_page(&value)?,
            "asset_bind" => ops.asset_bind(&value)?,
            "asset_unbind" => ops.asset_unbind(&value)?,
            "asset_has_binding" => ops.asset_has_binding(&value)?,
            "asset_list_bindings" => ops.asset_list_bindings(&value)?,
            "asset_delete" => ops.asset_delete(&value)?,
            "metadata_get" => ops.metadata()?.get(&value)?,
            "metadata_page" => ops.metadata()?.page(&value)?,
            "metadata_commit" => {
                let (result, scope, revision) = ops.metadata()?.commit(&value)?;
                if let Some(scope) = scope {
                    let scope_key = format!("metadata\0scope\0{scope}");
                    if ops.index().aux_value(&scope_key).is_none() {
                        ops.set_aux(scope_key, Some(boolean(true)));
                    }
                    ops.work().set_metadata_scope(scope);
                }
                if let Some(revision) = revision {
                    ops.set_aux("metadata\0generation".into(), Some(number(revision)));
                    ops.work().set_metadata_generation(revision);
                }
                result
            }
            "get_object" => {
                let object_id = required_string(&value, "objectId")?;
                serialized(&*ops.read_object(object_id)?)?
            }
            "head_read" => serialized(&ops.index().head)?,
            "head_switch" | "checkpoint" | "rollback" => ops.head_switch(&value, operation)?,
            "list_checkpoints" => ops.list_checkpoints(&value)?,
            "fork" => ops.fork(&value)?,
            "pin" => ops.pin(&value)?,
            "unpin" => ops.unpin(&value)?,
            "page" => ops.page(&value)?,
            "list_runs" => ops.list_indexed("run", &value)?,
            "list_messages" => ops.list_indexed("message", &value)?,
            "list_steps" => ops.list_indexed("step", &value)?,
            "list_parts" => ops.list_indexed("part", &value)?,
            "list_tool_calls" => ops.list_indexed("tool", &value)?,
            "list_events" => ops.list_indexed("event", &value)?,
            "list_artifacts" => ops.list_indexed("artifact", &value)?,
            "list_plans" => ops.list_indexed("plan", &value)?,
            "list_work" => ops.list_indexed("work", &value)?,
            "list_contexts" => ops.list_indexed("context", &value)?,
            "list_aux_usage" => ops.list_indexed("aux", &value)?,
            "list_thinking" => ops.list_indexed("thinking", &value)?,
            "list_compactions" => ops.list_indexed("compaction", &value)?,
            "list_terminals" => ops.list_indexed("terminal", &value)?,
            "list_permissions" => ops.list_indexed("permission", &value)?,
            "list_interactions" => ops.list_indexed("interaction", &value)?,
            "list_file_changes" => ops.list_indexed("file_change", &value)?,
            "file_begin"
            | "file_finish"
            | "file_abandon"
            | "file_import"
            | "file_cursor"
            | "file_checkpoint"
            | "file_pending"
            | "file_preview"
            | "restore_checkpoint"
            | "file_recover"
            | "file_restore_ack" => ops.file_command(request_id, operation, &value)?,
            "verify" => ops.verify()?,
            "rebuild_index" => ops.rebuild_index()?,
            "gc" => ops.gc(&value)?,
            _ => {
                return Err(HistoryError::InvalidCommand(format!(
                    "unknown history operation: {operation}"
                )));
            }
        };
        if readonly {
            return Ok(result);
        }
        let receipt = HistoryReceipt {
            key,
            identity: receipt_identity(session_id, operation, &value)?,
            result: result.clone(),
        };
        ops.staged.push(Record::HistoryReceipt(receipt));
        ops.commit()?;
        session.published.store(Arc::new(guard.index.clone()));
        Ok(result)
    }
}

struct SessionOps<'a> {
    task: &'a HistoryTask,
    session_id: &'a str,
    state: &'a mut SessionState,
    /// Records this command appends; applied to a clone of the index first so
    /// staged state is observable within the command.
    staged: Vec<Record>,
    index: Option<SessionIndex>,
}

impl SessionOps<'_> {
    fn root(&self) -> &std::path::Path {
        self.task.root()
    }

    fn history_dir(&self) -> Result<std::path::PathBuf, HistoryError> {
        history_path(self.root(), self.session_id)
    }

    fn index(&self) -> &SessionIndex {
        self.index.as_ref().unwrap_or(&self.state.index)
    }

    fn work(&mut self) -> &mut SessionIndex {
        if self.index.is_none() {
            self.index = Some(SessionIndex::clone_index(&self.state.index));
        }
        self.index.as_mut().expect("index initialized")
    }

    fn read_object(&self, object_id: &str) -> Result<Arc<HistoryObject>, HistoryError> {
        if let Some(found) = self.index().objects.get(object_id) {
            return Ok(found.clone());
        }
        self.state
            .index
            .object(object_id)
            .ok_or_else(|| HistoryError::ObjectMissing(object_id.to_owned()))
    }

    /// Stage an object: later reads in this command see it immediately.
    fn stage_object(&mut self, object: HistoryObject) -> Arc<HistoryObject> {
        let object = Arc::new(object);
        self.staged
            .push(Record::HistoryObject((*object).clone()));
        self.work()
            .objects
            .insert(object.object_id.clone(), object.clone());
        object
    }

    fn put_object_value(
        &mut self,
        value: &Value,
    ) -> Result<(Arc<HistoryObject>, usize), HistoryError> {
        let kind = required_string(value, "kind")?;
        let object_value = value
            .get("value")
            .cloned()
            .ok_or_else(|| HistoryError::InvalidCommand("object value is required".into()))?;
        let refs = value
            .get("refs")
            .cloned()
            .unwrap_or_else(|| array(Vec::new()));
        let refs: Vec<String> = serde_json::from_value(refs)
            .map_err(|_| HistoryError::InvalidCommand("object refs must be strings".into()))?;
        let identity = serialized(&(kind, &object_value, &refs))?;
        if identity.len() > MAX_OBJECT_BYTES {
            return Err(HistoryError::InvalidCommand(
                "history object exceeds bounds".into(),
            ));
        }
        for object_id in &refs {
            self.read_object(object_id)?;
        }
        let object_id = format!("{OBJECT_DIGEST}:{:x}", Sha256::digest(&identity));
        let object = HistoryObject {
            object_id,
            kind: kind.to_owned(),
            value: object_value,
            refs,
        };
        let bytes = serialized(&object)?.len();
        Ok((self.stage_object(object), bytes))
    }

    fn put_object(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let (entity, bytes) = self.put_object_value(value)?;
        serialized(&object(&[
            ("objectId", text(&entity.object_id)),
            ("bytes", number(bytes as u64)),
        ]))
    }

    // ------------------------------------------------------------- blobs

    fn blob_path(&self, blob_id: &str) -> Result<std::path::PathBuf, HistoryError> {
        Ok(self.history_dir()?.join("blobs").join(blob_key(blob_id)))
    }

    fn put_blob_chunk(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
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
        let path = self.blob_path(blob_id)?.join(format!("{index:08}.chunk"));
        write_once(&path, &bytes)?;
        self.work().blobs.insert(blob_id.to_owned());
        serialized(&object(&[
            ("blobId", text(blob_id)),
            ("index", number(index)),
            ("total", number(total)),
            ("bytes", number(bytes.len() as u64)),
        ]))
    }

    fn blob_chunk(&self, blob_id: &str, index: u64) -> Result<Option<Vec<u8>>, HistoryError> {
        read_optional(&self.blob_path(blob_id)?.join(format!("{index:08}.chunk")))
    }

    fn blob_manifest(&self, blob_id: &str) -> Result<Option<Value>, HistoryError> {
        let path = self.blob_path(blob_id)?.join("manifest.json");
        Ok(read_optional(&path)?.and_then(|bytes| serde_json::from_slice(&bytes).ok()))
    }

    fn put_blob_manifest(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
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
            let bytes = self.blob_chunk(blob_id, index)?.ok_or_else(|| {
                HistoryError::InvalidCommand(format!("missing blob chunk {index}"))
            })?;
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
        let manifest = object(&[
            ("blobId", text(blob_id)),
            ("total", number(total)),
            ("size", number(size)),
            ("sha256", text(&actual_sha256)),
        ]);
        write_replace(
            &self.blob_path(blob_id)?.join("manifest.json"),
            &serialized(&manifest)?,
        )?;
        self.work().blobs.insert(blob_id.to_owned());
        serialized(&manifest)
    }

    fn get_blob_chunk(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let blob_id = required_string(value, "blobId")?;
        let index = required_u64(value, "index")?;
        let bytes = self
            .blob_chunk(blob_id, index)?
            .ok_or_else(|| HistoryError::ObjectMissing(format!("blob chunk {blob_id}/{index}")))?;
        let total = self
            .blob_manifest(blob_id)?
            .and_then(|manifest| manifest["total"].as_u64());
        serialized(&object(&[
            ("blobId", text(blob_id)),
            ("index", number(index)),
            ("total", total.map(number).unwrap_or(Value::Null)),
            ("bytesHex", text(&encode_hex(&bytes))),
        ]))
    }

    fn get_blob_manifest(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let blob_id = required_string(value, "blobId")?;
        let manifest = self
            .blob_manifest(blob_id)?
            .ok_or_else(|| HistoryError::ObjectMissing(format!("blob manifest {blob_id}")))?;
        serialized(&manifest)
    }

    fn delete_blob(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let blob_id = required_string(value, "blobId")?;
        let dir = self.blob_path(blob_id)?;
        let mut deleted = 0u64;
        match std::fs::read_dir(&dir) {
            Ok(entries) => {
                for entry in entries {
                    let entry = entry.map_err(file_io)?;
                    std::fs::remove_file(entry.path()).map_err(file_io)?;
                    deleted += 1;
                }
                std::fs::remove_dir(&dir).map_err(file_io)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(file_io(error)),
        }
        self.work().blobs.remove(blob_id);
        serialized(&object(&[
            ("blobId", text(blob_id)),
            ("deleted", number(deleted)),
        ]))
    }

    // ------------------------------------------------------ ordered maps

    fn set_aux(&mut self, key: String, value: Option<Value>) {
        self.staged
            .push(Record::HistoryAux(AuxRecord::Set(key.clone(), value.clone())));
        self.work().aux.insert(key, value);
    }

    fn asset_put(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
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
        let created_at = required_string(&asset, "createdAt")?.to_owned();
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
        let key = format!("asset\0{id}");
        if let Some(previous) = self.index().aux_value(&key) {
            if previous != &asset {
                return Err(HistoryError::RequestConflict);
            }
        } else {
            self.set_aux(key, Some(asset.clone()));
        }
        serialized(&object(&[
            ("asset", asset),
            ("createdAt", text(&created_at)),
        ]))
    }

    fn asset_get(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let id = required_string(value, "assetId")?;
        let asset = self
            .index()
            .aux_value(&format!("asset\0{id}"))
            .cloned()
            .ok_or_else(|| HistoryError::ObjectMissing(format!("asset {id}")))?;
        serialized(&asset)
    }

    fn asset_page(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let after = value["after"].as_str().unwrap_or("").to_owned();
        let mut items = Vec::new();
        for (key, asset) in self.index().aux_entries("asset\0") {
            let id = key.trim_start_matches("asset\0");
            if !after.is_empty() && id <= after.as_str() {
                continue;
            }
            items.push(asset.clone());
            if items.len() == 64 {
                return serialized(&object(&[
                    ("items", array(items)),
                    ("next", text(id)),
                ]));
            }
        }
        serialized(&object(&[("items", array(items)), ("next", Value::Null)]))
    }

    fn asset_bind(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let asset_id = required_string(value, "assetId")?;
        let session_id = required_string(value, "sessionId")?;
        if self
            .index()
            .aux_value(&format!("asset\0{asset_id}"))
            .is_none()
        {
            return Err(HistoryError::ObjectMissing(format!("asset {asset_id}")));
        }
        self.set_aux(
            format!("binding\0{}", binding_key(session_id, asset_id)),
            Some(boolean(true)),
        );
        serialized(&object(&[
            ("assetId", text(asset_id)),
            ("sessionId", text(session_id)),
            ("bound", boolean(true)),
        ]))
    }

    fn asset_unbind(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let asset_id = required_string(value, "assetId")?;
        let session_id = required_string(value, "sessionId")?;
        self.set_aux(
            format!("binding\0{}", binding_key(session_id, asset_id)),
            None,
        );
        serialized(&object(&[
            ("assetId", text(asset_id)),
            ("sessionId", text(session_id)),
            ("bound", boolean(false)),
        ]))
    }

    fn asset_has_binding(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let asset_id = required_string(value, "assetId")?;
        let session_id = required_string(value, "sessionId")?;
        let bound = self
            .index()
            .aux_value(&format!("binding\0{}", binding_key(session_id, asset_id)))
            .is_some();
        serialized(&object(&[
            ("assetId", text(asset_id)),
            ("sessionId", text(session_id)),
            ("bound", boolean(bound)),
        ]))
    }

    fn asset_list_bindings(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let session_id = required_string(value, "sessionId")?;
        let prefix = format!("binding\0{session_id}\0");
        let mut assets = Vec::new();
        let mut seen = HashSet::new();
        for (key, _) in self.index().aux_entries(&prefix) {
            let asset_id = key.trim_start_matches(&prefix);
            if asset_id.is_empty() ||!seen.insert(asset_id.to_owned()) {
                continue;
            }
            if let Some(asset) = self.index().aux_value(&format!("asset\0{asset_id}")) {
                assets.push(asset.clone());
            }
        }
        serialized(&object(&[("items", array(assets))]))
    }

    fn asset_delete(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let asset_id = required_string(value, "assetId")?;
        let asset_key = format!("asset\0{asset_id}");
        if self.index().aux_value(&asset_key).is_none() {
            return Err(HistoryError::ObjectMissing(format!("asset {asset_id}")));
        }
        let suffix = format!("\0{asset_id}");
        for (key, _) in self.index().aux_entries("binding\0") {
            if key.ends_with(&suffix) {
                return Err(HistoryError::InvalidCommand(
                    "asset is retained by a session".into(),
                ));
            }
        }
        self.set_aux(asset_key, None);
        serialized(&object(&[
            ("assetId", text(asset_id)),
            ("deleted", boolean(true)),
        ]))
    }

    // ------------------------------------------------------------- heads

    fn head_switch(&mut self, value: &Value, operation: &str) -> Result<Vec<u8>, HistoryError> {
        let object_id = required_string(value, "objectId")?.to_owned();
        self.read_object(&object_id)?;
        let expected = value.get("expectedRevision").and_then(|item| item.as_u64());
        if operation == "checkpoint" {
            if let Some(expected) = expected {
                let actual = self.index().head.revision;
                if expected != actual {
                    return Err(HistoryError::RevisionConflict { expected, actual });
                }
            }
            let pin_id = value
                .get("pinId")
                .and_then(|item| item.as_str())
                .unwrap_or(&object_id)
                .to_owned();
            let metadata = value.get("metadata").cloned().unwrap_or_else(empty);
            self.set_aux(
                format!("pin\0{pin_id}"),
                Some(object(&[
                    ("objectId", text(&object_id)),
                    ("metadata", metadata.clone()),
                ])),
            );
            self.bump_index_generation();
            return serialized(&object(&[
                ("pinId", text(&pin_id)),
                ("objectId", text(&object_id)),
                ("metadata", metadata),
            ]));
        }
        let head = self.switch_head(&object_id, expected)?;
        serialized(&head)
    }

    /// Point the session at `object_id`, re-materializing the visible index
    /// from its graph and dropping everything unreachable from it.
    fn switch_head(
        &mut self,
        object_id: &str,
        expected: Option<u64>,
    ) -> Result<HistoryHead, HistoryError> {
        self.read_object(object_id)?;
        let mut head = self.index().head.clone();
        if let Some(expected) = expected {
            if expected != head.revision {
                return Err(HistoryError::RevisionConflict {
                    expected,
                    actual: head.revision,
                });
            }
        }
        head.session_id = self.session_id.to_owned();
        head.object_id = Some(object_id.to_owned());
        head.revision = head
            .revision
            .checked_add(1)
            .ok_or_else(|| HistoryError::InvalidCommand("history revision overflow".into()))?;
        head.updated_at = now_iso();
        self.bump_index_generation();
        let objects = self.index().objects.clone();
        let mut lookup = |id: &str| objects.get(id).cloned();
        self.work().head = head.clone();
        self.work().rebuild(object_id, &mut lookup)?;
        self.staged
            .push(Record::HistoryAux(AuxRecord::Head(head.clone())));
        Ok(head)
    }


    /// Advance the idempotency/liveness generation (pins, files, metadata).
    fn bump_generation(&mut self) -> u64 {
        let generation = self.index().generation.saturating_add(1);
        self.staged
            .push(Record::HistoryAux(AuxRecord::Generation(generation)));
        self.work().set_generation(generation);
        generation
    }

    /// Advance the visible-index generation. `history_sync` cursors are tied
    /// to it and go stale only when the index is rebuilt from another root.
    fn bump_index_generation(&mut self) -> u64 {
        let generation = self.index().index_generation.saturating_add(1);
        self.staged
            .push(Record::HistoryAux(AuxRecord::IndexGeneration(generation)));
        self.work().set_index_generation(generation);
        generation
    }

    fn list_checkpoints(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let after = value["cursor"]["after"].as_str().unwrap_or("").to_owned();
        if!after.is_empty() && value["cursor"]["sessionId"].as_str()!= Some(self.session_id) {
            return Err(HistoryError::InvalidCommand(
                "checkpoint cursor scope mismatch".into(),
            ));
        }
        let mut items = Vec::new();
        let mut bytes = 2048;
        let mut last: Option<String> = None;
        let mut more = false;
        for (key, saved) in self.index().aux_entries("pin\0") {
            let id = key.trim_start_matches("pin\0").to_owned();
            if!after.is_empty() && id.as_str() <= after.as_str() {
                continue;
            }
            let item = object(&[
                ("id", text(&id)),
                ("objectId", saved["objectId"].clone()),
                ("metadata", saved["metadata"].clone()),
            ]);
            let cost = serde_json::to_vec(&item).map(|bytes| bytes.len()).unwrap_or(0) + 1;
            if items.len() == 64 || bytes + cost > 900 * 1024 {
                more = true;
                break;
            }
            bytes += cost;
            last = Some(id);
            items.push(item);
        }
        let cursor = if more {
            last.map(|after| {
                object(&[
                    ("sessionId", text(self.session_id)),
                    ("after", text(&after)),
                ])
            })
            .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        serialized(&object(&[("items", array(items)), ("cursor", cursor)]))
    }

    fn pin(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let pin_id = required_string(value, "pinId")?.to_owned();
        let object_id = required_string(value, "objectId")?.to_owned();
        self.read_object(&object_id)?;
        self.set_aux(
            format!("pin\0{pin_id}"),
            Some(object(&[
                ("objectId", text(&object_id)),
                ("metadata", empty()),
            ])),
        );
        self.bump_index_generation();
        serialized(&object(&[
            ("pinId", text(&pin_id)),
            ("objectId", text(&object_id)),
        ]))
    }

    fn unpin(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let pin_id = required_string(value, "pinId")?.to_owned();
        self.set_aux(format!("pin\0{pin_id}"), None);
        self.bump_index_generation();
        serialized(&object(&[
            ("pinId", text(&pin_id)),
            ("removed", boolean(true)),
        ]))
    }

    fn fork(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let source_session_id = required_string(value, "sourceSessionId")?.to_owned();
        let source = self.task.session(&source_session_id)?;
        let source_index = source.read();
        let source_head = source_index.head.clone();
        let object_id = source_head
            .object_id
            .clone()
            .ok_or_else(|| HistoryError::InvalidCommand("source history has no head".into()))?;
        let target = self.index().head.clone();
        if target.revision!= 0 {
            return Err(HistoryError::RevisionConflict {
                expected: 0,
                actual: target.revision,
            });
        }
        // The target shares content but its history file records nothing
        // about the source, so every object on the walk is staged here too.
        let mut objects = source_index.objects.clone();
        let mut missing = Vec::new();
        let mut stack = vec![object_id.clone()];
        let mut visited = HashSet::new();
        while let Some(id) = stack.pop() {
            if!visited.insert(id.clone()) {
                continue;
            }
            let object = match objects.get(&id) {
                Some(object) => object.clone(),
                None => {
                    let object = source_index
                        .objects
                        .get(&id)
                        .cloned()
                        .ok_or_else(|| HistoryError::ObjectMissing(id.clone()))?;
                    objects.insert(id.clone(), object.clone());
                    object
                }
            };
            stack.extend(object.refs.iter().cloned());
            if!self.index().objects.contains_key(&id) {
                missing.push((*object).clone());
            }
        }
        for object in missing {
            self.staged.push(Record::HistoryObject(object));
        }
        let next = HistoryHead {
            session_id: self.session_id.to_owned(),
            object_id: Some(object_id.clone()),
            revision: 1,
            updated_at: now_iso(),
        };
        self.work().objects.extend(objects.clone());
        self.work().head = next.clone();
        self.bump_index_generation();
        let mut lookup = |id: &str| objects.get(id).cloned();
        self.work().rebuild(&object_id, &mut lookup)?;
        self.staged
            .push(Record::HistoryAux(AuxRecord::Head(next.clone())));
        serialized(&object(&[
            ("sourceSessionId", text(&source_session_id)),
            ("head", convert_value(&next)?),
        ]))
    }

    // ------------------------------------------------------- graph pages

    #[allow(clippy::too_many_lines)]
    fn page(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
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
            if!cursor.is_object() {
                return Err(HistoryError::InvalidCommand(
                    "history page cursor must be an object".into(),
                ));
            }
            if cursor.get("version").and_then(|item| item.as_u64())!= Some(1) {
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
            for object_id in queue.iter().chain(seen.iter()) {
                validate_object_id(object_id)?;
            }
            let mut unique_seen = HashSet::with_capacity(seen.len());
            for object_id in &seen {
                if!unique_seen.insert(object_id) {
                    return Err(HistoryError::InvalidCommand(
                        "history page cursor seen contains duplicates".into(),
                    ));
                }
            }
            (VecDeque::from(queue), seen.into_iter().collect::<HashSet<_>>())
        } else {
            if value.get("objectId").is_none() {
                return Err(HistoryError::InvalidCommand(
                    "history page objectId is required without a cursor".into(),
                ));
            }
            let object_id = required_string(value, "objectId")?;
            validate_object_id(object_id)?;
            (VecDeque::from(vec![object_id.to_owned()]), HashSet::new())
        };
        let mut objects = Vec::new();
        while objects.len() < limit {
            let Some(current) = queue.pop_front() else {
                break;
            };
            if!seen.insert(current.clone()) {
                continue;
            }
            let object = self.read_object(&current)?;
            for reference in &object.refs {
                queue.push_back(reference.clone());
            }
            let mut value = object.value.clone();
            if let Some(map) = value.as_object_mut() {
                map.entry("objectId".to_owned())
                    .or_insert_with(|| Value::String(object.object_id.clone()));
            }
            objects.push(value);
        }
        let cursor = if queue.is_empty() {
            Value::Null
        } else {
            object(&[
                ("version", number(1)),
                ("queue", array(queue.iter().map(|id| text(id)).collect())),
                (
                    "seen",
                    array(seen.iter().map(|id| text(id)).collect()),
                ),
            ])
        };
        let next = cursor["queue"]
            .as_array()
            .and_then(|items| items.first())
            .cloned()
            .unwrap_or(Value::Null);
        serialized(&object(&[
            ("items", array(objects)),
            ("next", next),
            ("cursor", cursor),
        ]))
    }

    #[allow(clippy::too_many_lines)]
    fn list_indexed(&mut self, kind: &str, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let head = self.index().head.clone();
        if head.object_id.is_some() && self.index().index_root!= head.object_id {
            return Err(HistoryError::InvalidCommand(
                "current history index is missing; rebuild_index required".into(),
            ));
        }
        let reverse = value["reverse"]
            .as_bool()
            .unwrap_or(matches!(kind, "run" | "plan"));
        let limit = value["limit"]
            .as_u64()
            .unwrap_or(128)
            .clamp(1, PAGE_LIMIT as u64) as usize;
        let max_bytes = value["maxBytes"]
            .as_u64()
            .unwrap_or(512 * 1024)
            .clamp(8192, ENTITY_PAGE_BYTES as u64) as usize;
        let cursor: Option<EntityCursor> = value
            .get("cursor")
            .filter(|v|!v.is_null())
            .map(|v| {
                serde_json::from_value(v.clone()).map_err(|error| {
                    HistoryError::InvalidCommand(format!("serialization: {error}"))
                })
            })
            .transpose()?;
        let prefix = format!("{kind}\0");
        if let Some(cursor) = &cursor {
            if cursor.session_id!= self.session_id
                || cursor.kind!= kind
                || cursor.reverse!= reverse
                ||!cursor.after.starts_with(&prefix)
            {
                return Err(HistoryError::InvalidCommand(
                    "history entity cursor scope mismatch".into(),
                ));
            }
            if cursor.revision!= head.revision {
                return Err(HistoryError::RevisionConflict {
                    expected: cursor.revision,
                    actual: head.revision,
                });
            }
        }
        let start = cursor
            .as_ref()
            .map(|c| c.after.clone())
            .unwrap_or_else(|| if reverse { format!("{kind}\0~") } else { prefix.clone() });
        let matching: Box<dyn Iterator<Item = (&String, &Arc<HistoryObject>)>> = if reverse {
            Box::new(
                self.index()
                    .order
                    .range(prefix.clone()..map_end(&prefix))
                    .rev()
                    .take_while(|(key, _)| key.starts_with(&prefix)),
            )
        } else {
            Box::new(self.index().entity_keys(kind))
        };
        let mut items = Vec::new();
        // Envelope and cursor are reserved before any body is read.
        let mut used = 4096;
        let mut last_key: Option<String> = None;
        let mut more = false;
        for (key, object) in matching {
            if reverse {
                if key.as_str() > start.as_str() {
                    continue;
                }
            } else if key.as_str() < start.as_str() {
                continue;
            }
            if cursor.as_ref().is_some_and(|c| c.after.as_str() == key.as_str()) {
                continue;
            }
            if items.len() == limit {
                more = true;
                break;
            }
            let item = if value["chunked"].as_bool() == Some(true) {
                self.history_wire_value(object, max_bytes.saturating_sub(4096))
            } else {
                object.value.clone()
            };
            let size = serde_json::to_vec(&item).map(|bytes| bytes.len()).unwrap_or(0) + 1;
            if used + size > max_bytes {
                if items.is_empty() {
                    return Err(HistoryError::InvalidCommand(
                        "entity exceeds history page byte budget".into(),
                    ));
                }
                more = true;
                break;
            }
            used += size;
            last_key = Some(key.clone());
            items.push(item);
        }
        let next = if more {
            last_key.map(|after| EntityCursor {
                session_id: self.session_id.to_owned(),
                kind: kind.to_owned(),
                revision: head.revision,
                reverse,
                after,
            })
        } else {
            None
        };
        let cursor = match next {
            Some(next) => convert_value(&next)?,
            None => Value::Null,
        };
        serialized(&object(&[
            ("items", array(items)),
            ("cursor", cursor),
            ("revision", number(head.revision)),
        ]))
    }

    fn history_wire_value(&self, entity: &HistoryObject, limit: usize) -> Value {
        let size = serde_json::to_vec(&entity.value)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        if size <= limit {
            entity.value.clone()
        } else {
            object(&[
                ("$historyObject", text(&entity.object_id)),
                ("bytes", number(size as u64)),
                ("id", entity.value["id"].clone()),
            ])
        }
    }

    fn object_value_chunk(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let entity = self.read_object(required_string(value, "objectId")?)?;
        let text_value = serde_json::to_string(&entity.value)
            .map_err(|error| HistoryError::InvalidCommand(format!("serialization: {error}")))?;
        let offset = value["offset"].as_u64().unwrap_or(0) as usize;
        if offset > text_value.len() ||!text_value.is_char_boundary(offset) {
            return Err(HistoryError::InvalidCommand(
                "invalid object chunk offset".into(),
            ));
        }
        let mut end = (offset + 64 * 1024).min(text_value.len());
        while!text_value.is_char_boundary(end) {
            end -= 1;
        }
        let next = if end < text_value.len() {
            number(end as u64)
        } else {
            Value::Null
        };
        serialized(&object(&[
            ("text", text(text_value.get(offset..end).unwrap_or_default())),
            ("next", next),
        ]))
    }

    // ------------------------------------------------------------ append

    fn append_entities(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let expected = value.get("expectedRevision").and_then(|v| v.as_u64());
        if value["ifAbsent"] == true {
            let objects = value["objects"].as_array().ok_or_else(|| HistoryError::InvalidCommand("objects required".into()))?;
            let mut missing = Vec::new();
            for object in objects {
                let kind = required_string(object, "kind")?;
                let collection = indexed_kind(kind, &object["value"]).ok_or_else(|| HistoryError::InvalidCommand("invalid entity kind".into()))?;
                let id = required_string(&object["value"], "id")?;
                if object["value"]["sessionId"] != self.session_id { return Err(HistoryError::InvalidCommand("entity scope mismatch".into())); }
                if !self.index().identity.contains_key(&super::identity_key(collection, self.session_id, id)) { missing.push(object.clone()); }
            }
            if !missing.is_empty() { self.stage_append(&serde_json::json!({"objects":missing}), expected)?; }
        } else {
            self.stage_append(value, expected)?;
        }
        serialized(&self.index().head)
    }

    fn append_entities_blob(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let blob_id = required_string(value, "blobId")?;
        let manifest = self.blob_manifest(blob_id)?.ok_or_else(|| HistoryError::ObjectMissing(blob_id.into()))?;
        let size = required_u64(&manifest, "size")?;
        let total = required_u64(&manifest, "total")?;
        if size > MAX_COMMAND_BYTES as u64 || total == 0 || total > MAX_BLOB_CHUNKS {
            return Err(HistoryError::InvalidCommand("history upload exceeds bounds".into()));
        }
        let expected = required_string(value, "sha256")?;
        if manifest["sha256"].as_str() != Some(expected) { return Err(HistoryError::InvalidCommand("history upload digest mismatch".into())); }
        let mut bytes = Vec::with_capacity(size as usize);
        for index in 0..total {
            let chunk = self.blob_chunk(blob_id, index)?.ok_or_else(|| HistoryError::ObjectMissing(blob_id.into()))?;
            if bytes.len() + chunk.len() > MAX_COMMAND_BYTES { return Err(HistoryError::InvalidCommand("history upload exceeds bounds".into())); }
            bytes.extend(chunk);
        }
        if bytes.len() as u64 != size || layout::sha256_hex(&bytes) != expected {
            return Err(HistoryError::InvalidCommand("history upload digest mismatch".into()));
        }
        let payload: Value = serde_json::from_slice(&bytes).map_err(|_| HistoryError::InvalidCommand("invalid history upload JSON".into()))?;
        self.append_entities(&payload)
    }

    /// Build revision `head.revision + 1` from the staged entities and the
    /// current head, index them, then record the new root and head.
    fn stage_append(&mut self, value: &Value, expected: Option<u64>) -> Result<u64, HistoryError> {
        let head = self.index().head.clone();
        if head.object_id.is_some() && self.index().index_root != head.object_id {
            return Err(HistoryError::InvalidCommand(
                "current history index is missing; rebuild_index required".into(),
            ));
        }
        if let Some(expected) = expected {
            if expected != head.revision {
                return Err(HistoryError::RevisionConflict {
                    expected,
                    actual: head.revision,
                });
            }
        }
        let objects = value["objects"]
            .as_array()
            .filter(|objects| !objects.is_empty() && objects.len() <= PAGE_LIMIT)
            .ok_or_else(|| {
                HistoryError::InvalidCommand("append requires 1..=256 entities".into())
            })?;
        let revision = head
            .revision
            .checked_add(1)
            .ok_or_else(|| HistoryError::InvalidCommand("history revision overflow".into()))?;
        let mut refs = Vec::with_capacity(objects.len() + 1);
        let mut staged = Vec::with_capacity(objects.len());
        for object in objects.iter() {
            let kind = required_string(object, "kind")?;
            if indexed_kind(kind, &object["value"]).is_none()
                || object["value"]["sessionId"].as_str() != Some(self.session_id)
            {
                return Err(HistoryError::InvalidCommand(
                    "entity kind or session does not match append scope".into(),
                ));
            }
            required_string(&object["value"], "id")?;
            let (object, _) = self.put_object_value(object)?;
            staged.push(object);
        }
        // The root walks newest values first, while the object records remain
        // in input order so replay preserves last-write-wins for duplicate ids.
        refs.extend(staged.iter().rev().map(|object| object.object_id.clone()));
        let mut changes = Vec::new();
        for object in &staged {
            let kind = indexed_kind(&object.kind, &object.value).unwrap_or_default();
            if let Some(collection) = change_collection(&object.kind, &object.value) {
                changes.push(ChangeEntry {
                    collection: collection.to_owned(),
                    object_id: object.object_id.clone(),
                });
            }
            self.work().object_inserted(object.clone());
        }
        if let Some(previous) = &head.object_id {
            self.read_object(previous)?;
            refs.push(previous.clone());
        }
        let kind = "runtime.session.root";
        let root_value = object(&[
            ("sessionId", text(self.session_id)),
            ("revision", number(revision)),
        ]);
        let identity = serialized(&(kind, &root_value, &refs))?;
        let root = HistoryObject {
            object_id: format!("{OBJECT_DIGEST}:{:x}", Sha256::digest(&identity)),
            kind: kind.into(),
            value: root_value,
            refs,
        };
        // Appending preserves cursor continuity. Only rollback/rebuild changes
        // the visible-index generation and invalidates history_sync cursors.
        let generation = self.index().index_generation;
        let next_root = root.object_id.clone();
        self.stage_object(root);
        let updated_at = now_iso();
        let next = HistoryHead {
            session_id: self.session_id.to_owned(),
            object_id: Some(next_root.clone()),
            revision,
            updated_at: updated_at.clone(),
        };
        self.work().set_head(next.clone());
        self.work().set_index_root(Some(next_root.clone()));
        self.work().set_current_head_revision(revision);
        // The head is its own durable record so a restart can resume from it
        // without re-deriving it from the entity window.
        self.staged.push(Record::HistoryAux(AuxRecord::Head(next)));
        self.staged.push(Record::HistoryEntities(HistoryEntities {
            session_id: self.session_id.to_owned(),
            revision,
            updated_at,
            next_root,
            generation,
            changes,
        }));
        Ok(revision)
    }


    fn verify(&mut self) -> Result<Vec<u8>, HistoryError> {
        let mut objects = 0u64;
        let mut invalid = Vec::new();
        for (object_id, object) in &self.state.index.objects {
            objects += 1;
            let identity = serialized(&(&object.kind, &object.value, &object.refs))?;
            let digest_id = format!("{OBJECT_DIGEST}:{:x}", Sha256::digest(&identity));
            if &object.object_id!= object_id || object.object_id!= digest_id {
                invalid.push(format!("{object_id}:content-hash"));
            }
            for reference in &object.refs {
                if!self.state.index.objects.contains_key(reference) {
                    invalid.push(format!("{object_id}:missing-ref:{reference}"));
                }
            }
        }
        for (pin, stored) in &self.state.index.aux {
            let Some(pin) = pin.strip_prefix("pin\0") else {
                continue;
            };
            let Some(stored) = stored.as_ref() else {
                continue;
            };
            let object_id = stored["objectId"].as_str().unwrap_or_default();
            if!self.state.index.objects.contains_key(object_id) {
                invalid.push(format!(
                    "{session}/{pin}:missing-pin:{object_id}",
                    session = self.session_id
                ));
            }
        }
        let ok = invalid.is_empty();
        serialized(&object(&[
            ("objects", number(objects)),
            (
                "invalid",
                array(invalid.into_iter().map(|item| text(&item)).collect()),
            ),
            ("ok", boolean(ok)),
        ]))
    }

    fn rebuild_index(&mut self) -> Result<Vec<u8>, HistoryError> {
        let head = self.index().head.clone();
        let mut sessions = 0u64;
        if let Some(root) = head.object_id.clone() {
            let objects = self.index().objects.clone();
            let mut lookup = |id: &str| objects.get(id).cloned();
            self.work().rebuild(&root, &mut lookup)?;
            self.bump_index_generation();
            sessions = 1;
            self.staged.push(Record::HistoryAux(AuxRecord::Head(head)));
        }
        serialized(&object(&[
            ("sessions", number(sessions)),
            ("rebuilt", boolean(true)),
        ]))
    }

    /// History objects are append-only and content addressed, and blobs are
    /// shared by file images; a bounded pass reports an idle sweep.
    fn gc(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let batch = match value.get("batchSize").or_else(|| value.get("limit")) {
            None => 128,
            Some(item) => item
                .as_u64()
                .filter(|size| (1..=512).contains(size))
                .ok_or_else(|| {
                    HistoryError::InvalidCommand(
                        "history gc batchSize must be between 1 and 512".into(),
                    )
                })?,
        };
        let mut reachable = HashSet::new();
        let mut queue = self
            .index()
            .head
            .object_id
            .clone()
            .into_iter()
            .collect::<Vec<_>>();
        while let Some(object_id) = queue.pop() {
            if !reachable.insert(object_id.clone()) {
                continue;
            }
            if let Some(saved) = self.index().objects.get(&object_id) {
                queue.extend(saved.refs.iter().cloned());
            }
        }
        let deleted: Vec<String> = self
            .index()
            .objects
            .keys()
            .filter(|object_id| !reachable.contains(*object_id))
            .cloned()
            .collect();
        if !deleted.is_empty() {
            self.staged.push(Record::HistoryAux(AuxRecord::Gc(deleted.clone())));
            for object_id in &deleted {
                self.work().objects.remove(object_id);
            }
        }
        serialized(&object(&[
            ("phase", text("done")),
            ("pending", boolean(false)),
            ("marked", number(0)),
            ("scanned", number(0)),
            ("deleted", number(deleted.len() as u64)),
            ("batchSize", number(batch)),
            ("queueDepth", number(0)),
        ]))
    }

    // ---------------------------------------------------------- metadata

    fn scope(&self) -> String {
        self.index()
            .metadata_scope
            .clone()
            .unwrap_or_else(|| self.session_id.to_owned())
    }

    fn metadata(&mut self) -> Result<MetadataStore, HistoryError> {
        let dir = self.history_dir()?.join("metadata");
        let reported = self.index().metadata_generation;
        MetadataStore::open(&dir, &self.scope(), reported)
    }

    // ------------------------------------------------------------- files

    fn file_command(
        &mut self,
        request_id: &str,
        operation: &str,
        value: &Value,
    ) -> Result<Vec<u8>, HistoryError> {
        let session_dir = layout::session_dir(self.root(), self.session_id).map_err(convert_io)?;
        let mut files = FileStore::new(history_path(self.root(), self.session_id)?);
        let before = self.index();
        let imported = if operation == "file_import" {
            import_entities(value)
        } else {
            Vec::new()
        };
        let ctx = files::FileContext {
            root: self.root(),
            history_root: self.history_dir()?,
            session_dir: &session_dir,
            session_id: self.session_id,
            request_id,
            index: before,
        };
        let result = match operation {
            "file_checkpoint" => files.checkpoint(&ctx, value),
            "file_begin" => Some(files.begin(&ctx, value)?),
            "file_finish" | "file_abandon" => Some(files.finish(&ctx, operation, value)?),
            "file_import" => Some(files.import(&ctx, value)?),
            "file_pending" => Some(files.pending_view(&ctx)?),
            "file_cursor" => Some(files.cursor_view(&ctx)?),
            "file_preview" => Some(files.preview(&ctx, value)?),
            "restore_checkpoint" => Some(files.restore_checkpoint(&ctx, value)?),
            "file_recover" => Some(files.recover(&ctx)?),
            "file_restore_ack" => {
                files.restore_ack(&ctx, value)?;
                // Commit the staged restore-marker removal with its receipt,
                // just like the other file commands below.
                Some(empty())
            }
            _ => return Err(HistoryError::InvalidCommand("unknown file operation".into())),
        };
        let checkpointed = operation == "file_checkpoint";
        for (key, value) in files.take_staged() {
            self.set_aux(key, value);
        }
        if checkpointed {
            self.bump_index_generation();
        }
        if let Some(target) = files.take_head_switch() {
            let revision = self.index().head.revision;
            self.switch_head(&target, Some(revision))?;
        }
        if let Some(appended) = files.take_appended() {
            self.stage_append(&appended, None)?;
        } else if!imported.is_empty() {
            self.stage_append(&object(&[("objects", array(imported))]), None)?;
        }
        match result {
            Some(result) => serialized(&result),
            None => return Err(HistoryError::ObjectMissing("checkpoint pin".into())),
        }
    }

    /// Append every staged record, sync once, then publish. Nothing becomes
    /// visible before the frames are durable.
    fn commit(&mut self) -> Result<(), HistoryError> {
        if self.staged.is_empty() {
            return Ok(());
        }
        if self.state.failed { return Err(HistoryError::InvalidCommand("history writer requires reopen after failed rollback".into())); }
        let records = std::mem::take(&mut self.staged);
        let mut frames: Vec<Vec<u8>> = records.iter().map(Record::encode).collect();
        frames.push(Record::HistorySeal { c: self.state.index.current_head_revision.saturating_add(1) }.encode());
        if frames.iter().any(|frame| frame.len() > crate::storage::jsonl::seglog::MAX_FRAME) {
            return Err(HistoryError::InvalidCommand("history record exceeds frame budget".into()));
        }
        let before = self.state.file.len();
        let written = (|| {
            for frame in &frames { self.state.file.append(frame)?; }
            self.state.file.sync()
        })();
        if let Err(error) = written {
            self.state.failed = true;
            self.state.file.truncate(before).map_err(convert_io)?;
            self.state.file.sync().map_err(convert_io)?;
            self.state.failed = false;
            return Err(convert_io(error));
        }
        let mut index = self
            .index
            .take()
            .unwrap_or_else(|| SessionIndex::clone_index(&self.state.index));
        for record in records {
            let mut lookup = |_: &str| None;
            index.apply(record, &mut lookup)?;
        }
        self.state.published.store(Arc::new(SessionIndex::clone_index(&index)));
        self.state.index = index;
        if let Err(error) = super::checkpoint::save(self.state, false) {
            tracing::warn!(event = "storage.history_checkpoint_failed", error = %error,
                "History query index remains available; checkpoint will be retried");
        }
        Ok(())
    }
}

/// The `file_change` entities an import carries, as append inputs.
fn import_entities(value: &Value) -> Vec<Value> {
    value["records"]
        .as_array()
        .map(|records| {
            records
                .iter()
                .map(|record| {
                    object(&[
                        ("kind", text("runtime.file_change")),
                        ("value", record.clone()),
                    ])
                })
                .collect()
        })
        .unwrap_or_default()
}

fn convert_io(error: crate::storage::jsonl::error::JsonlError) -> HistoryError {
    HistoryError::InvalidCommand(error.to_string())
}

fn file_io(error: std::io::Error) -> HistoryError {
    HistoryError::FileIo(error.to_string())
}

fn read_optional(path: &std::path::Path) -> Result<Option<Vec<u8>>, HistoryError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(file_io(error)),
    }
}

/// Write `bytes` unless the file already holds them; a different existing
/// image for the same id is a conflict.
fn write_once(path: &std::path::Path, bytes: &[u8]) -> Result<(), HistoryError> {
    match read_optional(path)? {
        Some(previous) if previous!= bytes => Err(HistoryError::RequestConflict),
        Some(_) => Ok(()),
        None => write_replace(path, bytes),
    }
}

fn write_replace(path: &std::path::Path, bytes: &[u8]) -> Result<(), HistoryError> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(file_io)?;
    }
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = std::fs::File::create(&temp).map_err(file_io)?;
    file.write_all(bytes).map_err(file_io)?;
    file.sync_data().map_err(file_io)?;
    drop(file);
    std::fs::rename(&temp, path).map_err(file_io)?;
    Ok(())
}
