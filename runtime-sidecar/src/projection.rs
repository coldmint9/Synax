//! UI materialization committed in the same batch as its canonical stream cursor.
//! Session metadata is seeded once by the host during the repository cutover.
use crate::actor::{PendingEvent, RuntimeError};
use crate::input_queue::QueueState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const MAX_PROJECTION_BYTES: usize = 768 * 1024;
pub fn is_valid_status(status: &str) -> bool {
    matches!(
        status,
        "stopping"
            | "queued"
            | "running"
            | "waiting_permission"
            | "waiting_input"
            | "paused"
            | "completed"
            | "failed"
            | "cancelled"
            | "interrupted"
    )
}

fn valid_status(status: &str) -> bool {
    is_valid_status(status)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSnapshot {
    pub session: Value,
    pub run: Value,
    pub cursor: u64,
    pub live_chunks: Vec<Value>,
    pub completed_step_ids: Vec<String>,
    #[serde(default)]
    pub queued_inputs: Vec<Value>,
    #[serde(default)]
    pub force_inject_item_id: Option<String>,
    #[serde(default)]
    pub queue_revision: u64,
    #[serde(default)]
    pub pending_queue_input: Option<Value>,
    /// Captured before terminal UI state clears live deltas. The finish
    /// transaction moves this into canonical history exactly once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_partial_message: Option<Value>,
}
impl UiSnapshot {
    pub fn seed(session_id: &str, bytes: &[u8]) -> Result<Self, RuntimeError> {
        if bytes.len() > MAX_PROJECTION_BYTES {
            return Err(RuntimeError::Backpressure);
        }
        let session: Value = serde_json::from_slice(bytes)
            .map_err(|_| RuntimeError::InvalidCommand("invalid session JSON".into()))?;
        if !session.is_object()
            || session["id"].as_str() != Some(session_id)
            || session["projectId"].as_str().is_none()
            || !session["status"].as_str().is_some_and(valid_status)
            || session["updatedAt"].as_str().is_none()
        {
            return Err(RuntimeError::InvalidCommand(
                "invalid session seed identity or state".into(),
            ));
        }
        let mut snapshot = Self {
            session,
            run: Value::Null,
            cursor: 0,
            live_chunks: vec![],
            completed_step_ids: vec![],
            queued_inputs: vec![],
            force_inject_item_id: None,
            queue_revision: 0,
            pending_queue_input: None,
            pending_partial_message: None,
        };
        let items = snapshot
            .session
            .pointer("/sessionMetadata/inputQueue")
            .filter(|value| !value.is_null())
            .map(|value| serde_json::from_value::<Vec<Value>>(value.clone()))
            .transpose()
            .map_err(|_| RuntimeError::InvalidCommand("invalid seed input queue".into()))?
            .unwrap_or_default();
        let force = snapshot
            .session
            .pointer("/sessionMetadata/inputForceInjectId")
            .filter(|value| !value.is_null())
            .map(|value| {
                value
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| RuntimeError::InvalidCommand("invalid seed force marker".into()))
            })
            .transpose()?;
        let queue = QueueState {
            items,
            force_inject_item_id: force,
            ..Default::default()
        };
        queue.validate()?;
        snapshot.set_queue(&queue);
        snapshot.session["pendingResumeToken"] = snapshot
            .session
            .get("pendingResumeToken")
            .cloned()
            .unwrap_or(Value::Null);
        snapshot.session["blockedReason"] = snapshot
            .session
            .get("blockedReason")
            .cloned()
            .unwrap_or(Value::Null);
        snapshot.session["activeRunId"] = Value::Null;
        snapshot.encode()?;
        Ok(snapshot)
    }
    pub fn encode(&self) -> Result<Vec<u8>, RuntimeError> {
        let bytes = serde_json::to_vec(self)
            .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))?;
        if bytes.len() > MAX_PROJECTION_BYTES {
            return Err(RuntimeError::ProjectionTooLarge);
        }
        Ok(bytes)
    }

    pub fn queue(&self) -> QueueState {
        QueueState {
            items: self.queued_inputs.clone(),
            force_inject_item_id: self.force_inject_item_id.clone(),
            revision: self.queue_revision,
            consumed: None,
            delivery: self.pending_queue_input.clone(),
        }
    }
    pub fn set_queue(&mut self, queue: &QueueState) {
        self.queued_inputs = queue.items.clone();
        self.force_inject_item_id = queue.force_inject_item_id.clone();
        self.queue_revision = queue.revision;
        self.pending_queue_input = queue.delivery.clone();
        // One source in the persisted projection, with legacy field names for existing UI readers.
        if !self.session["sessionMetadata"].is_object() {
            self.session["sessionMetadata"] = json!({});
        }
        self.session["sessionMetadata"]["inputQueue"] = json!(queue.items);
        self.session["sessionMetadata"]["inputForceInjectId"] = json!(queue.force_inject_item_id);
    }
    pub fn queue_mutation(
        &mut self,
        operation: &str,
        payload: &[u8],
    ) -> Result<(QueueState, bool), RuntimeError> {
        let payload = serde_json::from_slice(payload)
            .map_err(|_| RuntimeError::InvalidCommand("invalid queue JSON".into()))?;
        let mut queue = self.queue();
        let changed = queue.apply(operation, &payload)?;
        self.set_queue(&queue);
        self.encode()?;
        Ok((queue, changed))
    }
    pub fn admitted(&mut self, run_id: &str) {
        if self.run["id"].as_str() != Some(run_id) {
            self.run = Value::Null;
            self.live_chunks.clear();
            self.completed_step_ids.clear();
            self.pending_partial_message = None;
        }
        self.session["pendingResumeToken"] = Value::Null;
        self.session["activeRunId"] = json!(run_id);
        self.session["status"] = json!("queued");
        self.session["blockedReason"] = Value::Null;
    }
    fn current_step(&self) -> Option<String> {
        self.live_chunks
            .first()
            .and_then(|chunk| chunk["step"]["id"].as_str())
            .map(str::to_owned)
    }
    fn partial_message(&self, run_id: &str, created_at: &str) -> Option<Value> {
        let step_id = self.current_step()?;
        let content: String = self.live_chunks.iter()
            .filter(|chunk| chunk["type"] == "message_delta" && chunk["stepId"] == step_id)
            .filter_map(|chunk| chunk["delta"].as_str()).collect();
        if content.is_empty() { return None; }
        Some(json!({
            "id":format!("msg_partial_{run_id}_{step_id}"), "sessionId":self.session["id"],
            "runId":run_id, "stepId":step_id, "role":"assistant", "content":content,
            "createdAt":created_at,
            "metadata":{"source":"runtime_partial","partial":true,"runId":run_id,"stepId":step_id}
        }))
    }
    pub(crate) fn take_partial_message(&mut self, run_id: &str, created_at: &str) -> Option<Value> {
        self.pending_partial_message.take().or_else(|| self.partial_message(run_id, created_at))
    }
    fn complete_current(&mut self) {
        if let Some(id) = self.current_step() {
            if !self.completed_step_ids.contains(&id) {
                self.completed_step_ids.push(id);
            }
        }
        self.live_chunks.clear();
    }
    pub fn apply(
        &mut self,
        sequence: u64,
        run_id: &str,
        pending: &PendingEvent,
    ) -> Result<(), RuntimeError> {
        if sequence != self.cursor + 1 {
            return Err(RuntimeError::StorageUnavailable(
                "projection cursor gap".into(),
            ));
        }
        let payload: Value = serde_json::from_slice(&pending.payload).map_err(|_| {
            RuntimeError::InvalidCommand("projection requires a schema:1 event payload".into())
        })?;
        let chunk = &payload["chunk"];
        let state = &payload["state"];
        let Some(kind) = chunk["type"].as_str() else {
            return Err(RuntimeError::InvalidCommand("missing chunk type".into()));
        };
        let nullable_string = |value: &Value| value.is_null() || value.is_string();
        let matching_step = self
            .current_step()
            .is_some_and(|id| chunk["stepId"].as_str() == Some(id.as_str()));
        if payload["schema"] != 1
            || kind != pending.kind
            || !state.is_object()
            || !state["status"].as_str().is_some_and(valid_status)
            || state["updatedAt"].as_str().is_none()
            || ["activeRunId", "blockedReason", "pendingResumeToken"]
                .iter()
                .any(|key| state.get(key).is_none_or(|value| !nullable_string(value)))
            || state["activeRunId"].as_str().is_some_and(|id| id != run_id)
            || chunk["runId"].as_str().is_some_and(|id| id != run_id)
            || chunk["sessionId"]
                .as_str()
                .is_some_and(|id| Some(id) != self.session["id"].as_str())
        {
            return Err(RuntimeError::InvalidCommand(
                "event projection identity or state mismatch".into(),
            ));
        }
        for field in [
            "status",
            "activeRunId",
            "pendingResumeToken",
            "blockedReason",
            "updatedAt",
        ] {
            self.session[field] = state[field].clone();
        }
        if let Some(run) = chunk.get("run") {
            if run["id"].as_str() != Some(run_id) || run["sessionId"] != self.session["id"] {
                return Err(RuntimeError::InvalidCommand(
                    "event run identity mismatch".into(),
                ));
            }
            if self.run["id"] != run["id"] {
                self.live_chunks.clear();
                self.completed_step_ids.clear();
            }
            self.run = run.clone();
        }
        match kind {
            "step_started" => {
                if chunk["step"]["id"].as_str().is_none()
                    || chunk["step"]["runId"].as_str() != Some(run_id)
                    || chunk["step"]["sessionId"] != self.session["id"]
                {
                    return Err(RuntimeError::InvalidCommand(
                        "step identity mismatch".into(),
                    ));
                }
                if self.current_step().as_deref() != chunk["step"]["id"].as_str() {
                    self.complete_current();
                }
                self.live_chunks = vec![chunk.clone()];
            }
            "retry_status" if matching_step => {
                if matches!(
                    chunk["retry"]["phase"].as_str(),
                    Some("waiting" | "group_wait")
                ) {
                    self.live_chunks.truncate(1);
                }
                self.live_chunks.push(chunk.clone());
            }
            "message_delta" | "thought_delta" if matching_step => {
                let delta = chunk["delta"]
                    .as_str()
                    .ok_or_else(|| RuntimeError::InvalidCommand("invalid delta".into()))?;
                if let Some(last) = self.live_chunks.last_mut().filter(|last| {
                    last["type"] == chunk["type"] && last["stepId"] == chunk["stepId"]
                }) {
                    let mut text = last["delta"].as_str().unwrap_or_default().to_owned();
                    text.push_str(delta);
                    last["delta"] = json!(text);
                    for field in ["outputTokens", "thinkingTokens"] {
                        if let Some(value) = chunk.get(field) {
                            last[field] = value.clone();
                        }
                    }
                } else {
                    self.live_chunks.push(chunk.clone());
                }
            }
            "tool_call" | "tool_result" if matching_step => {
                self.live_chunks.push(chunk.clone());
            }
            "message"
                if chunk["message"]["role"] == "assistant"
                    && (self.current_step().as_deref() == chunk["message"]["stepId"].as_str()
                        || self.pending_partial_message.as_ref().is_some_and(|message|
                            message["stepId"] == chunk["message"]["stepId"])) =>
            {
                self.pending_partial_message = None;
                self.complete_current();
            }
            _ => {}
        }
        if matches!(state["status"].as_str(), Some("interrupted" | "cancelled" | "failed" | "paused"))
            && kind != "run_finished" && self.pending_partial_message.is_none() {
            self.pending_partial_message = self.partial_message(run_id, state["updatedAt"].as_str().unwrap_or_default());
        }
        // Stop requests retain live output until shutdown has been confirmed.
        if !matches!(
            state["status"].as_str(),
            Some("running" | "queued" | "waiting_permission" | "waiting_input" | "stopping")
        ) {
            self.complete_current();
        }
        self.cursor = sequence;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot() -> UiSnapshot {
        UiSnapshot::seed(
            "s",
            br#"{"id":"s","projectId":"p","status":"queued","updatedAt":"2026-10-16"}"#,
        )
        .unwrap()
    }
    pub fn pending(chunk: Value, status: &str) -> PendingEvent {
        PendingEvent { kind: chunk["type"].as_str().unwrap().into(), payload: serde_json::to_vec(&json!({ "schema":1, "chunk":chunk,
            "state": { "status":status, "activeRunId": if status == "completed" { Value::Null } else { json!("r") }, "blockedReason":null, "pendingResumeToken":null, "updatedAt":"2026-10-16" } })).unwrap() }
    }
    fn step(id: &str) -> Value {
        json!({ "type":"step_started", "step":{"id":id,"sessionId":"s","runId":"r","index":1} })
    }
    #[test]
    fn published_assistant_message_is_not_duplicated_as_partial() {
        let mut snapshot = snapshot();
        snapshot.apply(1, "r", &pending(step("a"), "running")).unwrap();
        snapshot.apply(2, "r", &pending(json!({"type":"message_delta","stepId":"a","delta":"visible"}), "running")).unwrap();
        snapshot.apply(3, "r", &pending(json!({"type":"stop_acknowledged"}), "interrupted")).unwrap();
        assert!(snapshot.pending_partial_message.is_some());
        snapshot.apply(4, "r", &pending(json!({"type":"message","message":{"role":"assistant","stepId":"a","content":"visible"}}), "interrupted")).unwrap();
        assert!(snapshot.take_partial_message("r", "2026-10-19").is_none());
    }
    #[test]
    fn coalesced_deltas_keep_latest_text_and_reasoning_token_counts() {
        let mut snapshot = snapshot();
        snapshot.apply(1, "r", &pending(step("a"), "running")).unwrap();
        for (sequence, kind, field, delta, tokens) in [
            (2, "thought_delta", "thinkingTokens", "think", 5),
            (3, "thought_delta", "thinkingTokens", " more", 12),
            (4, "message_delta", "outputTokens", "answer", 3),
            (5, "message_delta", "outputTokens", " more", 7),
        ] {
            let mut chunk = json!({"type":kind,"stepId":"a","delta":delta});
            chunk[field] = json!(tokens);
            snapshot.apply(sequence, "r", &pending(chunk, "running")).unwrap();
        }
        assert_eq!(snapshot.live_chunks.len(), 3);
        assert_eq!(snapshot.live_chunks[1]["delta"], "think more");
        assert_eq!(snapshot.live_chunks[1]["thinkingTokens"], 12);
        assert_eq!(snapshot.live_chunks[2]["delta"], "answer more");
        assert_eq!(snapshot.live_chunks[2]["outputTokens"], 7);
    }
    #[test]
    fn retry_resets_only_the_current_attempt_and_terminal_clears_live_state() {
        let mut snapshot = snapshot();
        snapshot.apply(1, "r", &pending(json!({ "type":"run_started", "run":{"id":"r","sessionId":"s","status":"running"} }), "running")).unwrap();
        snapshot
            .apply(2, "r", &pending(step("a"), "running"))
            .unwrap();
        snapshot
            .apply(
                3,
                "r",
                &pending(
                    json!({ "type":"message_delta", "stepId":"a","delta":"old attempt" }),
                    "running",
                ),
            )
            .unwrap();
        snapshot
            .apply(
                4,
                "r",
                &pending(
                    json!({ "type":"retry_status", "stepId":"a","retry":{"phase":"waiting"} }),
                    "running",
                ),
            )
            .unwrap();
        snapshot
            .apply(
                5,
                "r",
                &pending(
                    json!({ "type":"message_delta", "stepId":"a","delta":"new" }),
                    "running",
                ),
            )
            .unwrap();
        snapshot
            .apply(
                6,
                "r",
                &pending(
                    json!({ "type":"message_delta", "stepId":"a","delta":" output" }),
                    "running",
                ),
            )
            .unwrap();
        assert!(
            !String::from_utf8(snapshot.encode().unwrap())
                .unwrap()
                .contains("old attempt")
        );
        assert_eq!(snapshot.live_chunks.last().unwrap()["delta"], "new output");
        snapshot
            .apply(7, "r", &pending(step("b"), "running"))
            .unwrap();
        assert_eq!(snapshot.completed_step_ids, vec!["a"]);
        snapshot.apply(8, "r", &pending(json!({ "type":"run_completed", "run":{"id":"r","sessionId":"s","status":"completed"} }), "completed")).unwrap();
        assert_eq!(snapshot.completed_step_ids, vec!["a", "b"]);
        assert!(snapshot.live_chunks.is_empty());
        assert!(snapshot.session["activeRunId"].is_null());
        assert_eq!(snapshot.run["status"], "completed");
    }
    #[test]
    fn seed_and_stream_reject_wrong_session_and_run_identity() {
        assert!(
            UiSnapshot::seed(
                "other",
                br#"{"id":"s","projectId":"p","status":"running","updatedAt":"now"}"#
            )
            .is_err()
        );
        let mut snapshot = snapshot();
        assert!(
            snapshot
                .apply(
                    1,
                    "r",
                    &pending(
                        json!({ "type":"run_started", "run":{"id":"wrong","sessionId":"s"} }),
                        "running"
                    )
                )
                .is_err()
        );
    }

    #[test]
    fn queue_mutations_are_bounded_ordered_and_force_inject_is_atomic() {
        let mut snapshot = snapshot();
        let first = json!({ "id":"inq_1", "message":"first", "enqueuedAt":"2026-10-16T00:00:00Z" });
        let second =
            json!({ "id":"inq_2", "message":"second", "enqueuedAt":"2026-10-16T00:00:01Z" });
        snapshot
            .queue_mutation("enqueue", &serde_json::to_vec(&first).unwrap())
            .unwrap();
        snapshot
            .queue_mutation("enqueue", &serde_json::to_vec(&second).unwrap())
            .unwrap();
        snapshot
            .queue_mutation("move", br#"{"id":"inq_2","toIndex":0}"#)
            .unwrap();
        assert_eq!(snapshot.queued_inputs[0]["id"], "inq_2");
        snapshot
            .queue_mutation("force", br#"{"id":"inq_1"}"#)
            .unwrap();
        assert_eq!(snapshot.force_inject_item_id.as_deref(), Some("inq_1"));
        snapshot
            .queue_mutation("consume", br#"{"id":"inq_1","runId":"r"}"#)
            .unwrap();
        assert!(snapshot.force_inject_item_id.is_none());
        assert_eq!(snapshot.queued_inputs.len(), 1);
        assert!(
            snapshot
                .queue_mutation("remove", br#"{"id":"missing"}"#)
                .is_err()
        );
    }
}
