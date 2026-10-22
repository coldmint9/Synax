//! Apply durable field changes without round-tripping an entire UI snapshot
//! and control history through JSON for every streamed token.
use super::load::Loaded;
use crate::storage::jsonl::{
    assets,
    delta::Change,
    error::{JsonlError, JsonlResult},
    segment::{PValue, Projection},
};
use serde::{Serialize, de::DeserializeOwned};
use std::path::Path;

fn invalid() -> JsonlError {
    JsonlError::corrupt("events-v2", 0, "invalid field change")
}

fn path(change: &Change) -> &[String] {
    match change {
        Change::Set { path, .. }
        | Change::Remove { path }
        | Change::Append { path, .. }
        | Change::Resize { path, .. }
        | Change::TextRef { path, .. } => path,
    }
}

fn target<'a>(value: &'a mut PValue, path: &[String]) -> JsonlResult<&'a mut PValue> {
    let mut current = value;
    for key in path {
        current = match current {
            PValue::Object(map) => map.get_mut(key).ok_or_else(invalid)?,
            PValue::Array(items) => items
                .get_mut(key.parse::<usize>().map_err(|_| invalid())?)
                .ok_or_else(invalid)?,
            _ => return Err(invalid()),
        };
    }
    Ok(current)
}

fn set(value: &mut PValue, path: &[String], next: PValue) -> JsonlResult<()> {
    let Some((key, parent)) = path.split_last() else {
        *value = next;
        return Ok(());
    };
    match target(value, parent)? {
        PValue::Object(map) => {
            map.insert(key.clone(), next);
        }
        PValue::Array(items) => {
            *items
                .get_mut(key.parse::<usize>().map_err(|_| invalid())?)
                .ok_or_else(invalid)? = next;
        }
        _ => return Err(invalid()),
    }
    Ok(())
}

fn apply(root: &Path, value: &mut PValue, change: &Change, path: &[String]) -> JsonlResult<()> {
    match change {
        Change::Set { value: next, .. } => set(value, path, PValue::from_json(next))?,
        Change::TextRef { digest, .. } => {
            if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(invalid());
            }
            let bytes = assets::get(root, digest)?.ok_or_else(invalid)?;
            if super::super::layout::sha256_hex(&bytes) != *digest {
                return Err(invalid());
            }
            set(
                value,
                path,
                PValue::String(String::from_utf8(bytes).map_err(|_| invalid())?),
            )?;
        }
        Change::Remove { .. } => {
            let (key, parent) = path.split_last().ok_or_else(invalid)?;
            let PValue::Object(map) = target(value, parent)? else {
                return Err(invalid());
            };
            map.remove(key);
        }
        Change::Append { text, .. } => {
            let PValue::String(current) = target(value, path)? else {
                return Err(invalid());
            };
            current.push_str(text);
        }
        Change::Resize { length, .. } => {
            if *length > 1_000_000 {
                return Err(invalid());
            }
            let PValue::Array(items) = target(value, path)? else {
                return Err(invalid());
            };
            if items.len() > *length {
                items.truncate(*length);
            }
            while items.len() < *length {
                items.push_back(PValue::Null);
            }
        }
    }
    Ok(())
}

fn typed<T: Serialize + DeserializeOwned>(
    root: &Path,
    field: &mut T,
    changes: &[(&Change, &[String])],
) -> JsonlResult<()> {
    if changes.is_empty() {
        return Ok(());
    }
    let mut value = PValue::from_json(&serde_json::to_value(&*field)?);
    for (change, path) in changes {
        apply(root, &mut value, change, path)?;
    }
    *field = serde_json::from_value(value.to_json())?;
    Ok(())
}

fn projection(
    root: &Path,
    projection: &mut Projection,
    field: &str,
    changes: &[(&Change, &[String])],
) -> JsonlResult<()> {
    let patch = |value: &mut PValue| -> JsonlResult<()> {
        for (change, rest) in changes {
            apply(root, value, change, rest)?;
        }
        Ok(())
    };
    match field {
        "session" => patch(&mut projection.session),
        "run" => patch(&mut projection.run),
        "liveChunks" | "queuedInputs" => {
            let items = if field == "liveChunks" {
                &mut projection.live_chunks
            } else {
                &mut projection.queued_inputs
            };
            let mut value = PValue::Array(std::mem::take(items));
            patch(&mut value)?;
            let PValue::Array(updated) = value else {
                return Err(invalid());
            };
            *items = updated;
            Ok(())
        }
        "cursor" => typed(root, &mut projection.cursor, changes),
        "queueRevision" => typed(root, &mut projection.queue_revision, changes),
        "forceInjectItemId" => typed(root, &mut projection.force_inject_item_id, changes),
        "completedStepIds" => {
            let mut ids: Vec<String> = projection.completed_step_ids.iter().cloned().collect();
            typed(root, &mut ids, changes)?;
            projection.completed_step_ids = ids.into_iter().collect();
            Ok(())
        }
        "pendingQueueInput" | "pendingPartialMessage" => {
            let field = if field == "pendingQueueInput" {
                &mut projection.pending_queue_input
            } else {
                &mut projection.pending_partial_message
            };
            let mut value = field.take().unwrap_or(PValue::Null);
            for (change, rest) in changes {
                if rest.is_empty() && matches!(change, Change::Remove { .. }) {
                    value = PValue::Null;
                } else {
                    apply(root, &mut value, change, rest)?;
                }
            }
            *field = if value.is_null() { None } else { Some(value) };
            Ok(())
        }
        _ => Err(invalid()),
    }
}

pub(super) fn apply_changes(
    root: &Path,
    loaded: &mut Loaded,
    changes: &[Change],
) -> JsonlResult<()> {
    // Whole-document/projection replacements remain compatible with the
    // general codec. Normal writer deltas only touch individual fields.
    if changes
        .iter()
        .any(|change| path(change).is_empty() || path(change) == ["projection"])
    {
        let mut value = super::super::delta::document(
            &loaded.state,
            &loaded.projection,
            &loaded.control,
            &loaded.queue,
        );
        super::super::delta::apply(root, &mut value, changes)?;
        loaded.state = serde_json::from_value(value["state"].take())?;
        loaded.control = serde_json::from_value(value["control"].take())?;
        loaded.queue = serde_json::from_value(value["queue"].take())?;
        loaded.projection =
            Projection::from_snapshot(&serde_json::from_value(value["projection"].take())?);
        return Ok(());
    }
    let mut state = Vec::new();
    let mut control = Vec::new();
    let mut queue = Vec::new();
    let mut projection_fields =
        std::collections::BTreeMap::<&str, Vec<(&Change, &[String])>>::new();
    for change in changes {
        let (field, rest) = path(change).split_first().ok_or_else(invalid)?;
        match field.as_str() {
            "state" => state.push((change, rest)),
            "control" => control.push((change, rest)),
            "queue" => queue.push((change, rest)),
            "projection" => {
                let (field, rest) = rest.split_first().ok_or_else(invalid)?;
                projection_fields
                    .entry(field.as_str())
                    .or_default()
                    .push((change, rest));
            }
            _ => return Err(invalid()),
        }
    }
    typed(root, &mut loaded.state, &state)?;
    typed(root, &mut loaded.control, &control)?;
    typed(root, &mut loaded.queue, &queue)?;
    for (field, changes) in projection_fields {
        projection(root, &mut loaded.projection, field, &changes)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::jsonl::delta;
    use serde_json::json;

    #[test]
    fn selective_replay_matches_the_document_codec_without_copying_unchanged_context() {
        let root =
            std::env::temp_dir().join(format!("synax-selective-replay-{}", uuid::Uuid::new_v4()));
        let mut loaded = super::super::load::load(&root, "s").unwrap();
        loaded.projection.session = PValue::from_json(
            &json!({"id":"s", "context":"思考".repeat(100_000), "status":"running"}),
        );
        let context = loaded
            .projection
            .session
            .get("context")
            .unwrap()
            .as_str()
            .unwrap()
            .as_ptr();
        let mut before = delta::document(
            &loaded.state,
            &loaded.projection,
            &loaded.control,
            &loaded.queue,
        );
        for round in 0..4 {
            let mut after = before.clone();
            after["state"]["revision"] = json!(round + 1);
            after["projection"]["session"]["status"] = json!(if round % 2 == 0 {
                "running"
            } else {
                "completed"
            });
            after["projection"]["liveChunks"] = if round % 2 == 0 {
                json!([{"type":"message_delta", "delta":"中文追加", "tokens":5}])
            } else {
                json!([])
            };
            after["projection"]["completedStepIds"] =
                json!((0..=round).map(|i| format!("step-{i}")).collect::<Vec<_>>());
            after["control"]["permissions"] =
                json!([{"id":"p", "action":"ask", "reason":format!("内容{round}")}]);
            after["queue"]["revision"] = json!(round);
            if round % 2 == 0 {
                after["projection"]["pendingPartialMessage"] = json!({"content":"保留"});
            } else {
                after["projection"]
                    .as_object_mut()
                    .unwrap()
                    .remove("pendingPartialMessage");
            }
            let changes = delta::between(&root, &before, &after).unwrap();
            apply_changes(&root, &mut loaded, &changes).unwrap();
            assert_eq!(
                delta::document(
                    &loaded.state,
                    &loaded.projection,
                    &loaded.control,
                    &loaded.queue
                ),
                after
            );
            assert_eq!(
                loaded
                    .projection
                    .session
                    .get("context")
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .as_ptr(),
                context
            );
            before = after;
        }
        drop(loaded);
        std::fs::remove_dir_all(root).unwrap();
    }
}
