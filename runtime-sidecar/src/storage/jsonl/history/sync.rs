//! Bounded transcript windows and an append-indexed change feed.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::json::{array, boolean, convert_value, number, object, text};
use super::wire::HistoryError;
use super::{SessionIndex, indexed_kind};

const SYNC_BYTES: usize = 512 * 1024;
const INLINE_BYTES: usize = 32 * 1024;
const WINDOW_COLLECTION_BYTES: usize = (SYNC_BYTES - 4096) / COLLECTIONS.len();

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

fn invalid(message: &str) -> HistoryError {
    HistoryError::InvalidCommand(message.into())
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

fn change_key(session: &str, revision: u64, offset: usize) -> String {
    format!("{}{revision:020}/{offset:03}", changes_prefix(session))
}

fn boundary(session: &str, revision: u64) -> String {
    format!("{}{revision:020}/~", changes_prefix(session))
}

fn foreign_session(cursor_session: &str, session: &str) -> bool {
    cursor_session != session
}

fn wire_value(value: &serde_json::Value, id: &str, limit: usize) -> serde_json::Value {
    let size = serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(0);
    if size <= limit {
        return value.clone();
    }
    object(&[
        ("$historyObject", text(id)),
        ("bytes", number(size as u64)),
        ("id", value["id"].clone()),
    ])
}

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
        if cursor.generation != generation {
            return Err(HistoryError::StaleCursor);
        }
    }

    let mut after = BTreeMap::new();
    for (kind, name) in COLLECTIONS {
        let start = cursor
            .as_ref()
            .and_then(|cursor| cursor.after.get(kind).cloned())
            .flatten();
        if cursor.is_some() && start.is_none() {
            after.insert(kind.into(), None);
            continue;
        }
        if start
            .as_ref()
            .is_some_and(|key| !key.starts_with(&format!("{kind}\0")))
        {
            return Err(invalid("history window cursor collection mismatch"));
        }
        let candidates = index.entity_keys_before(kind, start.as_deref());

        let mut last = None;
        let mut more = false;
        let mut collection_bytes = 0;
        for (key, entity) in candidates {
            let current_count = result[name].as_array().map_or(0, Vec::len);
            if current_count >= limit {
                more = true;
                break;
            }
            let item = wire_value(&entity.value, &entity.object_id, INLINE_BYTES);
            let size = serde_json::to_vec(&item)
                .map(|bytes| bytes.len())
                .unwrap_or(0)
                + 1;
            // Budget the reference sent on the wire, not its hydrated body.
            // Give each collection space so a long prompt cannot hide runs/tools.
            if collection_bytes + size > WINDOW_COLLECTION_BYTES {
                more = true;
                break;
            }
            result[name].as_array_mut().expect("arrays").push(item);
            *used += size;
            collection_bytes += size;
            last = Some(key.clone());
        }
        after.insert(kind.into(), more.then_some(last).flatten());
    }

    let has_earlier = after.values().any(Option::is_some);
    let older = if has_earlier {
        convert_value(WindowCursor {
            session_id: session.into(),
            generation,
            after,
        })?
    } else {
        serde_json::Value::Null
    };
    result["historyWindow"] = object(&[
        ("revision", number(head_revision)),
        ("epoch", number(generation)),
        ("generation", number(generation)),
        ("olderCursor", older),
        (
            "syncCursor",
            convert_value(ChangeCursor {
                session_id: session.into(),
                generation,
                after: boundary(session, head_revision),
                until: None,
            })?,
        ),
        ("hasEarlier", boolean(has_earlier)),
        ("latest", boolean(cursor.is_none())),
        ("detailsTruncated", boolean(false)),
        ("incremental", boolean(false)),
    ]);
    Ok(())
}

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
    if foreign_session(&cursor.session_id, session) || cursor.generation != generation {
        return Err(HistoryError::StaleCursor);
    }
    let until = cursor.until.unwrap_or(head_revision);
    if until > head_revision {
        return Err(HistoryError::StaleCursor);
    }

    let upper = boundary(session, until);
    if !cursor.after.starts_with(&changes_prefix(session)) || cursor.after > upper {
        return Err(HistoryError::StaleCursor);
    }
    let mut last = cursor.after.clone();
    let mut count = 0usize;
    let mut more = false;
    let position = cursor
        .after
        .strip_prefix(&changes_prefix(session))
        .and_then(|value| value.split_once('/'))
        .and_then(|(revision, offset)| {
            Some((
                revision.parse::<u64>().ok()?,
                if offset == "~" {
                    usize::MAX
                } else {
                    offset.parse::<usize>().ok()?
                },
            ))
        })
        .ok_or_else(|| invalid("history change cursor position is invalid"))?;
    use std::ops::Bound::{Excluded, Included};
    for ((revision, offset), change) in index
        .changes
        .range((Excluded(position), Included((until, usize::MAX))))
    {
        let key = change_key(session, *revision, *offset);
        let Some(entity) = index.objects.get(&change.object_id) else {
            continue;
        };
        let Some(name) = indexed_kind(&entity.kind, &entity.value).and_then(collection) else {
            continue;
        };
        let id = entity.value["id"].as_str().unwrap_or_default().to_owned();
        let item = if entity.kind == "runtime.tombstone" {
            object(&[("collection", text(name)), ("id", text(&id))])
        } else {
            wire_value(&entity.value, &entity.object_id, INLINE_BYTES)
        };
        let size = serde_json::to_vec(&item)
            .map(|bytes| bytes.len())
            .unwrap_or(0)
            + 1;
        if count == limit || (*used > 0 && *used + size > SYNC_BYTES) {
            more = true;
            break;
        }
        // Changes advance in commit order. Within this page retain the last
        // update/delete/recreate for an identity; later pages then win naturally.
        result[name]
            .as_array_mut()
            .expect("arrays")
            .retain(|item| item["id"] != id);
        result["removed"]
            .as_array_mut()
            .expect("arrays")
            .retain(|item| item["collection"] != name || item["id"] != id);
        if entity.kind == "runtime.tombstone" {
            result["removed"].as_array_mut().expect("arrays").push(item);
        } else {
            result[name].as_array_mut().expect("arrays").push(item);
        }
        *used += size;
        count += 1;
        last = key;
    }

    result["historyWindow"] = object(&[
        ("revision", number(until)),
        ("epoch", number(generation)),
        ("generation", number(generation)),
        (
            "syncCursor",
            convert_value(ChangeCursor {
                session_id: session.into(),
                generation,
                after: if more { last } else { upper },
                until: more.then_some(until),
            })?,
        ),
        ("hasMoreChanges", boolean(more)),
        ("hasEarlier", boolean(false)),
        ("latest", boolean(true)),
        ("detailsTruncated", boolean(false)),
        ("incremental", boolean(true)),
    ]);
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
    if head.object_id.is_some() && index.index_root != head.object_id {
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
    let mut used = 4096usize;
    let limit = value["limit"].as_u64().unwrap_or(24).clamp(1, 64) as usize;
    if value["since"].is_null() {
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
    } else {
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
    }
    Ok(result)
}
