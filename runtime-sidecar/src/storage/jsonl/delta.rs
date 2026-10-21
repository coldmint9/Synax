//! Versioned field changes. Full UI/execution states never cross this codec.
use super::{JsonlError, JsonlResult, assets};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Change {
    Set { path: Vec<String>, value: Value },
    Remove { path: Vec<String> },
    Append { path: Vec<String>, text: String },
    Resize { path: Vec<String>, length: usize },
    TextRef { path: Vec<String>, digest: String },
}

pub fn between(root: &Path, before: &Value, after: &Value) -> JsonlResult<Vec<Change>> {
    let mut changes = Vec::new();
    diff(root, &mut Vec::new(), before, after, &mut changes)?;
    Ok(changes)
}

fn diff(
    root: &Path,
    path: &mut Vec<String>,
    before: &Value,
    after: &Value,
    changes: &mut Vec<Change>,
) -> JsonlResult<()> {
    if before == after {
        return Ok(());
    }
    if path.last().is_some_and(|key| key == "latestSystemPrompt")
        && let Some(text) = after.as_str()
    {
        changes.push(Change::TextRef {
            path: path.clone(),
            digest: assets::put(root, text.as_bytes())?,
        });
        return Ok(());
    }
    match (before, after) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().filter(|key| !b.contains_key(*key)) {
                let mut target = path.clone();
                target.push(key.clone());
                changes.push(Change::Remove { path: target });
            }
            for (key, value) in b {
                path.push(key.clone());
                if a.contains_key(key) {
                    diff(root, path, &a[key], value, changes)?;
                } else {
                    insert(root, path, value, changes)?;
                }
                path.pop();
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                changes.push(Change::Resize {
                    path: path.clone(),
                    length: b.len(),
                });
            }
            for (i, value) in b.iter().enumerate() {
                path.push(i.to_string());
                diff(root, path, a.get(i).unwrap_or(&Value::Null), value, changes)?;
                path.pop();
            }
        }
        (Value::String(a), Value::String(b)) if !a.is_empty() && b.starts_with(a.as_str()) => {
            changes.push(Change::Append {
                path: path.clone(),
                text: b[a.len()..].to_owned(),
            });
        }
        _ => insert(root, path, after, changes)?,
    }
    Ok(())
}

fn insert(
    root: &Path,
    path: &mut Vec<String>,
    value: &Value,
    out: &mut Vec<Change>,
) -> JsonlResult<()> {
    if path.last().is_some_and(|key| key == "latestSystemPrompt")
        && let Some(text) = value.as_str()
    {
        out.push(Change::TextRef {
            path: path.clone(),
            digest: assets::put(root, text.as_bytes())?,
        });
    } else if value.is_object() {
        out.push(Change::Set {
            path: path.clone(),
            value: json!({}),
        });
        diff(root, path, &json!({}), value, out)?;
    } else if value.is_array() {
        out.push(Change::Set {
            path: path.clone(),
            value: json!([]),
        });
        diff(root, path, &json!([]), value, out)?;
    } else {
        out.push(Change::Set {
            path: path.clone(),
            value: value.clone(),
        });
    }
    Ok(())
}

fn invalid() -> JsonlError {
    JsonlError::corrupt("events-v2", 0, "invalid field change")
}
fn target<'a>(value: &'a mut Value, path: &[String]) -> JsonlResult<&'a mut Value> {
    let mut current = value;
    for key in path {
        current = match current {
            Value::Object(map) => map.get_mut(key).ok_or_else(invalid)?,
            Value::Array(array) => array
                .get_mut(key.parse::<usize>().map_err(|_| invalid())?)
                .ok_or_else(invalid)?,
            _ => return Err(invalid()),
        };
    }
    Ok(current)
}
fn set(value: &mut Value, path: &[String], next: Value) -> JsonlResult<()> {
    let Some((key, parent)) = path.split_last() else {
        *value = next;
        return Ok(());
    };
    match target(value, parent)? {
        Value::Object(map) => {
            map.insert(key.clone(), next);
        }
        Value::Array(array) => {
            *array
                .get_mut(key.parse::<usize>().map_err(|_| invalid())?)
                .ok_or_else(invalid)? = next;
        }
        _ => return Err(invalid()),
    }
    Ok(())
}
pub fn apply(root: &Path, value: &mut Value, changes: &[Change]) -> JsonlResult<()> {
    for change in changes {
        match change {
            Change::Set { path, value: next } => set(value, path, next.clone())?,
            Change::TextRef { path, digest } => {
                if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(invalid());
                }
                let bytes = assets::get(root, digest)?.ok_or_else(invalid)?;
                if super::layout::sha256_hex(&bytes) != *digest {
                    return Err(invalid());
                }
                set(
                    value,
                    path,
                    Value::String(String::from_utf8(bytes).map_err(|_| invalid())?),
                )?;
            }
            Change::Remove { path } => {
                let (key, parent) = path.split_last().ok_or_else(invalid)?;
                target(value, parent)?
                    .as_object_mut()
                    .ok_or_else(invalid)?
                    .remove(key);
            }
            Change::Append { path, text } => {
                let Value::String(current) = target(value, path)? else {
                    return Err(invalid());
                };
                current.push_str(text);
            }
            Change::Resize { path, length } => {
                if *length > 1_000_000 {
                    return Err(invalid());
                }
                target(value, path)?
                    .as_array_mut()
                    .ok_or_else(invalid)?
                    .resize(*length, Value::Null);
            }
        }
    }
    Ok(())
}

/// Receipt payloads reference this transaction's event/control/queue, instead
/// of embedding another copy of them (often byte arrays of JSON).
pub fn compact_receipt(root: &Path, mut result: Value, control: &Value) -> JsonlResult<Value> {
    if let Some(event) = result.get("event").filter(|v| v.is_object()) {
        let seq = event["sequence"].clone();
        result.as_object_mut().unwrap().remove("event");
        result["eventSequence"] = seq;
    }
    if let Some(bytes) = result.as_object_mut().and_then(|m| m.remove("state_json")) {
        let bytes: Vec<u8> = serde_json::from_value(bytes)?;
        let state: Value = serde_json::from_slice(&bytes)?;
        result["controlChanges"] = serde_json::to_value(between(root, control, &state)?)?;
    }
    if result
        .as_object_mut()
        .is_some_and(|m| m.remove("queue").is_some())
    {
        result["currentQueue"] = json!(true);
    }
    Ok(result)
}
pub fn expand_receipt(
    root: &Path,
    mut result: Value,
    control: &Value,
    queue: &Value,
    events: &[crate::runtime::actor::StreamEvent],
) -> JsonlResult<Value> {
    if let Some(seq) = result
        .as_object_mut()
        .and_then(|m| m.remove("eventSequence"))
    {
        let event = events
            .iter()
            .find(|event| seq.as_u64() == Some(event.sequence))
            .ok_or_else(invalid)?;
        result["event"] = serde_json::to_value(event)?;
    }
    if let Some(changes) = result
        .as_object_mut()
        .and_then(|m| m.remove("controlChanges"))
    {
        let mut state = control.clone();
        apply(
            root,
            &mut state,
            &serde_json::from_value::<Vec<Change>>(changes)?,
        )?;
        result["state_json"] = serde_json::to_value(serde_json::to_vec(&state)?)?;
    }
    if result
        .as_object_mut()
        .is_some_and(|m| m.remove("currentQueue").is_some())
    {
        result["queue"] = queue.clone();
    }
    Ok(result)
}

pub fn document(
    state: &super::record::SnapshotCond,
    projection: &super::segment::Projection,
    control: &crate::runtime::session_types::ControlState,
    queue: &crate::runtime::input_queue::QueueState,
) -> Value {
    let mut state = state.clone();
    state.header = None;
    json!({"state":state, "projection":projection.to_json(), "control":control, "queue":queue})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changes_preserve_null_removal_array_edits_and_unicode_suffixes() {
        let root = std::env::temp_dir().join(format!("synax-delta-{}", uuid::Uuid::new_v4()));
        let mut value =
            json!({"remove":1,"nullable":1,"text":"思考", "array":[{"id":"a","value":1},2]});
        let after = json!({"nullable":null,"text":"思考追加", "array":[{"id":"a","value":2},3,4], "sessionMetadata":{"latestSystemPrompt":"固定提示词"}});
        let changes = between(&root, &value, &after).unwrap();
        assert!(
            !serde_json::to_string(&changes)
                .unwrap()
                .contains("固定提示词")
        );
        apply(&root, &mut value, &changes).unwrap();
        assert_eq!(value, after);
        let shorter = json!({"array":[], "nullable":null});
        let changes = between(&root, &value, &shorter).unwrap();
        apply(&root, &mut value, &changes).unwrap();
        assert_eq!(value, shorter);
        std::fs::remove_dir_all(root).unwrap();
    }
}
