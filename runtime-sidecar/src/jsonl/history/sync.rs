//! Bounded transcript windows and an append-indexed change feed. Pagination
//! survives normal appends; rebuilding the visible head invalidates it.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::json::{array, boolean, convert_value, number, object, text};
use super::wire::HistoryError;
use super::{indexed_kind, SessionIndex};

const SYNC_BYTES: usize = 512 * 1024;
const INLINE_BYTES: usize = 32 * 1024;

/// Pagination collections, in the order they appear in a sync reply.
const COLLECTIONS: [(&str, &str); 6] = [
    ("message", "messages"),
    ("run", "runs"),
    ("step", "steps"),
    ("tool", "toolCalls"),
    ("event", "events"),
    ("permission", "permissions"),
];

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowCursor {
    session_id: String,
    generation: u64,
    after: BTreeMap<String, Option<String>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangeCursor {
    session_id: String,
    generation: u64,
    after: String,
    until: Option<u64>,
}

/// True when a cursor was minted for another session.
fn foreign_session(cursor_session: &str, session: &str) -> bool {
    cursor_session.ne(session)
}

/// True when the visible index was rebuilt since the cursor was minted.
fn stop_generation(cursor_generation: u64, generation: u64) -> bool {
    cursor_generation.ne(&generation)
}

fn collection(kind: &str) -> Option<&'static str> {
    COLLECTIONS
        .iter()
        .find(|(key, _)| *key == kind)
        .map(|(_, name)| *name)
}

fn changes_prefix(session: &str) -> String {
    format!("changes\0{session}\0")
}

fn boundary(session: &str, revision: u64) -> String {
    format!("{}{revision:020}/~", changes_prefix(session))
}

/// Replace a value with `$historyObject` when it is larger than `limit`;
/// `history_sync` omits `bytes` and `list_*` carries it.
fn wire_value(value: &serde_json::Value, id: &str, limit: usize, bytes: bool) -> serde_json::Value {
    let size = serde_json::to_vec(value).map(|bytes| bytes.len()).unwrap_or(0);
    if size <= limit {
        return value.clone();
    }
    let mut marker = object(&[("$historyObject", text(id)), ("id", value["id"].clone())]);
    if bytes {
        marker["bytes"] = number(size as u64);
    }
    marker
}


fn invalid(message: &str) -> HistoryError {
    HistoryError::InvalidCommand(message.into())
}

/// The initial window: the newest `limit` entities of every collection,
/// walking each collection backwards from its end.
fn window_page(
    index: &SessionIndex,
    session: &str,
    value: &serde_json::Value,
    result: &mut serde_json::Value,
    used: &mut usize,
    limit: usize,
    generation: u64,
    head_revision: u64,
) -> Result<(), HistoryError> {
    let cursor: Option<WindowCursor> = value
        .get("cursor")
        .filter(|v| !v.is_null())
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .map_err(|error| invalid(&format!("serialization: {error}")))?;
    if let Some(cursor) = &cursor {
        if foreign_session(&cursor.session_id, session) {
            return Err(invalid("history window cursor scope mismatch"));
        }
    if cursor.generation.ne(&generation) {
            return Err(HistoryError::StaleCursor);
        }
    }
    let mut after = BTreeMap::new();
    for (kind, name) in COLLECTIONS {
        let prefix = format!("{kind}\0");
        let start = match &cursor {
            Some(cursor) => match cursor.after.get(kind) {
                Some(Some(key)) if key.starts_with(&prefix) => Some(key.clone()),
                Some(None) => {
                    after.insert(kind.into(), None);
                    continue;
                }
                _ => return Err(invalid("invalid history window cursor")),
            },
            None => None,
        };
        let mut last: Option<String> = None;
        let mut count = 0usize;
        let mut more = false;
        let mut candidates: Vec<(String, serde_json::Value, String)> = index
            .entity_keys(kind)
            .filter(|(key, _)| start.as_ref().is_none_or(|start| *key > start))
            .map(|(key, object)| (key.clone(), object.value.clone(), object.object_id.clone()))
            .collect();
        candidates.reverse();
        for (key, entity, object_id) in candidates {
            if count == limit || *used >= SYNC_BYTES {
                more = true;
                break;
            }
            let size = serde_json::to_vec(&entity).map(|bytes| bytes.len()).unwrap_or(0);
            if *used > 0 && *used + size > SYNC_BYTES {
                more = true;
                break;
            }
            result[name]
                .as_array_mut()
                .expect("arrays")
                .push(wire_value(&entity, &object_id, INLINE_BYTES, false));
            *used += size;
            count += 1;
            last = Some(key);
        }
        after.insert(kind.into(), more.then_some(last).flatten());
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
        after: boundary(session, head_revision),
        until: None,
    };
    let older = if has_earlier {
        convert_value(next)?
    } else {
        serde_json::Value::Null
    };
    let window = object(&[
        ("revision", number(head_revision)),
        ("epoch", number(generation)),
        ("generation", number(generation)),
        ("olderCursor", older),
        ("syncCursor", convert_value(sync)?),
        ("hasEarlier", boolean(has_earlier)),
        ("latest", boolean(cursor.is_none())),
        ("detailsTruncated", boolean(false)),
        ("incremental", boolean(false)),
    ]);
    result["historyWindow"] = window;
    Ok(())
}

/// Changes after the `since` watermark, folded per identity.
fn change_page(
    index: &SessionIndex,
    session: &str,
    value: &serde_json::Value,
    result: &mut serde_json::Value,
    used: &mut usize,
    limit: usize,
    generation: u64,
    head_revision: u64,
) -> Result<(), HistoryError> {
    let cursor: ChangeCursor = serde_json::from_value(value["since"].clone())
        .map_err(|error| invalid(&format!("serialization: {error}")))?;
    if foreign_session(&cursor.session_id, session) {
        return Err(invalid("history change cursor scope mismatch"));
    }
    if cursor.generation.ne(&generation) {
        return Err(HistoryError::StaleCursor);
    }
    let until = cursor.until.unwrap_or(head_revision);
    let upper = boundary(session, until);
    if until > head_revision || cursor.after > upper {
        return Err(HistoryError::StaleCursor);
    }
    eprintln!("DBG62 {:?} upper={:?} after={:?}", index.changes.keys().collect::<Vec<_>>(), upper, cursor.after);
    let mut after = cursor.after.clone();
    let mut count = 0;
    let mut more = false;
    let changes: Vec<_> = index
        .changes
        .iter()
        .map(|((revision, offset), change)| {
            (
                format!("{}{revision:020}{offset:03}", changes_prefix(session)),
                change.clone(),
            )
        })
        .collect();
    for (key, change) in changes {
        if key.as_str() > upper.as_str() {
            break;
        }
        if key.as_str() <= cursor.after.as_str() {
            continue;
        }
        if count == limit {
            more = true;
            break;
        }
        let Some(entity) = index.objects.get(&change.object_id) else {
            continue;
        };
        let size = serde_json::to_vec(&entity.value)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        if *used > 0 && *used + size > SYNC_BYTES {
            more = true;
            break;
        }
        let name = indexed_kind(&entity.kind, &entity.value)
            .and_then(collection)
            .ok_or_else(|| invalid("invalid history change"))?;
        let id = entity.value["id"].clone();
        let collection_value = text(name);
        result[name]
            .as_array_mut()
            .expect("arrays")
            .retain(|item| item["id"] != id);
        result["removed"]
            .as_array_mut()
            .expect("arrays")
            .retain(|item| item["collection"] != collection_value || item["id"] != id);
        if entity.kind == "runtime.tombstone" {
            result["removed"].as_array_mut().expect("arrays").push(object(&[
                ("collection", collection_value),
                ("id", id),
            ]));
        } else {
            result[name].as_array_mut().expect("arrays").push(wire_value(
                &entity.value,
                &entity.object_id,
                INLINE_BYTES,
                false,
            ));
        }
        *used += size;
        count += 1;
        after = key;
    }
    // Each identity above retains its final state within this page,
    // including delete followed by recreate.
    let next = ChangeCursor {
        session_id: session.into(),
        generation,
        after: if more { after } else { upper },
        until: more.then_some(until),
    };
    let window = object(&[
        ("revision", number(until)),
        ("epoch", number(generation)),
        ("generation", number(generation)),
        ("syncCursor", convert_value(next)?),
        ("hasMoreChanges", boolean(more)),
        ("hasEarlier", boolean(false)),
        ("latest", boolean(true)),
        ("detailsTruncated", boolean(false)),
        ("incremental", boolean(true)),
    ]);
    result["historyWindow"] = window;
    Ok(())
}

pub fn history_sync(
    index: &SessionIndex,
    session: &str,
    value: &serde_json::Value,
) -> Result<serde_json::Value, HistoryError> {
    if !value["cursor"].is_null() && !value["since"].is_null() {
        return Err(invalid("use either history cursor or since"));
    }
    let head = index.head.clone();
    if head.object_id.is_some() && index.index_root.ne(&head.object_id) {
        return Err(invalid(
            "current history index is missing; rebuild_index required",
        ));
    }
    let generation = index.index_generation;
    let active_revision = index.current_head_revision;
    let mut result = object(&[]);
    for (_, name) in COLLECTIONS {
        result[name] = array(Vec::new());
    }
    result["removed"] = array(Vec::new());
    let mut used = 0usize;
    let limit = value["limit"].as_u64().unwrap_or(24).clamp(1, 64) as usize;
    if !value["since"].is_null() {
        change_page(
            index,
            session,
            value,
            &mut result,
            &mut used,
            limit,
            generation,
            active_revision,
        )?;
    } else {
        window_page(
            index,
            session,
            value,
            &mut result,
            &mut used,
            limit,
            generation,
            active_revision,
        )?;
    }
    Ok(result)
}
