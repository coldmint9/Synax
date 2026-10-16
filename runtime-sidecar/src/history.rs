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
const MAX_OBJECT_BYTES: usize = 4 * 1024 * 1024;
const MAX_COMMAND_BYTES: usize = 8 * 1024 * 1024;
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
        let descriptors = [CF_OBJECTS, CF_HEADS, CF_PINS, CF_RECEIPTS, CF_INDEXES]
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
            .map_err(|error| HistoryError::InvalidCommand(format!("history task failed: {error}")))??;
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
            return Err(HistoryError::InvalidCommand("history command exceeds bounds".into()));
        }
        let value: serde_json::Value = if payload.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(payload)?
        };
        let identity = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&("history.v1", session_id, operation, &value))?)
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
            "get_object" => {
                let object_id = required_string(&value, "objectId")?;
                self.read_object(object_id)?
            }
            "head_read" => self.head_read(session_id)?,
            "head_switch" | "checkpoint" => self.head_switch(session_id, &value, operation)?,
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
            "verify" => self.verify()?,
            "rebuild_index" => self.rebuild_index()?,
            "gc" => self.gc()?,
            _ => return Err(HistoryError::InvalidCommand(format!("unknown history operation: {operation}"))),
        };
        let receipt = serde_json::to_vec(&HistoryReceipt { identity, result: result.clone() })?;
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
            return Err(HistoryError::InvalidCommand("history object exceeds bounds".into()));
        }
        for object_id in &refs {
            if self.get(CF_OBJECTS, object_key(object_id).as_bytes())?.is_none() {
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
        if self.get(CF_OBJECTS, object_key(&object_id).as_bytes())?.is_none() {
            batch.put_cf(self.cf(CF_OBJECTS)?, object_key(&object_id).as_bytes(), &bytes);
            let index_kind = match kind {
                "runtime.run" => Some("run"),
                "runtime.message" => Some("message"),
                "runtime.step" => Some("step"),
                "runtime.part" => Some("part"),
                "runtime.tool_call" => Some("tool"),
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
        Ok(serde_json::to_vec(&serde_json::json!({"objectId": object_id, "bytes": bytes.len()}))?)
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
        if self.get(CF_OBJECTS, object_key(object_id).as_bytes())?.is_none() {
            return Err(HistoryError::ObjectMissing(object_id.to_owned()));
        }
        let mut head = self.read_head(session_id)?;
        if let Some(expected) = value.get("expectedRevision").and_then(|item| item.as_u64()) {
            if expected != head.revision {
                return Err(HistoryError::RevisionConflict { expected, actual: head.revision });
            }
        }
        head.session_id = session_id.to_owned();
        head.object_id = Some(object_id.to_owned());
        head.revision += 1;
        head.updated_at = now_iso();
        let mut batch = WriteBatch::default();
        batch.put_cf(self.cf(CF_HEADS)?, head_key(session_id).as_bytes(), serde_json::to_vec(&head)?);
        if operation == "checkpoint" {
            let pin_id = value.get("pinId").and_then(|item| item.as_str()).unwrap_or(object_id);
            batch.put_cf(
                self.cf(CF_PINS)?,
                pin_key(session_id, pin_id).as_bytes(),
                object_id.as_bytes(),
            );
        }
        self.db.write(batch)?;
        Ok(serde_json::to_vec(&head)?)
    }

    fn pin(&self, session_id: &str, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let pin_id = required_string(value, "pinId")?;
        let object_id = required_string(value, "objectId")?;
        if self.get(CF_OBJECTS, object_key(object_id).as_bytes())?.is_none() {
            return Err(HistoryError::ObjectMissing(object_id.to_owned()));
        }
        let mut batch = WriteBatch::default();
        batch.put_cf(self.cf(CF_PINS)?, pin_key(session_id, pin_id).as_bytes(), object_id.as_bytes());
        self.db.write(batch)?;
        Ok(serde_json::to_vec(&serde_json::json!({"pinId":pin_id,"objectId":object_id}))?)
    }

    fn fork(&self, target_session_id: &str, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let source_session_id = required_string(value, "sourceSessionId")?;
        let source = self.read_head(source_session_id)?;
        let object_id = source
            .object_id
            .as_deref()
            .ok_or_else(|| HistoryError::InvalidCommand("source history has no head".into()))?;
        let target = self.read_head(target_session_id)?;
        if target.revision != 0 {
            return Err(HistoryError::RevisionConflict { expected: 0, actual: target.revision });
        }
        let next = HistoryHead {
            session_id: target_session_id.to_owned(),
            object_id: Some(object_id.to_owned()),
            revision: 1,
            updated_at: now_iso(),
        };
        let mut batch = WriteBatch::default();
        batch.put_cf(self.cf(CF_HEADS)?, head_key(target_session_id).as_bytes(), serde_json::to_vec(&next)?);
        self.db.write(batch)?;
        Ok(serde_json::to_vec(&serde_json::json!({"sourceSessionId":source_session_id,"head":next}))?)
    }

    fn unpin(&self, session_id: &str, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let pin_id = required_string(value, "pinId")?;
        let mut batch = WriteBatch::default();
        batch.delete_cf(self.cf(CF_PINS)?, pin_key(session_id, pin_id).as_bytes());
        self.db.write(batch)?;
        Ok(serde_json::to_vec(&serde_json::json!({"pinId":pin_id,"removed":true}))?)
    }

    fn page(&self, value: &serde_json::Value) -> Result<Vec<u8>, HistoryError> {
        let object_id = required_string(value, "objectId")?;
        let limit = value.get("limit").and_then(|item| item.as_u64()).unwrap_or(64).min(PAGE_LIMIT as u64) as usize;
        let mut queue = VecDeque::from([object_id.to_owned()]);
        let mut seen = HashSet::new();
        let mut objects = Vec::new();
        while let Some(current) = queue.pop_front() {
            if !seen.insert(current.clone()) { continue; }
            if objects.len() >= limit { break; }
            let bytes = self.read_object(&current)?;
            let object: HistoryObject = serde_json::from_slice(&bytes)?;
            for reference in &object.refs { queue.push_back(reference.clone()); }
            objects.push(object);
        }
        Ok(serde_json::to_vec(&serde_json::json!({"items":objects,"next":queue.front()}))?)
    }

    fn list_indexed(&self, session_id: &str, kind: &str) -> Result<Vec<u8>, HistoryError> {
        let prefix = format!("{kind}/{session_id}/");
        let mut items = Vec::new();
        for item in self.db.iterator_cf(
            self.cf(CF_INDEXES)?,
            rocksdb::IteratorMode::From(prefix.as_bytes(), rocksdb::Direction::Forward),
        ) {
            let (key, value) = item?;
            if !key.starts_with(prefix.as_bytes()) { break; }
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
        for item in self.db.iterator_cf(self.cf(CF_OBJECTS)?, rocksdb::IteratorMode::Start) {
            let (key, value) = item?;
            match serde_json::from_slice::<HistoryObject>(&value) {
                Ok(object) => {
                    objects += 1;
                    if object.object_id != String::from_utf8_lossy(&key).trim_start_matches("o/") {
                        invalid.push(String::from_utf8_lossy(&key).to_string());
                    }
                }
                Err(_) => invalid.push(String::from_utf8_lossy(&key).to_string()),
            }
        }
        Ok(serde_json::to_vec(&serde_json::json!({"objects":objects,"invalid":invalid,"ok":invalid.is_empty()}))?)
    }

    fn rebuild_index(&self) -> Result<Vec<u8>, HistoryError> {
        let mut batch = WriteBatch::default();
        let mut sessions = 0u64;
        for item in self.db.iterator_cf(self.cf(CF_HEADS)?, rocksdb::IteratorMode::Start) {
            let (key, value) = item?;
            let session_id = String::from_utf8_lossy(&key).trim_start_matches("h/").to_owned();
            batch.put_cf(self.cf(CF_INDEXES)?, format!("session/{session_id}").as_bytes(), value);
            sessions += 1;
        }
        if sessions > 0 { self.db.write(batch)?; }
        Ok(serde_json::to_vec(&serde_json::json!({"sessions":sessions,"rebuilt":true}))?)
    }

    fn gc(&self) -> Result<Vec<u8>, HistoryError> {
        let mut roots = Vec::new();
        for item in self.db.iterator_cf(self.cf(CF_HEADS)?, rocksdb::IteratorMode::Start) {
            let (_, value) = item?;
            if let Some(object_id) = serde_json::from_slice::<HistoryHead>(&value)?.object_id { roots.push(object_id); }
        }
        for item in self.db.iterator_cf(self.cf(CF_PINS)?, rocksdb::IteratorMode::Start) {
            let (_, value) = item?;
            roots.push(String::from_utf8_lossy(&value).to_string());
        }
        let mut marked = HashSet::new();
        let mut queue: VecDeque<String> = roots.into_iter().collect();
        while let Some(object_id) = queue.pop_front() {
            if !marked.insert(object_id.clone()) { continue; }
            let Ok(bytes) = self.read_object(&object_id) else { continue; };
            if let Ok(object) = serde_json::from_slice::<HistoryObject>(&bytes) {
                queue.extend(object.refs);
            }
        }
        let mut deleted = 0u64;
        let mut batch = WriteBatch::default();
        let mut deleted_ids = Vec::new();
        for item in self.db.iterator_cf(self.cf(CF_OBJECTS)?, rocksdb::IteratorMode::Start) {
            let (key, _) = item?;
            let object_id = String::from_utf8_lossy(&key).trim_start_matches("o/").to_owned();
            if !marked.contains(&object_id) {
                batch.delete_cf(self.cf(CF_OBJECTS)?, key);
                deleted_ids.push(object_id);
                deleted += 1;
            }
        }
        if !deleted_ids.is_empty() {
            for item in self.db.iterator_cf(self.cf(CF_INDEXES)?, rocksdb::IteratorMode::Start) {
                let (key, value) = item?;
                if deleted_ids.iter().any(|id| value.as_ref() == id.as_bytes()) {
                    batch.delete_cf(self.cf(CF_INDEXES)?, key);
                }
            }
        }
        if deleted > 0 { self.db.write(batch)?; }
        Ok(serde_json::to_vec(&serde_json::json!({"marked":marked.len(),"deleted":deleted}))?)
    }

    fn read_object(&self, object_id: &str) -> Result<Vec<u8>, HistoryError> {
        self.get(CF_OBJECTS, object_key(object_id).as_bytes())?
            .ok_or_else(|| HistoryError::ObjectMissing(object_id.to_owned()))
    }

    fn read_head(&self, session_id: &str) -> Result<HistoryHead, HistoryError> {
        let Some(bytes) = self.get(CF_HEADS, head_key(session_id).as_bytes())? else {
            return Ok(HistoryHead { session_id: session_id.to_owned(), ..HistoryHead::default() });
        };
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn cf(&self, name: &str) -> Result<&rocksdb::ColumnFamily, HistoryError> {
        self.db.cf_handle(name).ok_or_else(|| HistoryError::InvalidCommand(format!("missing column family: {name}")))
    }

    fn get(&self, cf: &str, key: &[u8]) -> Result<Option<Vec<u8>>, HistoryError> {
        Ok(self.db.get_cf(self.cf(cf)?, key)?)
    }
}

fn required_string<'a>(value: &'a serde_json::Value, key: &str) -> Result<&'a str, HistoryError> {
    value[key].as_str().filter(|item| !item.is_empty()).ok_or_else(|| HistoryError::InvalidCommand(format!("{key} is required")))
}

fn object_key(object_id: &str) -> String { format!("o/{object_id}") }
fn head_key(session_id: &str) -> String { format!("h/{session_id}") }
fn pin_key(session_id: &str, pin_id: &str) -> String { format!("p/{session_id}/{pin_id}") }
fn now_iso() -> String { chrono::Utc::now().to_rfc3339() }

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("synax-runtime-history-{label}-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()))
    }

    #[test]
    fn immutable_objects_heads_pins_and_gc_are_content_addressed() {
        let path = temp_path("cas");
        let store = HistoryStore::open(&path).unwrap();
        let first = store.command("s", "put-1", "put_object", br#"{"kind":"message","value":{"text":"hello"}}"#).unwrap();
        let first_id = serde_json::from_slice::<serde_json::Value>(&first).unwrap()["objectId"].as_str().unwrap().to_owned();
        let second = store.command("s", "put-2", "put_object", serde_json::to_vec(&serde_json::json!({"kind":"message","value":{"text":"world"},"refs":[first_id]})).unwrap().as_slice()).unwrap();
        let second_id = serde_json::from_slice::<serde_json::Value>(&second).unwrap()["objectId"].as_str().unwrap().to_owned();
        let head = store.command("s", "head", "head_switch", serde_json::to_vec(&serde_json::json!({"objectId":second_id,"expectedRevision":0})).unwrap().as_slice()).unwrap();
        assert_eq!(serde_json::from_slice::<HistoryHead>(&head).unwrap().revision, 1);
        store.command("s", "pin", "pin", serde_json::to_vec(&serde_json::json!({"pinId":"checkpoint","objectId":first_id})).unwrap().as_slice()).unwrap();
        let gc = store.command("s", "gc", "gc", b"{}").unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&gc).unwrap()["deleted"], 0);
        store.command("s", "unpin", "unpin", br#"{"pinId":"checkpoint"}"#).unwrap();
        let gc = store.command("s", "gc-2", "gc", b"{}").unwrap();
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&gc).unwrap()["deleted"], 0, "head still retains both objects");
        drop(store);
        let _ = std::fs::remove_dir_all(path);
    }
}
