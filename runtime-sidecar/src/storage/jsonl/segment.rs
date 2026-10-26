//! The UI projection as persistent collections.
//!
//! Semantics are `projection::UiSnapshot::apply`, carried over verbatim. The
//! containers are structurally shared: applying one event copies the path it
//! touches, not the session. A 768 KiB projection with a 200-chunk live step
//! therefore costs a few hundred bytes per delta, and the published value and
//! the writer's value share every untouched subtree.

use im::{HashMap, Vector};
use serde_json::{Map, Value, json};

use crate::runtime::actor::{PendingEvent, RuntimeError};

/// An immutable JSON value whose objects and arrays are persistent.
#[derive(Clone, Debug, PartialEq)]
pub enum PValue {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vector<PValue>),
    Object(PMap),
}

pub type PMap = HashMap<String, PValue>;

impl PValue {
    pub fn from_json(value: &Value) -> Self {
        match value {
            Value::Null => PValue::Null,
            Value::Bool(flag) => PValue::Bool(*flag),
            Value::Number(number) => PValue::Number(number.clone()),
            Value::String(text) => PValue::String(text.to_string()),
            Value::Array(items) => PValue::Array(items.iter().map(PValue::from_json).collect()),
            Value::Object(map) => PValue::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), PValue::from_json(value)))
                    .collect(),
            ),
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            PValue::Null => Value::Null,
            PValue::Bool(flag) => Value::Bool(*flag),
            PValue::Number(number) => Value::Number(number.clone()),
            PValue::String(text) => Value::String(text.clone()),
            PValue::Array(items) => Value::Array(items.iter().map(PValue::to_json).collect()),
            PValue::Object(map) => {
                let mut out = Map::with_capacity(map.len());
                for (key, value) in map.iter() {
                    out.insert(key.clone(), value.to_json());
                }
                Value::Object(out)
            }
        }
    }

    pub fn get(&self, key: &str) -> Option<&PValue> {
        match self {
            PValue::Object(map) => map.get(key),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            PValue::String(text) => Some(text.as_str()),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vector<PValue>> {
        match self {
            PValue::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut PValue> {
        match self {
            PValue::Object(map) => map.get_mut(key),
            _ => None,
        }
    }

    pub fn is_object(&self) -> bool {
        matches!(self, PValue::Object(_))
    }

    pub fn is_null(&self) -> bool {
        matches!(self, PValue::Null)
    }

    /// Copy-on-write insert into an object; a non-object is replaced.
    pub fn set(&mut self, key: &str, value: PValue) {
        match self {
            PValue::Object(map) => {
                map.insert(key.to_owned(), value);
            }
            _ => {
                let mut map = PMap::new();
                map.insert(key.to_owned(), value);
                *self = PValue::Object(map);
            }
        }
    }

    fn object() -> Self {
        PValue::Object(PMap::new())
    }
}

/// The projection; field-for-field the shape of `projection::UiSnapshot`.
#[derive(Clone, Debug, PartialEq)]
pub struct Projection {
    pub session: PValue,
    pub run: PValue,
    pub cursor: u64,
    pub live_chunks: Vector<PValue>,
    pub completed_step_ids: Vector<String>,
    pub queued_inputs: Vector<PValue>,
    pub force_inject_item_id: Option<String>,
    pub queue_revision: u64,
    pub pending_queue_input: Option<PValue>,
    pub pending_partial_message: Option<PValue>,
}

impl Default for Projection {
    fn default() -> Self {
        Self::from_snapshot(&crate::runtime::projection::UiSnapshot {
            session: serde_json::Value::Null,
            run: serde_json::Value::Null,
            cursor: 0,
            live_chunks: Vec::new(),
            completed_step_ids: Vec::new(),
            queued_inputs: Vec::new(),
            force_inject_item_id: None,
            queue_revision: 0,
            pending_queue_input: None,
            pending_partial_message: None,
        })
    }
}

impl Projection {
    /// Build from a decoded `UiSnapshot`.
    pub fn from_snapshot(snapshot: &crate::runtime::projection::UiSnapshot) -> Self {
        Self {
            session: PValue::from_json(&snapshot.session),
            run: PValue::from_json(&snapshot.run),
            cursor: snapshot.cursor,
            live_chunks: snapshot.live_chunks.iter().map(PValue::from_json).collect(),
            completed_step_ids: snapshot.completed_step_ids.iter().cloned().collect(),
            queued_inputs: snapshot
                .queued_inputs
                .iter()
                .map(PValue::from_json)
                .collect(),
            force_inject_item_id: snapshot.force_inject_item_id.clone(),
            queue_revision: snapshot.queue_revision,
            pending_queue_input: snapshot.pending_queue_input.as_ref().map(PValue::from_json),
            pending_partial_message: snapshot
                .pending_partial_message
                .as_ref()
                .map(PValue::from_json),
        }
    }

    /// Encode to the canonical bytes, enforcing the transport budget.
    pub fn encode(&self) -> Result<Vec<u8>, RuntimeError> {
        let json = self.to_json();
        let bytes = serde_json::to_vec(&json)
            .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))?;
        if bytes.len() > crate::runtime::projection::MAX_PROJECTION_BYTES {
            return Err(RuntimeError::ProjectionTooLarge);
        }
        Ok(bytes)
    }

    pub fn to_json(&self) -> Value {
        let mut out = Map::with_capacity(10);
        out.insert("session".into(), self.session.to_json());
        out.insert("run".into(), self.run.to_json());
        out.insert("cursor".into(), json!(self.cursor));
        out.insert(
            "liveChunks".into(),
            Value::Array(self.live_chunks.iter().map(PValue::to_json).collect()),
        );
        out.insert(
            "completedStepIds".into(),
            Value::Array(
                self.completed_step_ids
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
        out.insert(
            "queuedInputs".into(),
            Value::Array(self.queued_inputs.iter().map(PValue::to_json).collect()),
        );
        out.insert(
            "forceInjectItemId".into(),
            self.force_inject_item_id
                .as_ref()
                .map_or(Value::Null, |id| json!(id)),
        );
        out.insert("queueRevision".into(), json!(self.queue_revision));
        out.insert(
            "pendingQueueInput".into(),
            self.pending_queue_input
                .as_ref()
                .map_or(Value::Null, PValue::to_json),
        );
        if let Some(message) = &self.pending_partial_message {
            out.insert("pendingPartialMessage".into(), message.to_json());
        }
        Value::Object(out)
    }

    pub fn run_id(&self) -> Option<&str> {
        self.run.get("id").and_then(PValue::as_str)
    }

    pub fn partial_message(&mut self) -> Option<PValue> {
        self.pending_partial_message.take()
    }

    pub fn admitted(&mut self, run_id: &str) {
        if self.run_id() != Some(run_id) {
            self.run = PValue::Null;
            self.live_chunks.clear();
            self.completed_step_ids.clear();
            self.pending_partial_message = None;
        }
        self.session.set("pendingResumeToken", PValue::Null);
        self.session
            .set("activeRunId", PValue::String(run_id.to_owned()));
        self.session
            .set("status", PValue::String("queued".to_owned()));
        self.session.set("blockedReason", PValue::Null);
    }

    /// The queue fields mirrored into the projection (legacy field names).
    pub fn set_queue(&mut self, queue: &crate::runtime::input_queue::QueueState) {
        self.queued_inputs = queue.items.iter().map(PValue::from_json).collect();
        self.force_inject_item_id = queue.force_inject_item_id.clone();
        self.queue_revision = queue.revision;
        self.pending_queue_input = queue.delivery.as_ref().map(PValue::from_json);
        if self
            .session
            .get("sessionMetadata")
            .is_none_or(|value| !value.is_object())
        {
            self.session.set("sessionMetadata", PValue::object());
        }
        if let PValue::Object(metadata) = &mut self.session {
            if let Some(PValue::Object(inner)) = metadata.get_mut("sessionMetadata") {
                inner.insert(
                    "inputQueue".into(),
                    PValue::Array(self.queued_inputs.clone()),
                );
                inner.insert(
                    "inputForceInjectId".into(),
                    self.force_inject_item_id
                        .as_ref()
                        .map_or(PValue::Null, |id| PValue::String(id.clone())),
                );
            }
        }
    }

    /// The queue as the projection mirrors it.
    pub fn queue(&self) -> crate::runtime::input_queue::QueueState {
        crate::runtime::input_queue::QueueState {
            items: self.queued_inputs.iter().map(PValue::to_json).collect(),
            force_inject_item_id: self.force_inject_item_id.clone(),
            revision: self.queue_revision,
            consumed: None,
            delivery: self.pending_queue_input.as_ref().map(PValue::to_json),
        }
    }

    fn current_step(&self) -> Option<String> {
        self.live_chunks
            .iter()
            .next()
            .and_then(|chunk| chunk.get("step"))
            .and_then(|step| step.get("id"))
            .and_then(PValue::as_str)
            .map(str::to_owned)
    }

    fn partial_message_value(&self, run_id: &str, created_at: &str) -> Option<PValue> {
        let step_id = self.current_step()?;
        let mut content = String::new();
        let mut thought = String::new();
        for chunk in self.live_chunks.iter() {
            if chunk.get("type").and_then(PValue::as_str) == Some("message_delta")
                && chunk.get("stepId").and_then(PValue::as_str) == Some(step_id.as_str())
                && let Some(delta) = chunk.get("delta").and_then(PValue::as_str)
            {
                content.push_str(delta);
            }
        }
        for chunk in self.live_chunks.iter() {
            if chunk.get("type").and_then(PValue::as_str) == Some("thought_delta")
                && chunk.get("stepId").and_then(PValue::as_str) == Some(step_id.as_str())
                && let Some(delta) = chunk.get("delta").and_then(PValue::as_str)
            {
                thought.push_str(delta);
            }
        }
        if content.is_empty() && thought.is_empty() {
            return None;
        }
        let session_id = self
            .session
            .get("id")
            .map(PValue::to_json)
            .unwrap_or(Value::Null);
        Some(PValue::from_json(&json!({
            "id": format!("msg_partial_{run_id}_{step_id}"),
            "sessionId": session_id,
            "runId": run_id,
            "stepId": step_id,
            "role": "assistant",
            "content": content,
            "createdAt": created_at,
            "metadata": {"source": "runtime_partial", "partial": true, "runId": run_id, "stepId": step_id, "thought": thought},
        })))
    }

    pub(crate) fn take_partial_message(&mut self, run_id: &str, created_at: &str) -> Option<Value> {
        self.pending_partial_message
            .take()
            .or_else(|| self.partial_message_value(run_id, created_at))
            .map(|value| value.to_json())
    }

    fn complete_current(&mut self) {
        if let Some(id) = self.current_step() {
            if !self.completed_step_ids.contains(&id) {
                self.completed_step_ids.push_back(id);
            }
        }
        self.live_chunks.clear();
    }

    /// Apply one stream event. Mirrors `UiSnapshot::apply` branch for branch.
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
        let chunk = PValue::from_json(&payload["chunk"]);
        let state = PValue::from_json(&payload["state"]);
        let Some(kind) = chunk.get("type").and_then(PValue::as_str) else {
            return Err(RuntimeError::InvalidCommand("missing chunk type".into()));
        };
        let nullable_string = |value: Option<&PValue>| {
            value.is_some_and(|value| value.is_null() || value.as_str().is_some())
        };
        let session_id = self
            .session
            .get("id")
            .and_then(PValue::as_str)
            .map(str::to_owned);
        let matching_step = self
            .current_step()
            .is_some_and(|id| chunk.get("stepId").and_then(PValue::as_str) == Some(id.as_str()));
        if payload["schema"] != 1
            || kind != pending.kind
            || !state.is_object()
            || !state
                .get("status")
                .and_then(PValue::as_str)
                .is_some_and(crate::runtime::projection::is_valid_status)
            || state.get("updatedAt").and_then(PValue::as_str).is_none()
            || ["activeRunId", "blockedReason", "pendingResumeToken"]
                .iter()
                .any(|key| !nullable_string(state.get(key)))
            || state
                .get("activeRunId")
                .and_then(PValue::as_str)
                .is_some_and(|id| id != run_id)
            || chunk
                .get("runId")
                .and_then(PValue::as_str)
                .is_some_and(|id| id != run_id)
            || chunk
                .get("sessionId")
                .and_then(PValue::as_str)
                .is_some_and(|id| Some(id) != session_id.as_deref())
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
            let value = state.get(field).cloned().unwrap_or(PValue::Null);
            self.session.set(field, value);
        }
        if let Some(run) = chunk.get("run") {
            if run.get("id").and_then(PValue::as_str) != Some(run_id)
                || run.get("sessionId").and_then(PValue::as_str) != session_id.as_deref()
            {
                return Err(RuntimeError::InvalidCommand(
                    "event run identity mismatch".into(),
                ));
            }
            if self.run.get("id") != run.get("id") {
                self.live_chunks.clear();
                self.completed_step_ids.clear();
            }
            self.run = run.clone();
        }
        match kind {
            "execution_status" if self.run.get("id").and_then(PValue::as_str) == Some(run_id) => {
                if let Some(execution) = chunk.get("execution") {
                    self.run.set("execution", execution.clone());
                }
            }
            "step_started" => {
                let step_id = chunk
                    .get("step")
                    .and_then(|step| step.get("id"))
                    .and_then(PValue::as_str);
                let step_run = chunk
                    .get("step")
                    .and_then(|step| step.get("runId"))
                    .and_then(PValue::as_str);
                let step_session = chunk
                    .get("step")
                    .and_then(|step| step.get("sessionId"))
                    .and_then(PValue::as_str);
                if step_id.is_none()
                    || step_run != Some(run_id)
                    || step_session != session_id.as_deref()
                {
                    return Err(RuntimeError::InvalidCommand(
                        "step identity mismatch".into(),
                    ));
                }
                if self.current_step().as_deref() != step_id {
                    self.complete_current();
                }
                self.live_chunks = Vector::unit(chunk.clone());
            }
            "retry_status" if matching_step => {
                let phase = chunk
                    .get("retry")
                    .and_then(|retry| retry.get("phase"))
                    .and_then(PValue::as_str);
                if matches!(phase, Some("waiting" | "group_wait")) {
                    self.live_chunks.truncate(1);
                }
                self.live_chunks.push_back(chunk.clone());
            }
            "message_delta" | "thought_delta" if matching_step => {
                let Some(delta) = chunk.get("delta").and_then(PValue::as_str) else {
                    return Err(RuntimeError::InvalidCommand("invalid delta".into()));
                };
                let merge = self.live_chunks.back().is_some_and(|last| {
                    last.get("type") == chunk.get("type")
                        && last.get("stepId") == chunk.get("stepId")
                });
                if merge {
                    let last = self.live_chunks.back_mut().expect("checked above");
                    let mut text = last
                        .get("delta")
                        .and_then(PValue::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    text.push_str(delta);
                    last.set("delta", PValue::String(text));
                    for field in ["outputTokens", "thinkingTokens"] {
                        if let Some(value) = chunk.get(field) {
                            last.set(field, value.clone());
                        }
                    }
                } else {
                    self.live_chunks.push_back(chunk.clone());
                }
            }
            "tool_call" | "tool_result" if matching_step => {
                let id = chunk.get("toolCall").and_then(|call| call.get("id"));
                let existing = self.live_chunks.iter().position(|entry| {
                    entry.get("type") == chunk.get("type")
                        && entry.get("toolCall").and_then(|call| call.get("id")) == id
                });
                if let Some(index) = existing {
                    self.live_chunks.set(index, chunk.clone());
                } else {
                    self.live_chunks.push_back(chunk.clone());
                }
            }
            "message"
                if chunk
                    .get("message")
                    .and_then(|message| message.get("role"))
                    .and_then(PValue::as_str)
                    == Some("assistant")
                    && (self.current_step().as_deref()
                        == chunk
                            .get("message")
                            .and_then(|message| message.get("stepId"))
                            .and_then(PValue::as_str)
                        || self
                            .pending_partial_message
                            .as_ref()
                            .is_some_and(|message| {
                                message.get("stepId")
                                    == chunk
                                        .get("message")
                                        .and_then(|message| message.get("stepId"))
                            })) =>
            {
                self.pending_partial_message = None;
                self.complete_current();
            }
            _ => {}
        }
        let status = state
            .get("status")
            .and_then(PValue::as_str)
            .unwrap_or_default();
        if matches!(status, "interrupted" | "cancelled" | "failed" | "paused")
            && kind != "run_finished"
            && self.pending_partial_message.is_none()
        {
            let updated_at = state
                .get("updatedAt")
                .and_then(PValue::as_str)
                .unwrap_or_default()
                .to_owned();
            self.pending_partial_message = self.partial_message_value(run_id, &updated_at);
        }
        if !matches!(
            status,
            "running" | "queued" | "waiting_permission" | "waiting_input" | "stopping"
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
    use crate::runtime::projection::UiSnapshot;

    fn pending(chunk: Value, status: &str) -> PendingEvent {
        PendingEvent {
            kind: chunk["type"].as_str().unwrap().to_owned(),
            payload: serde_json::to_vec(&json!({
                "schema": 1,
                "chunk": chunk,
                "state": {
                    "status": status,
                    "activeRunId": if status == "completed" { Value::Null } else { json!("r") },
                    "blockedReason": null,
                    "pendingResumeToken": null,
                    "updatedAt": "2026-10-16"
                }
            }))
            .unwrap(),
        }
    }

    fn seed() -> UiSnapshot {
        UiSnapshot::seed(
            "s",
            br#"{"id":"s","projectId":"p","status":"queued","updatedAt":"2026-10-16"}"#,
        )
        .unwrap()
    }

    fn step(id: &str) -> Value {
        json!({"type":"step_started","step":{"id":id,"sessionId":"s","runId":"r","index":1}})
    }

    /// Every branch of `apply` must produce exactly the canonical snapshot.
    #[test]
    fn persistent_projection_matches_the_canonical_snapshot_apply() {
        let events = vec![
            (
                json!({"type":"run_started","run":{"id":"r","sessionId":"s","status":"running"}}),
                "running",
            ),
            (step("a"), "running"),
            (
                json!({"type":"message_delta","stepId":"a","delta":"one","outputTokens":3}),
                "running",
            ),
            (
                json!({"type":"message_delta","stepId":"a","delta":" two","outputTokens":9}),
                "running",
            ),
            (
                json!({"type":"thought_delta","stepId":"a","delta":"hmm","thinkingTokens":5}),
                "running",
            ),
            (
                json!({"type":"tool_call","stepId":"a","toolCall":{"id":"t","sessionId":"s"}}),
                "running",
            ),
            (
                json!({"type":"retry_status","stepId":"a","retry":{"phase":"waiting"}}),
                "running",
            ),
            (
                json!({"type":"message_delta","stepId":"a","delta":"again"}),
                "running",
            ),
            (
                json!({"type":"message","message":{"role":"assistant","stepId":"a","content":"x"}}),
                "running",
            ),
            (step("b"), "running"),
            (
                json!({"type":"message_delta","stepId":"b","delta":"partial"}),
                "interrupted",
            ),
            (
                json!({"type":"run_finished","run":{"id":"r","sessionId":"s","status":"completed"}}),
                "completed",
            ),
        ];
        let mut canonical = seed();
        let mut persistent = Projection::from_snapshot(&canonical);
        for (index, (chunk, status)) in events.into_iter().enumerate() {
            let event = pending(chunk, status);
            let sequence = index as u64 + 1;
            canonical.apply(sequence, "r", &event).unwrap();
            persistent.apply(sequence, "r", &event).unwrap();
            assert_eq!(
                persistent.to_json(),
                serde_json::to_value(&canonical).unwrap(),
                "after event {sequence}"
            );
        }
        let bytes = persistent.encode().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            serde_json::to_value(&canonical).unwrap()
        );
    }

    #[test]
    fn an_applied_delta_shares_structure_with_its_predecessor() {
        let mut projection = Projection::from_snapshot(&seed());
        projection
            .apply(1, "r", &pending(step("a"), "running"))
            .unwrap();
        for sequence in 2..202u64 {
            projection
                .apply(sequence, "r", &pending(json!({"type":"tool_call","stepId":"a","toolCall":{"id":format!("t{sequence}")}}), "running"))
                .unwrap();
        }
        let before = projection.clone();
        projection
            .apply(
                202,
                "r",
                &pending(
                    json!({"type":"message_delta","stepId":"a","delta":"tail"}),
                    "running",
                ),
            )
            .unwrap();
        // The 200 prior chunks are shared, not copied.
        assert!(std::ptr::eq(
            before.live_chunks.get(0).unwrap(),
            projection.live_chunks.get(0).unwrap()
        ));
        assert_eq!(projection.live_chunks.len(), 202);
    }

    #[test]
    fn identity_mismatch_is_rejected() {
        let mut projection = Projection::from_snapshot(&seed());
        let mut event = pending(step("a"), "running");
        event.kind = "other".into();
        assert!(projection.apply(1, "r", &event).is_err());
    }
}
