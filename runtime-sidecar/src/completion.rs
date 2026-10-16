//! Validate and build the canonical terminal event before any persistent mutation.
use crate::actor::{PendingEvent, RuntimeError, validate_terminal_status};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};

pub const MAX_RUN_DOCUMENT_BYTES: usize = 512 * 1024;

pub fn decode_run_document(
    session_id: &str,
    run_id: &str,
    status: &str,
    bytes: &[u8],
) -> Result<Option<Value>, RuntimeError> {
    validate_terminal_status(status)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() > MAX_RUN_DOCUMENT_BYTES {
        return Err(RuntimeError::InvalidCommand(
            "terminal run document exceeds budget".into(),
        ));
    }
    let document: Value = serde_json::from_slice(bytes)
        .map_err(|_| RuntimeError::InvalidCommand("invalid terminal run JSON".into()))?;
    if !document.is_object()
        || document["id"].as_str() != Some(run_id)
        || document["sessionId"].as_str() != Some(session_id)
        || document["status"].as_str() != Some(status)
    {
        return Err(RuntimeError::InvalidCommand(
            "terminal run identity or status mismatch".into(),
        ));
    }
    if let Some(value) = document.get("completedAt").filter(|value| !value.is_null()) {
        let time = value
            .as_str()
            .ok_or_else(|| RuntimeError::InvalidCommand("invalid completedAt".into()))?;
        DateTime::parse_from_rfc3339(time)
            .map_err(|_| RuntimeError::InvalidCommand("completedAt must be RFC3339".into()))?;
    }
    if let Some(reason) = document.get("stopReason") {
        if !reason.is_null() && !reason.is_string() {
            return Err(RuntimeError::InvalidCommand("invalid stopReason".into()));
        }
    }
    Ok(Some(document))
}

pub struct Completion {
    pub document: Option<Value>,
    pub completed_at: String,
    pub event: PendingEvent,
}

/// Missing completion timestamps are generated once; the durable receipt keeps that exact value.
pub fn complete(
    run_id: &str,
    status: &str,
    mut document: Option<Value>,
    previous_reason: Value,
) -> Result<Completion, RuntimeError> {
    validate_terminal_status(status)?;
    let supplied_time = document
        .as_ref()
        .and_then(|run| run["completedAt"].as_str());
    let completed_at = match supplied_time {
        Some(value) => {
            let time = DateTime::parse_from_rfc3339(value)
                .map_err(|_| RuntimeError::InvalidCommand("completedAt must be RFC3339".into()))?;
            time.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        }
        None => DateTime::<Utc>::from(std::time::SystemTime::now())
            .to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    let reason = if status == "failed" || status == "interrupted" || status == "blocked" {
        document
            .as_ref()
            .and_then(|run| run.get("stopReason"))
            .filter(|reason| reason.is_string())
            .cloned()
            .unwrap_or_else(|| {
                if previous_reason.is_string() {
                    previous_reason
                } else {
                    Value::Null
                }
            })
    } else {
        if previous_reason.is_string() {
            previous_reason
        } else {
            Value::Null
        }
    };
    let mut chunk = json!({"type":"run_finished", "runId":run_id});
    if let Some(run) = document.as_mut() {
        if let Some(lease) = run
            .pointer_mut("/metadata/executionLease")
            .filter(|value| value.is_object())
        {
            lease["closed"] = json!(true);
        }
        run["status"] = json!(status);
        run["completedAt"] = json!(completed_at);
        chunk["run"] = run.clone();
    }
    let payload = serde_json::to_vec(&json!({"schema":1, "chunk":chunk,
        "state":{"status":if status == "blocked" { "completed" } else { status }, "activeRunId":null, "pendingResumeToken":null,
            "blockedReason":reason, "updatedAt":completed_at}
    }))
    .map_err(|error| RuntimeError::InvalidCommand(error.to_string()))?;
    Ok(Completion {
        document,
        completed_at,
        event: PendingEvent {
            kind: "run_finished".into(),
            payload,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn final_document_is_validated_and_preserved_with_normalized_timestamps() {
        let run = json!({ "id":"r", "sessionId":"s", "status":"failed", "completedAt":"2026-10-16T15:00:00+08:00",
            "currentStep":4, "stopReason":"provider disconnected", "metadata":{"executionLease":{"closed":false,"epoch":"lease"}} });
        let document =
            decode_run_document("s", "r", "failed", &serde_json::to_vec(&run).unwrap()).unwrap();
        let complete = complete("r", "failed", document, Value::Null).unwrap();
        assert_eq!(complete.completed_at, "2026-10-16T07:00:00.000Z");
        let payload: Value = serde_json::from_slice(&complete.event.payload).unwrap();
        assert_eq!(payload["state"]["blockedReason"], "provider disconnected");
        assert_eq!(payload["chunk"]["run"]["currentStep"], 4);
        assert_eq!(
            payload["chunk"]["run"]["metadata"]["executionLease"]["closed"],
            true
        );
        assert_eq!(
            payload["state"]["updatedAt"],
            payload["chunk"]["run"]["completedAt"]
        );
        for invalid in [
            json!({"id":"different","sessionId":"s","status":"failed"}),
            json!({"id":"r","sessionId":"elsewhere","status":"failed"}),
            json!({"id":"r","sessionId":"s","status":"running"}),
            json!({"id":"r","sessionId":"s","status":"failed","completedAt":"runtime-finish"}),
            json!({"id":"r","sessionId":"s","status":"failed","stopReason":{}}),
        ] {
            assert!(
                decode_run_document("s", "r", "failed", &serde_json::to_vec(&invalid).unwrap())
                    .is_err()
            );
        }
    }
    #[test]
    fn absent_document_uses_real_time_without_inventing_a_run_document() {
        let earliest = std::time::SystemTime::now();
        let completion = complete("r", "cancelled", None, Value::Null).unwrap();
        let timestamp = DateTime::parse_from_rfc3339(&completion.completed_at)
            .unwrap()
            .timestamp_millis();
        assert!(timestamp >= DateTime::<Utc>::from(earliest).timestamp_millis());
        let payload: Value = serde_json::from_slice(&completion.event.payload).unwrap();
        assert!(payload["chunk"].get("run").is_none());
        assert_eq!(payload["chunk"]["runId"], "r");
    }
}
