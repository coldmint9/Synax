//! Mutable business records. All writes are bounded, compare revisions, and
//! commit through the history file's receipt fence.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::wire::HistoryError;
use super::{encode_hex, required_string};

const MAX_RECORD_BYTES: usize = 512 * 1024;
const MAX_PAGE_BYTES: usize = 768 * 1024;
/// A scope segment holds at most this many commits; only the newest segment
/// is ever rewritten by compaction.
const SEGMENT_RECORDS: u64 = 512;

/// One scope's records live in `<dir>/<hex(scope)>/<segment>.seg`, as
/// length-framed `{"key","revision","value"}` records. Each commit ends with
/// a `{"meta":revision}` marker, so a torn tail never raises the revision.
pub struct MetadataStore {
    dir: PathBuf,
    scope: String,
    revision: u64,
    records: BTreeMap<String, Value>,
}

impl MetadataStore {
    /// Open the store for `scope`. `reported` is the revision the history
    /// fence durably committed; records newer than it (a commit whose receipt
    /// never landed) are not visible.
    pub fn open(dir: &Path, scope: &str, reported: u64) -> Result<Self, HistoryError> {
        let dir = dir.join(encode_hex(scope.as_bytes()));
        let mut store = Self {
            dir,
            scope: scope.to_owned(),
            revision: reported,
            records: BTreeMap::new(),
        };
        store.load()?;
        Ok(store)
    }

    fn load(&mut self) -> Result<(), HistoryError> {
        let mut names = std::fs::read_dir(&self.dir)
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok())
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .filter(|name| name.ends_with(".seg"))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        names.sort();
        // Each commit appends its records followed by a marker frame. A torn
        // tail therefore drops the incomplete commit together with its marker.
        let mut committed: Option<u64> = None;
        for name in names {
            let bytes = std::fs::read(self.dir.join(&name))
                .map_err(|error| HistoryError::FileIo(error.to_string()))?;
            let mut pending = Vec::<Value>::new();
            for frame in frames(&bytes) {
                let Ok(record) = serde_json::from_slice::<Value>(frame) else {
                    continue;
                };
                if let Some(revision) = record.get("meta").and_then(Value::as_u64) {
                    committed = Some(revision);
                    for record in pending.drain(..) {
                        self.records.insert(record["key"].as_str().unwrap_or_default().to_owned(), record);
                    }
                    continue;
                }
                pending.push(record);
            }
        }
        // The fence is the durable truth: a commit whose receipt never landed
        // is not visible even though its marker reached the segment.
        let committed = committed.unwrap_or(self.revision).min(self.revision);
        self.revision = committed;
        Ok(())
    }

    fn record(&self, key: &str) -> Result<Value, HistoryError> {
        if key.is_empty() || key.len() > 1024 {
            return Err(invalid("invalid metadata key"));
        }
        Ok(self
            .records
            .get(key)
            .cloned()
            .unwrap_or_else(|| json!({"key": key, "revision": 0, "value": null})))
    }

    pub fn get(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let key = required_string(value, "key")?;
        serialized(&self.record(key)?)
    }

    pub fn page(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let revision = self.revision;
        if let Some(expected) = value["revision"].as_u64() {
            if expected != revision {
                return Err(HistoryError::RevisionConflict {
                    expected,
                    actual: revision,
                });
            }
        }
        let after = value["after"].as_str().unwrap_or("");
        let limit = value["limit"].as_u64().unwrap_or(128).clamp(1, 256) as usize;
        let mut items = Vec::new();
        let mut size = 4096;
        let mut cursor: Option<String> = None;
        let mut more = false;
        for (key, record) in self.records.range(after.to_owned()..) {
            if !after.is_empty() && key.as_str() <= after {
                continue;
            }
            let bytes = serde_json::to_vec(record).map(|bytes| bytes.len()).unwrap_or(0);
            if items.len() == limit || size + bytes > MAX_PAGE_BYTES {
                more = true;
                break;
            }
            cursor = Some(key.clone());
            size += bytes;
            items.push(record.clone());
        }
        serialized(&json!({
            "items": items,
            "revision": revision,
            "after": if more { cursor } else { None }
        }))
    }

    /// Commit one batch atomically. Returns `(reply, scope, revision)`.
    pub fn commit(
        &mut self,
        value: &Value,
    ) -> Result<(Vec<u8>, Option<String>, Option<u64>), HistoryError> {
        let writes = value["writes"]
            .as_array()
            .filter(|writes| !writes.is_empty() && writes.len() <= 128)
            .ok_or_else(|| invalid("metadata commit requires 1..=128 writes"))?;
        let mut seen = HashSet::new();
        let mut records = Vec::new();
        for write in writes {
            let key = required_string(write, "key")?;
            if !seen.insert(key) {
                return Err(invalid("duplicate metadata key in batch"));
            }
            let before = self.record(key)?;
            let actual = before["revision"].as_u64().unwrap_or(0);
            let expected = write["revision"]
                .as_u64()
                .ok_or_else(|| invalid("expected metadata revision is required"))?;
            if expected != actual {
                return Err(HistoryError::RevisionConflict { expected, actual });
            }
            let content = write
                .get("value")
                .ok_or_else(|| invalid("metadata value is required"))?;
            let revision = actual
                .checked_add(1)
                .ok_or_else(|| invalid("metadata revision overflow"))?;
            let record = json!({"key":key,"revision":revision,"value":content});
            let bytes = serialized(&record)?;
            if bytes.len() > MAX_RECORD_BYTES {
                return Err(invalid("metadata record exceeds byte budget"));
            }
            records.push(bytes);
        }
        let revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| invalid("metadata revision overflow"))?;
        // The commit marker is the last frame: readers never see a batch
        // whose marker is missing.
        records.push(serialized(&json!({"meta":revision}))?);
        let segment = revision / SEGMENT_RECORDS;
        append_frames(&self.dir.join(segment_name(segment)), &records)?;        let mut items = Vec::new();
        let committed = records.len() - 1;
        for bytes in records.iter().take(committed) {
            if let Ok(record) = serde_json::from_slice::<Value>(bytes) {
                if let Some(key) = record["key"].as_str() {
                    self.records.insert(key.to_owned(), record.clone());
                }
                items.push(record);
            }
        }
        self.revision = revision;
        self.maybe_compact(segment);
        let reply = serialized(&json!({"items":items,"revision":revision}))?;
        Ok((reply, Some(self.scope.clone()), Some(revision)))
    }

    /// Fold every fully superseded segment into its final state. Only called
    /// under the session writer lock, so every writer already observed the
    /// entries this drops.
    fn maybe_compact(&mut self, segment: u64) {
        if segment <= 1 {
            return;
        }
        let older: Vec<PathBuf> = std::iter::repeat_with(|| 0u64)
            .zip(0..segment - 1)
            .map(|(_, index)| self.dir.join(segment_name(index)))
            .filter(|path| path.exists())
            .collect();
        if older.is_empty() {
            return;
        }
        let mut live = BTreeMap::new();
        for (key, record) in &self.records {
            let revision = record["revision"].as_u64().unwrap_or(0);
            if revision / SEGMENT_RECORDS < segment {
                live.insert(key.clone(), record.clone());
            }
        }
        let mut records = Vec::new();
        for record in live.into_values() {
            match serialized(&record) {
                Ok(bytes) => records.push(bytes),
                Err(_) => return,
            }
        }
        if write_atomic(&self.dir.join(segment_name(segment)), &records).is_err() {
            return;
        }
        for old in older {
            let _ = std::fs::remove_file(old);
        }
    }
}

fn invalid(message: &str) -> HistoryError {
    HistoryError::InvalidCommand(message.into())
}

fn serialized<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, HistoryError> {
    serde_json::to_vec(value).map_err(|error| invalid(&format!("serialization: {error}")))
}

fn segment_name(segment: u64) -> String {
    format!("{segment:06}.seg")
}

/// Length-framed payloads of a segment; a torn tail is ignored.
fn frames(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut offset = 0usize;
    std::iter::from_fn(move || {
        if offset + 4 > bytes.len() {
            return None;
        }
        let length = u32::from_le_bytes(bytes[offset..offset + 4].try_into().ok()?) as usize;
        let start = offset + 4;
        if start + length > bytes.len() {
            return None;
        }
        offset = start + length;
        Some(&bytes[start..start + length])
    })
}

fn frame_all(records: &[Vec<u8>]) -> Vec<u8> {
    let mut buf = Vec::new();
    for record in records {
        buf.extend_from_slice(&(record.len() as u32).to_le_bytes());
        buf.extend_from_slice(record);
    }
    buf
}

fn append_frames(path: &Path, records: &[Vec<u8>]) -> Result<(), HistoryError> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| HistoryError::FileIo(error.to_string()))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| HistoryError::FileIo(error.to_string()))?;
    file.write_all(&frame_all(records)).map_err(|error| HistoryError::FileIo(error.to_string()))?;
    file.sync_data().map_err(|error| HistoryError::FileIo(error.to_string()))?;
    Ok(())
}

fn write_atomic(path: &Path, records: &[Vec<u8>]) -> std::io::Result<()> {
    use std::io::Write;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(&frame_all(records))?;
    file.sync_data()?;
    drop(file);
    std::fs::rename(&temp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("synax-meta-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn torn_tail_never_raises_the_revision() {
        let dir = temp_dir();
        let mut store = MetadataStore::open(&dir, "metadata:memories", 0).unwrap();
        store
            .commit(&json!({"writes":[{"key":"m","revision":0,"value":{"content":"first"}}]}))
            .unwrap();
        let segment = store.dir.join(segment_name(0));
        let mut bytes = std::fs::read(&segment).unwrap();
        bytes.truncate(bytes.len() - 3);
        std::fs::write(&segment, &bytes).unwrap();
        let mut reopened = MetadataStore::open(&dir, "metadata:memories", 0).unwrap();
        assert_eq!(reopened.revision, 0);
        assert_eq!(
            serde_json::from_slice::<Value>(&reopened.get(&json!({"key":"m"})).unwrap())
                .unwrap()["value"],
            Value::Null
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn scopes_are_isolated_and_revisions_are_remembered() {
        let dir = temp_dir();
        let mut mine = MetadataStore::open(&dir, "metadata:memories", 0).unwrap();
        mine.commit(&json!({"writes":[{"key":"m","revision":0,"value":1}]}))
            .unwrap();
        let mut other = MetadataStore::open(&dir, "metadata:tool-grants", 0).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&other.get(&json!({"key":"m"})).unwrap()).unwrap()
                ["value"],
            Value::Null
        );
        let mut reopened = MetadataStore::open(&dir, "metadata:memories", 1).unwrap();
        let page: Value = serde_json::from_slice(&reopened.page(&json!({})).unwrap()).unwrap();
        assert_eq!(page["revision"], 1);
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
