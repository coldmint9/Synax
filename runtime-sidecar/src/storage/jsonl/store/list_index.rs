//! The root-level sorted view of session summaries for paging.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde_json::Value;

use crate::storage::jsonl::error::JsonlResult;
use crate::storage::jsonl::record::{ListRecord, Record};

/// Sort key: newest update first, then id for a stable tie-break.
pub type ListKey = (std::cmp::Reverse<String>, String);

const PAGE_ITEMS: usize = 64;
const PAGE_BYTES: usize = 900 * 1024;

#[derive(Default)]
pub struct ListIndex {
    rows: BTreeMap<ListKey, Value>,
    by_id: HashMap<String, ListKey>,
}

impl ListIndex {
    /// Rebuild from the index file; the last row per session wins.
    pub fn open(path: &Path) -> JsonlResult<Self> {
        let mut index = Self { rows: BTreeMap::new(), by_id: HashMap::new() };
        crate::storage::jsonl::seglog::visit_complete(path, |_, payload| {
            if let Ok(Record::List(row)) = serde_json::from_slice::<Record>(payload) { index.apply(row); }
            Ok(())
        })?;
        Ok(index)
    }

    fn apply(&mut self, mut row: ListRecord) {
        // Control probes can open an unseeded session. It has no list row yet.
        if !row.del && !row.h.is_object() { return; }
        if let Some(metadata) = row.h.get_mut("sessionMetadata").and_then(Value::as_object_mut) { metadata.remove("latestSystemPrompt"); }
        if let Some(previous) = self.by_id.remove(&row.s) {
            self.rows.remove(&previous);
        }
        if !row.del {
            let key = (std::cmp::Reverse(row.u.clone()), row.s.clone());
            self.by_id.insert(row.s, key.clone());
            self.rows.insert(key, row.h);
        }
    }

    pub fn upsert(&mut self, row: ListRecord) {
        self.apply(row);
    }

    /// A background cache read must never replace a row already published by
    /// an interactive session open or mutation.
    pub fn insert_cached(&mut self, row: ListRecord) {
        if !self.by_id.contains_key(&row.s) { self.apply(row); }
    }

    pub fn clear(&mut self) {
        self.rows.clear();
        self.by_id.clear();
    }

    /// One page after `after`, as `(rows, next cursor)`.
    pub fn page(&self, after: Option<&ListKey>, limit: usize) -> (Vec<Value>, Option<ListKey>) {
        let limit = limit.clamp(1, PAGE_ITEMS);
        let mut items = Vec::new();
        let mut bytes = 2048usize;
        let mut next = None;
        let start = after.map_or(std::ops::Bound::Unbounded, std::ops::Bound::Excluded);
        for (key, row) in self.rows.range((start, std::ops::Bound::Unbounded)) {
            let cost = serde_json::to_vec(row).map(|bytes| bytes.len()).unwrap_or(0) + 1;
            if items.len() == limit || bytes + cost > PAGE_BYTES {
                return (items, next);
            }
            bytes += cost;
            next = Some(key.clone());
            items.push(row.clone());
        }
        let more = self.rows.keys().next_back().is_some_and(|last| next.as_ref().is_some_and(|next| next != last));
        (items, if more { next } else { None })
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.by_id.get(id).and_then(|key| self.rows.get(key)).cloned()
    }

    /// The cursor encoding the wire uses: JSON of the last returned key.
    pub fn encode_cursor(key: &ListKey) -> String {
        serde_json::to_string(key).unwrap_or_default()
    }

    pub fn decode_cursor(cursor: &str) -> Option<ListKey> {
        serde_json::from_str::<ListKey>(cursor).ok()
    }
}
