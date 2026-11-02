//! Compare structurally shared projections before materializing JSON. Unchanged
//! MCP schemas, transcript chunks and other persistent subtrees are O(1).
use super::{Change, JsonlResult, diff, insert};
use crate::storage::jsonl::segment::PValue;
use std::path::Path;

pub fn between_persistent(root: &Path, before: &PValue, after: &PValue) -> JsonlResult<Vec<Change>> {
    let mut changes = Vec::new();
    compare(root, &mut Vec::new(), before, after, &mut changes)?;
    Ok(changes)
}

fn compare(root: &Path, path: &mut Vec<String>, before: &PValue, after: &PValue, changes: &mut Vec<Change>) -> JsonlResult<()> {
    match (before, after) {
        (PValue::Object(a), PValue::Object(b)) => {
            if a.ptr_eq(b) { return Ok(()); }
            for key in a.keys().filter(|key| !b.contains_key(*key)) {
                path.push(key.clone());
                changes.push(Change::Remove { path: path.clone() });
                path.pop();
            }
            for (key, value) in b {
                path.push(key.clone());
                if let Some(previous) = a.get(key) {
                    compare(root, path, previous, value, changes)?;
                } else {
                    insert(root, path, &value.to_json(), changes)?;
                }
                path.pop();
            }
        }
        (PValue::Array(a), PValue::Array(b)) => {
            if a.ptr_eq(b) { return Ok(()); }
            if a.len() != b.len() {
                changes.push(Change::Resize { path: path.clone(), length: b.len() });
            }
            for (index, value) in b.iter().enumerate() {
                path.push(index.to_string());
                compare(root, path, a.get(index).unwrap_or(&PValue::Null), value, changes)?;
                path.pop();
            }
        }
        _ if before == after => {},
        _ => diff(root, path, &before.to_json(), &after.to_json(), changes)?,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn persistent_changes_replay_like_the_document_codec() {
        let root = std::env::temp_dir().join(format!("persistent-delta-{}", uuid::Uuid::new_v4()));
        let versions = [
            json!({"sessionMetadata":{"latestSystemPrompt":"旧提示"},"items":[{"text":"中"},3],"remove":true}),
            json!({"sessionMetadata":{"latestSystemPrompt":"新提示"},"items":[{"text":"中文"},null,{"nested":[true]}]}),
            json!({"items":[],"nullable":null}),
            json!([null,{"object":["a","b"]}]),
            json!({"object":{"new":1}}),
        ];
        for pair in versions.windows(2) {
            let changes = between_persistent(&root, &PValue::from_json(&pair[0]), &PValue::from_json(&pair[1])).unwrap();
            let mut replayed = pair[0].clone();
            super::super::apply(&root, &mut replayed, &changes).unwrap();
            assert_eq!(replayed, pair[1]);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_scalar_update_does_not_materialize_unchanged_metadata() {
        let root = std::env::temp_dir();
        let before = PValue::from_json(&json!({"status":"running","sessionMetadata":{
            "mcpToolDefinitions": "x".repeat(512 * 1024), "latestSystemPrompt":"keep"
        }}));
        let mut after = before.clone();
        after.set("status", PValue::String("completed".into()));
        let changes = between_persistent(&root, &before, &after).unwrap();
        assert_eq!(changes.len(), 1);
        assert!(matches!(&changes[0], Change::Set { path, value } if path == &["status"] && value == "completed"));
    }
}
