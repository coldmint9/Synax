//! Immutable runtime history storage.
//!
//! The hot store owns the live session fence and bounded replay window. This
//! store owns immutable transcript objects and named heads, so checkpoint,
//! fork, rollback and garbage collection never copy the full conversation.

use moka::future::Cache;
use rocksdb::{ColumnFamilyDescriptor, DB, Options, WriteBatch};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::sync::Arc;
use thiserror::Error;

const CF_OBJECTS: &str = "objects";
const CF_HEADS: &str = "heads";
const CF_PINS: &str = "pins";
const CF_RECEIPTS: &str = "receipts";
const CF_INDEXES: &str = "indexes";
const CF_BLOBS: &str = "blobs";
const CF_ASSETS: &str = "assets";
const CF_ASSET_BINDINGS: &str = "asset_bindings";
const MAX_OBJECT_BYTES: usize = 4 * 1024 * 1024;
const MAX_COMMAND_BYTES: usize = 8 * 1024 * 1024;
const MAX_BLOB_CHUNK_BYTES: usize = 256 * 1024;
const MAX_BLOB_CHUNKS: u64 = 16_384;
const PAGE_LIMIT: usize = 256;

#[derive(Debug, Error)]
pub enum HistoryError {
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

#[derive(Clone)]
pub struct HistoryStore {
    db: Arc<DB>,
    object_cache: Cache<String, Vec<u8>>,
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
            CF_BLOBS,
            CF_ASSETS,
            CF_ASSET_BINDINGS,
        ]
        .into_iter()
        .map(|name| ColumnFamilyDescriptor::new(name, Options::default()))
        .collect::<Vec<_>>();
        let db = Arc::new(DB::open_cf_descriptors(&options, path, descriptors)?);
        Ok(Self {
            db,
            object_cache: Cache::builder().max_capacity(4096).build(),
        })
    }

    pub async fn command_async(
        &self,
        session_id: String,
        request_id: String,
        operation: String,
        payload: Vec<u8>,
    ) -> Result<Vec<u8>, HistoryError> {
        let store = self.clone();
        let operation_for_task = operation.clone();
        let result = tokio::task::spawn_blocking(move || {
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
        if let Some(bytes) = self.get(CF_RECEIPTS, receipt_key.as_bytes())? {
            let receipt: HistoryReceipt = serde_json::from_slice(&bytes)?;
            if receipt.identity != identity {
                return Err(HistoryError::RequestConflict);
            }
            return Ok(receipt.result);
        }

        let result = match operation {
            "put_object" => self.put_object(&value)?,
            "put_blob_chunk" => self.put_blob_chunk(&value)?,
            "put_blob_manifest" => self.put_blob_manifest(&value)?,
            "get_blob_chunk" => self.get_blob_chunk(&value)?,
            "get_blob_manifest" => self.get_blob_manifest(&value)?,
            "delete_blob" => self.delete_blob(&value)?,
            "asset_put" => self.asset_put(&value)?,
            "asset_get" => self.asset_get(&value)?,
            "asset_bind" => self.asset_bind(&value)?,
            "asset_unbind" => self.asset_unbind(&value)?,
            "asset_has_binding" => self.asset_has_binding(&value)?,
            "asset_list_bindings" => self.asset_list_bindings(&value)?,
            "asset_delete" => self.asset_delete(&value)?,
            "get_object" => {
                let object_id = required_string(&value, "objectId")?;
                self.read_object(object_id)?
            }
            "head_read" => self.head_read(session_id)?,
            "head_switch" | "checkpoint" => self.head_switch(session_id, &value, operation)?,
            "list_checkpoints" => self.list_checkpoints(session_id)?,
            "fork" => self.fork(session_id, &value)?,
            "rollback" => self.head_switch(session_id, &value, "head_switch")?,
            "pin" => self.pin(session_id, &value)?,
            "unpin" => self.unpin(session_id, &value)?,
            "page" => self.page(&value)?,
            "list_runs" => self.list_indexed(session_id, "run")?,
            "list_messages" => self.list_indexed(session_id, "message")?,
            "list_steps" => self.list_indexed(session_id, "step")?,
            "list_parts" => self.list_indexed(session_id, "part")?,
            "list_tool_calls" => self.list_indexed(session_id, "tool")?,
            "list_events" => self.list_indexed(session_id, "event")?,
            "list_artifacts" => self.list_indexed(session_id, "artifact")?,
            "list_plans" => self.list_indexed(session_id, "plan")?,
            "verify" => self.verify()?,
            "rebuild_index" => self.rebuild_index()?,
            "gc" => self.gc()?,
            _ => {
                return Err(HistoryError::InvalidCommand(format!(
                    "unknown history operation: {operation}"
                )));
            }
        };
        let receipt = serde_json::to_vec(&HistoryReceipt {
            identity,
            result: result.clone(),
        })?;
        let mut batch = WriteBatch::default();
        batch.put_cf(self.cf(CF_RECEIPTS)?, receipt_key.as_bytes(), receipt);
        self.db.write(batch)?;
        Ok(result)
    }

    fn put_object(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
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
        let mut batch = WriteBatch::default();
        if self
            .get(CF_OBJECTS, object_key(&object_id).as_bytes())?
            .is_none()
        {
            batch.put_cf(
                self.cf(CF_OBJECTS)?,
                object_key(&object_id).as_bytes(),
                &bytes,
            );
            let index_kind = match kind {
                "runtime.run" => Some("run"),
                "runtime.message" => Some("message"),
                "runtime.step" => Some("step"),
                "runtime.part" => Some("part"),
                "runtime.tool_call" => Some("tool"),
                "runtime.event" => Some("event"),
                "runtime.artifact" => Some("artifact"),
                "runtime.plan" => Some("plan"),
                _ => None,
            };
            if let Some(index_kind) = index_kind {
                if let (Some(session_id), Some(run_id)) = (
                    object.value["sessionId"].as_str(),
                    object.value["id"].as_str(),
                ) {
                    batch.put_cf(
                        self.cf(CF_INDEXES)?,
                        format!("{index_kind}/{session_id}/{run_id}").as_bytes(),
                        object_id.as_bytes(),
                    );
                }
            }
            self.db.write(batch)?;
        }
        Ok(serde_json::to_vec(
            &serde_json::json!({"objectId": object_id, "bytes": bytes.len()}),
        )?)
    }

    fn put_blob_chunk(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
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
            let mut batch = WriteBatch::default();
            batch.put_cf(self.cf(CF_BLOBS)?, key.as_bytes(), bytes.as_slice());
            self.db.write(batch)?;
        }
        Ok(serde_json::to_vec(
            &serde_json::json!({"blobId":blob_id,"index":index,"total":total,"bytes":bytes.len()}),
        )?)
    }

    fn put_blob_manifest(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
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
        let mut batch = WriteBatch::default();
        batch.put_cf(
            self.cf(CF_BLOBS)?,
            blob_manifest_key(blob_id).as_bytes(),
            serde_json::to_vec(&manifest)?,
        );
        self.db.write(batch)?;
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

    fn delete_blob(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let blob_id = required_string(value, "blobId")?;
        let prefix = format!("c/{blob_id}/");
        let mut batch = WriteBatch::default();
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
        if deleted > 0 {
            self.db.write(batch)?;
        }
        Ok(serde_json::to_vec(
            &serde_json::json!({"blobId":blob_id,"deleted":deleted}),
        )?)
    }

    fn asset_put(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
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
            let mut batch = WriteBatch::default();
            batch.put_cf(
                self.cf(CF_ASSETS)?,
                key.as_bytes(),
                serde_json::to_vec(&asset)?,
            );
            self.db.write(batch)?;
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

    fn asset_bind(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let asset_id = required_string(value, "assetId")?;
        let session_id = required_string(value, "sessionId")?;
        if self
            .get(CF_ASSETS, format!("a/{asset_id}").as_bytes())?
            .is_none()
        {
            return Err(HistoryError::ObjectMissing(format!("asset {asset_id}")));
        }
        let key = format!("b/{session_id}/{asset_id}");
        let mut batch = WriteBatch::default();
        batch.put_cf(self.cf(CF_ASSET_BINDINGS)?, key.as_bytes(), b"1");
        self.db.write(batch)?;
        Ok(serde_json::to_vec(
            &serde_json::json!({"assetId":asset_id,"sessionId":session_id,"bound":true}),
        )?)
    }

    fn asset_unbind(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let asset_id = required_string(value, "assetId")?;
        let session_id = required_string(value, "sessionId")?;
        let mut batch = WriteBatch::default();
        batch.delete_cf(
            self.cf(CF_ASSET_BINDINGS)?,
            format!("b/{session_id}/{asset_id}").as_bytes(),
        );
        self.db.write(batch)?;
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

    fn asset_delete(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
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
        let mut batch = WriteBatch::default();
        batch.delete_cf(self.cf(CF_ASSETS)?, asset_key.as_bytes());
        self.db.write(batch)?;
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
        let mut batch = WriteBatch::default();
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
            self.db.write(batch)?;
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
        self.db.write(batch)?;
        Ok(serde_json::to_vec(&head)?)
    }

    fn list_checkpoints(&self, session_id: &str) -> Result<Vec<u8>, HistoryError> {
        let prefix = format!("p/{session_id}/");
        let mut items = Vec::new();
        for item in self.db.iterator_cf(
            self.cf(CF_PINS)?,
            rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward),
        ) {
            let (key, value) = item?;
            if !key.starts_with(prefix.as_bytes()) {
                break;
            }
            let pin_id = String::from_utf8_lossy(&key)
                .trim_start_matches(&prefix)
                .to_owned();
            let (object_id, metadata) = match serde_json::from_slice::<serde_json::Value>(&value) {
                Ok(saved) if saved["objectId"].is_string() => (
                    saved["objectId"].as_str().unwrap_or_default().to_owned(),
                    saved
                        .get("metadata")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({})),
                ),
                _ => (
                    String::from_utf8_lossy(&value).to_string(),
                    serde_json::json!({}),
                ),
            };
            items.push(serde_json::json!({"id":pin_id,"objectId":object_id,"metadata":metadata}));
        }
        Ok(serde_json::to_vec(&serde_json::json!({"items":items}))?)
    }

    fn pin(&self, session_id: &str, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let pin_id = required_string(value, "pinId")?;
        let object_id = required_string(value, "objectId")?;
        if self
            .get(CF_OBJECTS, object_key(object_id).as_bytes())?
            .is_none()
        {
            return Err(HistoryError::ObjectMissing(object_id.to_owned()));
        }
        let mut batch = WriteBatch::default();
        batch.put_cf(
            self.cf(CF_PINS)?,
            pin_key(session_id, pin_id).as_bytes(),
            object_id.as_bytes(),
        );
        self.db.write(batch)?;
        Ok(serde_json::to_vec(
            &serde_json::json!({"pinId":pin_id,"objectId":object_id}),
        )?)
    }

    fn fork(
        &self,
        target_session_id: &str,
        value: &serde_json::Value,
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
        let mut batch = WriteBatch::default();
        batch.put_cf(
            self.cf(CF_HEADS)?,
            head_key(target_session_id).as_bytes(),
            serde_json::to_vec(&next)?,
        );
        self.db.write(batch)?;
        Ok(serde_json::to_vec(
            &serde_json::json!({"sourceSessionId":source_session_id,"head":next}),
        )?)
    }

    fn unpin(&self, session_id: &str, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let pin_id = required_string(value, "pinId")?;
        let mut batch = WriteBatch::default();
        batch.delete_cf(self.cf(CF_PINS)?, pin_key(session_id, pin_id).as_bytes());
        self.db.write(batch)?;
        Ok(serde_json::to_vec(
            &serde_json::json!({"pinId":pin_id,"removed":true}),
        )?)
    }

    fn page(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let object_id = required_string(value, "objectId")?;
        let limit = value
            .get("limit")
            .and_then(|item| item.as_u64())
            .unwrap_or(64)
            .min(PAGE_LIMIT as u64) as usize;
        let mut queue = VecDeque::from([object_id.to_owned()]);
        let mut seen = HashSet::new();
        let mut objects = Vec::new();
        while let Some(current) = queue.pop_front() {
            if !seen.insert(current.clone()) {
                continue;
            }
            if objects.len() >= limit {
                break;
            }
            let bytes = self.read_object(&current)?;
            let object: HistoryObject = serde_json::from_slice(&bytes)?;
            for reference in &object.refs {
                queue.push_back(reference.clone());
            }
            objects.push(object);
        }
        Ok(serde_json::to_vec(
            &serde_json::json!({"items":objects,"next":queue.front()}),
        )?)
    }

    fn list_indexed(&self, session_id: &str, kind: &str) -> Result<Vec<u8>, HistoryError> {
        if let Some(head_id) = self.read_head(session_id)?.object_id {
            let head_is_root = self
                .read_object(&head_id)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<HistoryObject>(&bytes).ok())
                .is_some_and(|object| {
                    object.kind == "runtime.session.root"
                        || object.kind == "runtime.session.root.chunk"
                });
            if !head_is_root {
                return self.list_indexed_legacy(session_id, kind);
            }
            let mut queue = VecDeque::from([head_id]);
            let mut seen = HashSet::new();
            let mut items = Vec::new();
            while let Some(object_id) = queue.pop_front() {
                if !seen.insert(object_id.clone()) {
                    continue;
                }
                let bytes = self.read_object(&object_id)?;
                let object: HistoryObject = serde_json::from_slice(&bytes)?;
                for reference in &object.refs {
                    queue.push_back(reference.clone());
                }
                let matches = match kind {
                    "run" => object.kind == "runtime.run",
                    "message" => object.kind == "runtime.message",
                    "step" => object.kind == "runtime.step",
                    "part" => object.kind == "runtime.part",
                    "tool" => object.kind == "runtime.tool_call",
                    "event" => object.kind == "runtime.event",
                    "artifact" => object.kind == "runtime.artifact",
                    "plan" => object.kind == "runtime.plan",
                    _ => false,
                };
                if matches {
                    items.push(object.value);
                }
            }
            return Ok(serde_json::to_vec(&serde_json::json!({"items":items}))?);
        }
        self.list_indexed_legacy(session_id, kind)
    }

    fn list_indexed_legacy(&self, session_id: &str, kind: &str) -> Result<Vec<u8>, HistoryError> {
        let prefix = format!("{kind}/{session_id}/");
        let mut items = Vec::new();
        for item in self.db.iterator_cf(
            self.cf(CF_INDEXES)?,
            rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward),
        ) {
            let (key, value) = item?;
            if !key.starts_with(prefix.as_bytes()) {
                break;
            }
            let object_id = String::from_utf8_lossy(&value).to_string();
            if let Ok(bytes) = self.read_object(&object_id) {
                if let Ok(object) = serde_json::from_slice::<HistoryObject>(&bytes) {
                    items.push(object.value);
                }
            }
        }
        Ok(serde_json::to_vec(&serde_json::json!({"items":items}))?)
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

    fn rebuild_index(&self) -> Result<Vec<u8>, HistoryError> {
        let mut batch = WriteBatch::default();
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
                value,
            );
            sessions += 1;
        }
        if sessions > 0 {
            self.db.write(batch)?;
        }
        Ok(serde_json::to_vec(
            &serde_json::json!({"sessions":sessions,"rebuilt":true}),
        )?)
    }

    fn gc(&self) -> Result<Vec<u8>, HistoryError> {
        let mut roots = Vec::new();
        for item in self
            .db
            .iterator_cf(self.cf(CF_HEADS)?, rocksdb::IteratorMode::Start)
        {
            let (_, value) = item?;
            if let Some(object_id) = serde_json::from_slice::<HistoryHead>(&value)?.object_id {
                roots.push(object_id);
            }
        }
        for item in self
            .db
            .iterator_cf(self.cf(CF_PINS)?, rocksdb::IteratorMode::Start)
        {
            let (_, value) = item?;
            let object_id = serde_json::from_slice::<serde_json::Value>(&value)
                .ok()
                .and_then(|saved| saved["objectId"].as_str().map(str::to_owned))
                .unwrap_or_else(|| String::from_utf8_lossy(&value).to_string());
            roots.push(object_id);
        }
        let mut marked = HashSet::new();
        let mut queue: VecDeque<String> = roots.into_iter().collect();
        while let Some(object_id) = queue.pop_front() {
            if !marked.insert(object_id.clone()) {
                continue;
            }
            let Ok(bytes) = self.read_object(&object_id) else {
                continue;
            };
            if let Ok(object) = serde_json::from_slice::<HistoryObject>(&bytes) {
                queue.extend(object.refs);
            }
        }
        let mut deleted = 0u64;
        let mut batch = WriteBatch::default();
        let mut deleted_ids = Vec::new();
        for item in self
            .db
            .iterator_cf(self.cf(CF_OBJECTS)?, rocksdb::IteratorMode::Start)
        {
            let (key, _) = item?;
            let object_id = String::from_utf8_lossy(&key)
                .trim_start_matches("o/")
                .to_owned();
            if !marked.contains(&object_id) {
                batch.delete_cf(self.cf(CF_OBJECTS)?, key);
                deleted_ids.push(object_id);
                deleted += 1;
            }
        }
        if !deleted_ids.is_empty() {
            for item in self
                .db
                .iterator_cf(self.cf(CF_INDEXES)?, rocksdb::IteratorMode::Start)
            {
                let (key, value) = item?;
                if deleted_ids.iter().any(|id| value.as_ref() == id.as_bytes()) {
                    batch.delete_cf(self.cf(CF_INDEXES)?, key);
                }
            }
        }
        if deleted > 0 {
            self.db.write(batch)?;
        }
        Ok(serde_json::to_vec(
            &serde_json::json!({"marked":marked.len(),"deleted":deleted}),
        )?)
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
            serde_json::from_slice::<serde_json::Value>(&events).unwrap()["items"][0]["id"],
            "event-1"
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
