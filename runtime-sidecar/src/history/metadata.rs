//! Mutable business records. All writes are bounded, compare revisions, and
//! share the history store's WAL-synced batch and idempotency receipt.
use super::{HistoryError, HistoryStore, CF_METADATA, encode_hex, required_string};
use rocksdb::{Direction, IteratorMode, WriteBatch};
use serde_json::{Value, json};
use std::collections::HashSet;

const MAX_RECORD_BYTES: usize = 512 * 1024;
const MAX_PAGE_BYTES: usize = 768 * 1024;
fn prefix(scope: &str) -> Result<String, HistoryError> {
    if !scope.starts_with("metadata:") || scope.len() > 256 {
        return Err(HistoryError::InvalidCommand("invalid metadata scope".into()));
    }
    Ok(format!("m/{}/", encode_hex(scope.as_bytes())))
}
fn invalid(message: &str) -> HistoryError { HistoryError::InvalidCommand(message.into()) }
impl HistoryStore {
    pub(super) fn metadata_get(&self, scope: &str, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let key = required_string(value, "key")?;
        let record = self.metadata_record(&prefix(scope)?, key)?;
        Ok(serde_json::to_vec(&record)?)
    }
    fn metadata_record(&self, prefix: &str, key: &str) -> Result<Value, HistoryError> {
        if key.is_empty() || key.len() > 1024 { return Err(invalid("invalid metadata key")); }
        match self.get(CF_METADATA, format!("{prefix}r/{}", encode_hex(key.as_bytes())).as_bytes())? {
            Some(bytes) => Ok(serde_json::from_slice(&bytes)?),
            None => Ok(json!({"key": key, "revision": 0, "value": null})),
        }
    }
    fn metadata_revision(&self, prefix: &str) -> Result<u64, HistoryError> {
        Ok(self.get(CF_METADATA, format!("{prefix}revision").as_bytes())?
            .map(|b| serde_json::from_slice(&b)).transpose()?.unwrap_or(0))
    }
    pub(super) fn metadata_page(&self, scope: &str, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let prefix = prefix(scope)?;
        let revision = self.metadata_revision(&prefix)?;
        if let Some(expected) = value["revision"].as_u64() {
            if expected != revision { return Err(HistoryError::RevisionConflict { expected, actual: revision }); }
        }
        let records = format!("{prefix}r/");
        let after = value["after"].as_str().unwrap_or("");
        let start = format!("{records}{}", encode_hex(after.as_bytes()));
        let limit = value["limit"].as_u64().unwrap_or(128).clamp(1, 256) as usize;
        let mut items = Vec::new(); let mut size = 4096; let mut cursor = None; let mut more = false;
        for row in self.db.iterator_cf(self.cf(CF_METADATA)?, IteratorMode::From(start.as_bytes(), Direction::Forward)) {
            let (key, bytes) = row?;
            if !key.starts_with(records.as_bytes()) { break; }
            if !after.is_empty() && key.as_ref() <= start.as_bytes() { continue; }
            if items.len() == limit || size + bytes.len() > MAX_PAGE_BYTES { more = true; break; }
            let item: Value = serde_json::from_slice(&bytes)?;
            cursor = Some(required_string(&item, "key")?.to_owned());
            size += bytes.len(); items.push(item);
        }
        Ok(serde_json::to_vec(&json!({"items":items, "revision":revision, "after": if more { cursor } else { None }}))?)
    }
    pub(super) fn metadata_commit(&self, scope: &str, value: &Value, batch: &mut WriteBatch) -> Result<Vec<u8>, HistoryError> {
        let prefix = prefix(scope)?;
        let writes = value["writes"].as_array().filter(|w| !w.is_empty() && w.len() <= 128)
            .ok_or_else(|| invalid("metadata commit requires 1..128 writes"))?;
        let mut seen = HashSet::new(); let mut items = Vec::new();
        for write in writes {
            let key = required_string(write, "key")?;
            if !seen.insert(key) { return Err(invalid("duplicate metadata key in batch")); }
            let before = self.metadata_record(&prefix, key)?;
            let actual = before["revision"].as_u64().unwrap_or(0);
            let expected = write["revision"].as_u64().ok_or_else(|| invalid("expected metadata revision is required"))?;
            if expected != actual { return Err(HistoryError::RevisionConflict { expected, actual }); }
            let content = write.get("value").ok_or_else(|| invalid("metadata value is required"))?;
            let revision = actual.checked_add(1).ok_or_else(|| invalid("metadata revision overflow"))?;
            let record = json!({"key":key,"revision":revision,"value":content});
            let bytes = serde_json::to_vec(&record)?;
            if bytes.len() > MAX_RECORD_BYTES { return Err(invalid("metadata record exceeds byte budget")); }
            batch.put_cf(self.cf(CF_METADATA)?, format!("{prefix}r/{}", encode_hex(key.as_bytes())).as_bytes(), bytes);
            // Tombstones retain revisions so deleted records cannot be revived by stale writers.
            items.push(record);
        }
        let revision = self.metadata_revision(&prefix)?.checked_add(1).ok_or_else(|| invalid("metadata revision overflow"))?;
        batch.put_cf(self.cf(CF_METADATA)?, format!("{prefix}revision").as_bytes(), serde_json::to_vec(&revision)?);
        Ok(serde_json::to_vec(&json!({"items":items,"revision":revision}))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(store:&HistoryStore,scope:&str,id:&str,op:&str,payload:Value)->Result<Value,HistoryError>{
        serde_json::from_slice(&store.command(scope,id,op,&serde_json::to_vec(&payload)?)?).map_err(Into::into)
    }
    #[test]
    fn business_records_survive_restart_and_queries_never_replay_old_receipts(){
        let dir=std::env::temp_dir().join(format!("synax-metadata-{}",uuid::Uuid::new_v4()));
        {
            let store=HistoryStore::open(&dir).unwrap();
            call(&store,"metadata:memories","write","metadata_commit",json!({"writes":[{"key":"m","revision":0,"value":{"content":"first"}}]})).unwrap();
            assert_eq!(call(&store,"metadata:memories","read","metadata_get",json!({"key":"m"})).unwrap()["value"]["content"],"first");
            call(&store,"metadata:memories","update","metadata_commit",json!({"writes":[{"key":"m","revision":1,"value":{"content":"second"}}]})).unwrap();
            assert_eq!(call(&store,"metadata:memories","read","metadata_get",json!({"key":"m"})).unwrap()["value"]["content"],"second");
        }
        {
            let store=HistoryStore::open(&dir).unwrap();
            assert_eq!(call(&store,"metadata:memories","read","metadata_get",json!({"key":"m"})).unwrap()["revision"],2);
            assert_eq!(call(&store,"metadata:tool-grants","read","metadata_get",json!({"key":"m"})).unwrap()["value"],Value::Null);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn stale_batch_is_atomic_and_deletion_cannot_be_undone_by_stale_writers(){
        let dir=std::env::temp_dir().join(format!("synax-metadata-{}",uuid::Uuid::new_v4()));
        {
            let store=HistoryStore::open(&dir).unwrap();
            let batch=json!({"writes":[{"key":"grant","revision":0,"value":{"enabled":true}}]});
            let first=call(&store,"metadata:tool-grants","create","metadata_commit",batch.clone()).unwrap();
            assert_eq!(call(&store,"metadata:tool-grants","create","metadata_commit",batch).unwrap(),first);
            assert!(call(&store,"metadata:tool-grants","stale","metadata_commit",json!({"writes":[{"key":"other","revision":0,"value":1},{"key":"grant","revision":0,"value":2}]})).is_err());
            assert_eq!(call(&store,"metadata:tool-grants","read","metadata_get",json!({"key":"other"})).unwrap()["value"],Value::Null);
            call(&store,"metadata:tool-grants","delete","metadata_commit",json!({"writes":[{"key":"grant","revision":1,"value":null}]})).unwrap();
            assert!(call(&store,"metadata:tool-grants","revive","metadata_commit",json!({"writes":[{"key":"grant","revision":1,"value":{"enabled":true}}]})).is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn pages_are_bounded_and_detect_concurrent_updates(){
        let dir=std::env::temp_dir().join(format!("synax-metadata-{}",uuid::Uuid::new_v4()));
        {
            let store=HistoryStore::open(&dir).unwrap();
            for i in 0..4 {call(&store,"metadata:memories",&format!("put{i}"),"metadata_commit",json!({"writes":[{"key":format!("k{i}"),"revision":0,"value":"x".repeat(300000)}]})).unwrap();}
            let first=call(&store,"metadata:memories","page","metadata_page",json!({})).unwrap();
            assert_eq!(first["items"].as_array().unwrap().len(),2);
            let second=call(&store,"metadata:memories","page","metadata_page",json!({"after":first["after"],"revision":first["revision"]})).unwrap();
            assert_eq!(second["items"].as_array().unwrap().len(),2);
            assert!(second["after"].is_null());
            call(&store,"metadata:memories","next","metadata_commit",json!({"writes":[{"key":"k4","revision":0,"value":"new"}]})).unwrap();
            assert!(call(&store,"metadata:memories","page","metadata_page",json!({"after":first["after"],"revision":first["revision"]})).is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
