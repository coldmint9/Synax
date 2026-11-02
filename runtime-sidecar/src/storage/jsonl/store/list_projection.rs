//! Read-model boundaries. Execution artifacts stay in the authoritative session,
//! never in the list index, its disposable cache, or badge traffic.
use serde_json::{Map, Value};

pub(crate) fn detail_metadata(key: &str) -> bool {
    matches!(key, "latestSystemPrompt" | "mcpToolDefinitions" | "inputQueue" | "inputForceInjectId")
}

pub(crate) fn summary(header: &Value) -> Value {
    let Some(fields) = header.as_object() else { return header.clone(); };
    Value::Object(fields.iter().map(|(key, value)| {
        let value = if key == "sessionMetadata" {
            value.as_object().map(|metadata| Value::Object(metadata.iter()
                .filter(|(key, _)| !detail_metadata(key))
                .map(|(key, value)| (key.clone(), value.clone())).collect()))
                .unwrap_or_else(|| value.clone())
        } else { value.clone() };
        (key.clone(), value)
    }).collect())
}

/// Status normalization belongs to the host's session-state policy. Carry only
/// its inputs, plus identity/visibility fields; never any execution metadata.
pub(super) fn badge(header: &Value) -> Value {
    let mut row = Map::new();
    for key in ["id", "projectId", "profileId", "status", "updatedAt", "parentSessionId", "blockedReason"] {
        if let Some(value) = header.get(key) { row.insert(key.into(), value.clone()); }
    }
    let mut metadata = Map::new();
    for key in ["archivedAt", "deletedAt", "forkPreparing", "runtimeControl"] {
        if let Some(value) = header["sessionMetadata"].get(key) {
            metadata.insert(key.into(), value.clone());
        }
    }
    row.insert("sessionMetadata".into(), Value::Object(metadata));
    Value::Object(row)
}

/// Project before converting persistent values so omitted artifacts are never
/// allocated, including on every streamed token's list-index update.
pub(crate) fn persistent_summary(header: &crate::storage::jsonl::segment::PValue) -> Value {
    use crate::storage::jsonl::segment::PValue;
    let PValue::Object(fields) = header else { return header.to_json(); };
    Value::Object(fields.iter().map(|(key, value)| {
        let value = if key == "sessionMetadata" {
            match value {
                PValue::Object(metadata) => Value::Object(metadata.iter()
                    .filter(|(key, _)| !detail_metadata(key))
                    .map(|(key, value)| (key.clone(), value.to_json())).collect()),
                _ => value.to_json(),
            }
        } else { value.to_json() };
        (key.clone(), value)
    }).collect())
}
