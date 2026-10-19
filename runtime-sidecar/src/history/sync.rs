//! Bounded transcript pages and an append-indexed change feed. Pagination
//! survives normal appends; rebuilding the visible head invalidates its generation.
use super::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;

const COLLECTIONS: [(&str, &str); 6] = [
    ("message", "messages"),
    ("run", "runs"),
    ("step", "steps"),
    ("tool", "toolCalls"),
    ("event", "events"),
    ("permission", "permissions"),
];
const SYNC_BYTES: usize = 512 * 1024;
const INLINE_BYTES: usize = 32 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowCursor {
    session_id: String,
    generation: u64,
    after: BTreeMap<String, Option<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(store: &HistoryStore, op: &str, value: Value) -> Value {
        serde_json::from_slice(
            &store
                .command(
                    "s",
                    &uuid::Uuid::new_v4().to_string(),
                    op,
                    &serde_json::to_vec(&value).unwrap(),
                )
                .unwrap(),
        )
        .unwrap()
    }
    fn entity(id: &str, sequence: u64, content: &str) -> Value {
        json!({"kind":"runtime.message","value":{"id":id,"sessionId":"s","sequence":sequence,"content":content}})
    }
    #[test]
    fn sync_pages_and_large_values_are_lossless_and_survive_restart() {
        let dir = std::env::temp_dir().join(format!("synax-sync-{}", uuid::Uuid::new_v4()));
        let store = HistoryStore::open(&dir).unwrap();
        let large = "中文🙂\\\"".repeat(90_000);
        call(
            &store,
            "append_entities",
            json!({"objects":[entity("a",1,"first"),entity("big",2,&large),entity("c",3,"last")]}),
        );
        drop(store);
        let store = HistoryStore::open(&dir).unwrap();
        let mut cursor = Value::Null;
        let mut ids = Vec::new();
        loop {
            let page = call(&store, "history_sync", json!({"cursor":cursor,"limit":1}));
            assert!(serde_json::to_vec(&page).unwrap().len() < SYNC_BYTES);
            for item in page["messages"].as_array().unwrap() {
                ids.push(item["id"].as_str().unwrap().to_owned());
                if let Some(object) = item["$historyObject"].as_str() {
                    let mut text = String::new();
                    let mut offset = 0;
                    loop {
                        let chunk = call(
                            &store,
                            "object_value_chunk",
                            json!({"objectId":object,"offset":offset}),
                        );
                        assert!(serde_json::to_vec(&chunk).unwrap().len() < ENTITY_PAGE_BYTES);
                        text.push_str(chunk["text"].as_str().unwrap());
                        if chunk["next"].is_null() {
                            break;
                        }
                        offset = chunk["next"].as_u64().unwrap();
                    }
                    assert_eq!(
                        serde_json::from_str::<Value>(&text).unwrap()["content"],
                        large
                    );
                }
            }
            cursor = page["historyWindow"]["olderCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        assert_eq!(ids, ["c", "big", "a"]);
        // Execution hydration can also retrieve the same large entity without omission.
        let page = call(&store, "list_messages", json!({"chunked":true}));
        assert_eq!(page["items"].as_array().unwrap().len(), 3);
        assert!(page["items"][1]["$historyObject"].is_string());
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn sync_tracks_updates_deletions_and_recreation_without_replaying_history() {
        let dir = std::env::temp_dir().join(format!("synax-sync-{}", uuid::Uuid::new_v4()));
        let store = HistoryStore::open(&dir).unwrap();
        call(
            &store,
            "append_entities",
            json!({"objects":[entity("a",1,"old"),entity("b",2,"keep")]}),
        );
        let initial = call(&store, "history_sync", json!({"limit":1}));
        let since = initial["historyWindow"]["syncCursor"].clone();
        call(
            &store,
            "append_entities",
            json!({"objects":[entity("a",1,"changed")]}),
        );
        call(
            &store,
            "append_entities",
            json!({"objects":[{"kind":"runtime.tombstone","value":{"id":"b","sessionId":"s","entityKind":"runtime.message"}}]}),
        );
        call(
            &store,
            "append_entities",
            json!({"objects":[entity("c",3,"new")]}),
        );
        let first = call(&store, "history_sync", json!({"since":since,"limit":1}));
        assert_eq!(first["messages"][0]["content"], "changed");
        assert_eq!(first["historyWindow"]["hasMoreChanges"], true);
        let second = call(
            &store,
            "history_sync",
            json!({"since":first["historyWindow"]["syncCursor"],"limit":1}),
        );
        assert_eq!(
            second["removed"],
            json!([{"collection":"messages","id":"b"}])
        );
        let third = call(
            &store,
            "history_sync",
            json!({"since":second["historyWindow"]["syncCursor"],"limit":1}),
        );
        assert_eq!(third["messages"][0]["id"], "c");
        assert_eq!(third["historyWindow"]["hasMoreChanges"], false);
        let unchanged = call(
            &store,
            "history_sync",
            json!({"since":third["historyWindow"]["syncCursor"]}),
        );
        assert!(unchanged["messages"].as_array().unwrap().is_empty());
        let older = call(
            &store,
            "history_sync",
            json!({"cursor":initial["historyWindow"]["olderCursor"]}),
        );
        assert_eq!(older["messages"][0]["content"], "changed");
        call(
            &store,
            "append_entities",
            json!({"objects":[entity("b",2,"recreated")]}),
        );
        let combined = call(&store, "history_sync", json!({"since":since}));
        assert!(combined["removed"].as_array().unwrap().is_empty());
        assert_eq!(combined["messages"].as_array().unwrap().len(), 3);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn sync_cursors_invalidate_on_rollback_and_reject_foreign_scope() {
        let dir = std::env::temp_dir().join(format!("synax-sync-{}", uuid::Uuid::new_v4()));
        let store = HistoryStore::open(&dir).unwrap();
        let root = call(
            &store,
            "append_entities",
            json!({"objects":[entity("a",1,"old"),entity("b",2,"last")]}),
        );
        let page = call(&store, "history_sync", json!({"limit":1}));
        call(
            &store,
            "append_entities",
            json!({"objects":[entity("new",3,"new")]}),
        );
        call(&store, "head_switch", json!({"objectId":root["objectId"]}));
        for field in ["cursor", "since"] {
            let token = &page["historyWindow"][if field == "cursor" {
                "olderCursor"
            } else {
                "syncCursor"
            }];
            let payload = serde_json::to_vec(&json!({field:token})).unwrap();
            assert!(matches!(
                store.command("s", "stale", "history_sync", &payload),
                Err(HistoryError::StaleCursor)
            ));
            assert!(
                store
                    .command("foreign", "scope", "history_sync", &payload)
                    .is_err()
            );
        }
        let next = call(&store, "history_sync", json!({}));
        assert_eq!(next["messages"].as_array().unwrap().len(), 2);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeCursor {
    session_id: String,
    generation: u64,
    after: String,
    until: Option<u64>,
}

fn collection(kind: &str) -> Option<&'static str> {
    COLLECTIONS
        .iter()
        .find(|(key, _)| *key == kind)
        .map(|(_, name)| *name)
}
fn changes_prefix(session: &str) -> String {
    format!("{}changes/", entity_prefix(session))
}
fn boundary(session: &str, revision: u64) -> String {
    format!("{}{revision:020}/~", changes_prefix(session))
}

fn timeline_value(value: &Value) -> Value {
    let mut result = json!({});
    for key in [
        "id",
        "sessionId",
        "runId",
        "stepId",
        "role",
        "sequence",
        "index",
        "status",
        "content",
        "createdAt",
        "updatedAt",
        "startedAt",
        "completedAt",
        "endedAt",
        "stopReason",
        "error",
        "finishReason",
        "toolId",
        "category",
        "mutability",
        "inputSummary",
        "outputSummary",
        "model",
    ] {
        if let Some(item) = value.get(key) {
            result[key] = if matches!(key, "id" | "sessionId" | "runId" | "stepId") {
                item.clone()
            } else if let Some(text) = item.as_str() {
                Value::String(text.chars().take(240).collect())
            } else if !item.is_object() && !item.is_array() {
                item.clone()
            } else {
                Value::Null
            };
        }
    }
    let metadata = value
        .get("metadata")
        .and_then(Value::as_object)
        .map(|metadata| {
            metadata
                .iter()
                .filter(|(key, _)| {
                    matches!(
                        key.as_str(),
                        "source" | "type" | "kind" | "partial" | "forkedFromMessageId"
                    )
                })
                .map(|(key, item)| {
                    (
                        key.clone(),
                        if let Some(text) = item.as_str() {
                            Value::String(text.chars().take(240).collect())
                        } else {
                            item.clone()
                        },
                    )
                })
                .collect::<serde_json::Map<String, Value>>()
        })
        .unwrap_or_default();
    result["metadata"] = Value::Object(metadata);
    result
}

impl HistoryStore {
    pub(super) fn history_generation(&self, session: &str) -> Result<u64, HistoryError> {
        Ok(self
            .get(
                CF_ENTITIES,
                format!("{}generation", entity_prefix(session)).as_bytes(),
            )?
            .map(|bytes| serde_json::from_slice(&bytes))
            .transpose()?
            .unwrap_or(0))
    }
    pub(super) fn set_history_generation(
        &self,
        session: &str,
        generation: u64,
        batch: &mut WriteBatch,
    ) -> Result<(), HistoryError> {
        batch.put_cf(
            self.cf(CF_ENTITIES)?,
            format!("{}generation", entity_prefix(session)),
            serde_json::to_vec(&generation)?,
        );
        Ok(())
    }
    pub(super) fn index_history_change(
        &self,
        session: &str,
        revision: u64,
        offset: usize,
        object: &str,
        kind: &str,
        value: &Value,
        batch: &mut WriteBatch,
    ) -> Result<(), HistoryError> {
        if indexed_kind(kind, value).and_then(collection).is_some() {
            batch.put_cf(
                self.cf(CF_ENTITIES)?,
                format!("{}{revision:020}/{offset:03}", changes_prefix(session)),
                object.as_bytes(),
            );
        }
        Ok(())
    }
    pub(super) fn history_wire_value(
        &self,
        object: &HistoryObject,
        limit: usize,
    ) -> Result<Value, HistoryError> {
        let size = serde_json::to_vec(&object.value)?.len();
        Ok(if size <= limit {
            object.value.clone()
        } else {
            json!({"$historyObject": object.object_id, "bytes": size, "id": object.value["id"]})
        })
    }
    pub(super) fn object_value_chunk(&self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let object: HistoryObject =
            serde_json::from_slice(&self.read_object(required_string(value, "objectId")?)?)?;
        let text = serde_json::to_string(&object.value)?;
        let offset = value["offset"].as_u64().unwrap_or(0) as usize;
        if offset > text.len() || !text.is_char_boundary(offset) {
            return Err(HistoryError::InvalidCommand(
                "invalid object chunk offset".into(),
            ));
        }
        let mut end = (offset + 64 * 1024).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        Ok(serde_json::to_vec(
            &json!({"text": &text[offset..end], "next": if end < text.len() { Some(end) } else { None }}),
        )?)
    }
    pub(super) fn history_sync(
        &self,
        session: &str,
        value: &Value,
    ) -> Result<Vec<u8>, HistoryError> {
        if !value["cursor"].is_null() && !value["since"].is_null() {
            return Err(HistoryError::InvalidCommand(
                "use either history cursor or since".into(),
            ));
        }
        let head = self.read_head(session)?;
        self.require_entity_index(session, &head)?;
        let generation = self.history_generation(session)?;
        let mut result = json!({"messages":[],"runs":[],"steps":[],"toolCalls":[],"events":[],"permissions":[],"removed":[]});
        let mut used = 0;
        let limit = value["limit"].as_u64().unwrap_or(24).clamp(1, 64) as usize;
        if !value["since"].is_null() {
            let cursor: ChangeCursor = serde_json::from_value(value["since"].clone())?;
            let prefix = changes_prefix(session);
            if cursor.session_id != session || !cursor.after.starts_with(&prefix) {
                return Err(HistoryError::InvalidCommand(
                    "history change cursor scope mismatch".into(),
                ));
            }
            if cursor.generation != generation {
                return Err(HistoryError::StaleCursor);
            }
            let until = cursor.until.unwrap_or(head.revision);
            let upper = boundary(session, until);
            if until > head.revision || cursor.after > upper {
                return Err(HistoryError::StaleCursor);
            }
            let mut after = cursor.after.clone();
            let mut count = 0;
            let mut more = false;
            for row in self.db.iterator_cf(
                self.cf(CF_ENTITIES)?,
                rocksdb::IteratorMode::From(after.as_bytes(), rocksdb::Direction::Forward),
            ) {
                let (key, reference) = row?;
                if key.as_ref() > upper.as_bytes() || !key.starts_with(prefix.as_bytes()) {
                    break;
                }
                if key.as_ref() <= cursor.after.as_bytes() {
                    continue;
                }
                if count == limit {
                    more = true;
                    break;
                }
                let object: HistoryObject = serde_json::from_slice(
                    &self.read_object(&String::from_utf8_lossy(&reference))?,
                )?;
                let size = serde_json::to_vec(&object.value)?.len();
                if used > 0 && used + size > SYNC_BYTES {
                    more = true;
                    break;
                }
                let name = indexed_kind(&object.kind, &object.value)
                    .and_then(collection)
                    .ok_or_else(|| HistoryError::InvalidCommand("invalid history change".into()))?;
                let id = &object.value["id"];
                result[name]
                    .as_array_mut()
                    .unwrap()
                    .retain(|item| &item["id"] != id);
                result["removed"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|item| item["collection"] != name || &item["id"] != id);
                if object.kind == "runtime.tombstone" {
                    result["removed"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!({"collection":name,"id":object.value["id"]}));
                } else {
                    result[name]
                        .as_array_mut()
                        .unwrap()
                        .push(self.history_wire_value(&object, INLINE_BYTES)?);
                }
                used += size;
                count += 1;
                after = String::from_utf8_lossy(&key).into_owned();
            }
            // Each identity above retains its final state within this page,
            // including delete followed by recreate.
            let next = ChangeCursor {
                session_id: session.into(),
                generation,
                after: if more { after } else { upper },
                until: more.then_some(until),
            };
            result["historyWindow"] = json!({"revision":until,"epoch":generation,"generation":generation,"syncCursor":next,"hasMoreChanges":more,"hasEarlier":false,"latest":true,"detailsTruncated":false,"incremental":true});
        } else {
            let cursor: Option<WindowCursor> = value
                .get("cursor")
                .filter(|v| !v.is_null())
                .map(|v| serde_json::from_value(v.clone()))
                .transpose()?;
            if let Some(c) = &cursor {
                if c.session_id != session {
                    return Err(HistoryError::InvalidCommand(
                        "history window cursor scope mismatch".into(),
                    ));
                }
                if c.generation != generation {
                    return Err(HistoryError::StaleCursor);
                }
            }
            let mut after = BTreeMap::new();
            for (kind, name) in COLLECTIONS {
                let prefix = format!("{}sort/{kind}/", entity_prefix(session));
                let start = match &cursor {
                    Some(c) => match c.after.get(kind) {
                        Some(Some(key)) if key.starts_with(&prefix) => key.clone(),
                        Some(None) => {
                            after.insert(kind.into(), None);
                            continue;
                        }
                        _ => {
                            return Err(HistoryError::InvalidCommand(
                                "invalid history window cursor".into(),
                            ));
                        }
                    },
                    None => format!("{prefix}~"),
                };
                let mut last = start.clone();
                let mut more = false;
                for row in self.db.iterator_cf(
                    self.cf(CF_ENTITIES)?,
                    rocksdb::IteratorMode::From(start.as_bytes(), rocksdb::Direction::Reverse),
                ) {
                    let (key, reference) = row?;
                    if !key.starts_with(prefix.as_bytes()) {
                        break;
                    }
                    if key.as_ref() == start.as_bytes() {
                        continue;
                    }
                    if result[name].as_array().unwrap().len() == limit || used >= SYNC_BYTES {
                        more = true;
                        break;
                    }
                    let mut object: HistoryObject = serde_json::from_slice(
                        &self.read_object(&String::from_utf8_lossy(&reference))?,
                    )?;
                    if value["preview"].as_bool() == Some(true) {
                        object.value = timeline_value(&object.value);
                    }
                    let size = serde_json::to_vec(&object.value)?.len();
                    if used > 0 && used + size > SYNC_BYTES {
                        more = true;
                        break;
                    }
                    result[name]
                        .as_array_mut()
                        .unwrap()
                        .push(self.history_wire_value(&object, INLINE_BYTES)?);
                    used += size;
                    last = String::from_utf8_lossy(&key).into_owned();
                }
                after.insert(kind.into(), more.then_some(last));
            }
            let has_earlier = after.values().any(Option::is_some);
            let next = WindowCursor {
                session_id: session.into(),
                generation,
                after,
            };
            let sync = ChangeCursor {
                session_id: session.into(),
                generation,
                after: boundary(session, head.revision),
                until: None,
            };
            result["historyWindow"] = json!({"revision":head.revision,"epoch":generation,"generation":generation,"olderCursor":if has_earlier {Some(next)} else {None},"syncCursor":sync,"hasEarlier":has_earlier,"latest":cursor.is_none(),"detailsTruncated":false,"incremental":false});
        }
        Ok(serde_json::to_vec(&result)?)
    }
}
