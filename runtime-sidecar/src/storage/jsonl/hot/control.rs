//! Control commands: execution leases, history restore, permissions,
//! interactions, stop/resume, run and session patches.
//!
//! Ported from the RocksDB implementation operation for operation. Every write
//! operation produces exactly one event and bumps the revision; the durable
//! receipt is written in the same batch, so a retry after a lost ack returns
//! the original result instead of applying the change twice.

use serde_json::{Value, json};

use crate::runtime::actor::{ControlCommandReceipt, PendingEvent, RuntimeError, StreamEvent};
use crate::runtime::execution::ExecutionLease;
use crate::runtime::input_queue::QueueState;
use crate::storage::jsonl::segment::{PValue, Projection};
use crate::runtime::session_types::QueueMutationReceipt;

use super::ops::{hash, parse_json, required_string, set_projection_state, value_to_bytes};
use super::super::session::state::Tx;
use super::super::session::{SessionActor, SessionHandle};
use super::ops::{ensure_epoch, ensure_revision, snapshot_of};

/// Control operations that answer from live state and own no receipt.
pub const RECEIPT_FREE: [&str; 2] = ["read", "execution_check"];

const MAX_REQUEST_BYTES: usize = 512 * 1024;

fn to_value(value: &impl serde::Serialize) -> Result<Value, RuntimeError> {
    serde_json::to_value(value).map_err(|error| RuntimeError::InvalidCommand(error.to_string()))
}

fn from_value<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, RuntimeError> {
    serde_json::from_value(value).map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

impl SessionHandle {
    pub fn control(
        &self,
        request_id: &str,
        epoch: u64,
        revision: u64,
        operation: &str,
        payload: &[u8],
    ) -> Result<ControlCommandReceipt, RuntimeError> {
        if request_id.is_empty()
            || request_id.len() > 256
            || operation.is_empty()
            || operation.len() > 64
            || payload.len() > MAX_REQUEST_BYTES
        {
            return Err(RuntimeError::InvalidCommand("control command exceeds bounds".into()));
        }
        let value = parse_json(payload)?;
        let mut actor = self.actor.lock();
        if RECEIPT_FREE.contains(&operation) {
            return actor.read_only_control(&self.id, operation, epoch, revision, &value);
        }
        actor.control_write(&self.id, request_id, epoch, revision, operation, &value)
    }
}

impl SessionActor {
    pub fn read_only_control(
        &self,
        session_id: &str,
        operation: &str,
        epoch: u64,
        revision: u64,
        value: &Value,
    ) -> Result<ControlCommandReceipt, RuntimeError> {
        if operation == "read" {
            ensure_epoch(&self.state, epoch)?;
            ensure_revision(&self.state, revision)?;
        }
        let state_json = match operation {
            "execution_check" => {
                let expected = ExecutionLease::decode(session_id, value)?;
                expected.assert_current(self.state.active_run_id.as_deref(), self.control.execution_lease.as_ref())?;
                value_to_bytes(&json!({"executionLease": self.control.execution_lease}))?
            }
            "read" => value_to_bytes(&to_value(&self.control).map_err(|error| RuntimeError::InvalidCommand(error.to_string()))?)?,
            other => {
                return Err(RuntimeError::InvalidCommand(format!(
                    "control operation {other} is not receipt-free"
                )));
            }
        };
        Ok(ControlCommandReceipt {
            state_json,
            snapshot: snapshot_of(&self.state, session_id),
            event: None,
            reused: false,
        })
    }

    pub fn control_write(
        &mut self,
        session_id: &str,
        request_id: &str,
        epoch: u64,
        revision: u64,
        operation: &str,
        value: &Value,
    ) -> Result<ControlCommandReceipt, RuntimeError> {
        let identity = hash(&("control.v1", operation, value))?;
        if let Some(saved) = self.receipt("control", request_id) {
            if saved.fingerprint != identity {
                return Err(RuntimeError::RequestConflict);
            }
            let mut result: ControlCommandReceipt = serde_json::from_value(saved.result.clone())
                .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))?;
            result.reused = true;
            return Ok(result);
        }
        ensure_epoch(&self.state, epoch)?;
        ensure_revision(&self.state, revision)?;
        let mut control = self.control.clone();
        let mut projection = self.projection.clone().ok_or(RuntimeError::ProjectionMissing)?;
        let now = now_iso();
        let mut entity: Option<(&'static str, Value)> = None;
        let mut event_run_id = projection.session.get("activeRunId").and_then(PValue::as_str).unwrap_or_default().to_owned();
        let mut epoch_next = self.state.epoch;
        let mut history_generation = self.state.history_generation;
        let mut active_run_id = self.state.active_run_id.clone();
        let mut clear_queue = false;
        let event_name: &str;

        match operation {
            "execution_open" | "execution_close" => {
                let mut lease = ExecutionLease::decode(session_id, value)?;
                if projection.run_id() != Some(lease.run_id.as_str()) {
                    return Err(lease.superseded("projected run replaced"));
                }
                if operation == "execution_open" {
                    if self.state.active_run_id.as_deref() != Some(lease.run_id.as_str()) {
                        return Err(lease.superseded("run finished or replaced"));
                    }
                    if control.runtime_control.is_some() {
                        return Err(lease.superseded("execution is stopping"));
                    }
                    if control
                        .execution_lease
                        .as_ref()
                        .is_some_and(|current| !current.closed && !current.same_owner(&lease))
                    {
                        return Err(lease.superseded("another executor owns the run"));
                    }
                    if control
                        .execution_lease
                        .as_ref()
                        .is_some_and(|current| current.closed && current.same_owner(&lease))
                    {
                        return Err(lease.superseded("closed generation cannot be reopened"));
                    }
                } else if !control
                    .execution_lease
                    .as_ref()
                    .is_some_and(|current| current.same_owner(&lease))
                {
                    return Err(lease.superseded("owner changed before close"));
                } else {
                    lease.closed = true;
                }
                event_run_id = lease.run_id.clone();
                if !projection.run.get("metadata").is_some_and(PValue::is_object) {
                    projection.run.set("metadata", PValue::from_json(&json!({})));
                }
                if let PValue::Object(metadata) = &mut projection.run
                    && let Some(PValue::Object(meta)) = metadata.get_mut("metadata")
                {
                    meta.insert("executionLease".into(), PValue::from_json(&to_value(&lease).map_err(|error| RuntimeError::InvalidCommand(error.to_string()))?));
                }
                control.execution_lease = Some(lease);
                event_name = "run_updated";
            }
            "history_begin" => {
                if active_run_id.is_some() || control.runtime_control.is_some() {
                    return Err(RuntimeError::SessionBusy);
                }
                let marker = json!({"state":"stopping","historyRequestId":value["historyRequestId"],"previousStatus":projection.session.get("status").map(PValue::to_json),"reason":"Restoring history"});
                control.runtime_control = Some(marker);
                set_session_metadata(&mut projection, "runtimeControl", control.runtime_control.clone().unwrap_or(Value::Null));
                set_projection_state(&mut projection, "stopping", None, None, Some("Restoring history"), &now);
                event_name = "history_restore_started";
            }
            "history_end" | "history_cancel" => {
                let marker = control
                    .runtime_control
                    .as_ref()
                    .ok_or_else(|| RuntimeError::InvalidCommand("history restore is not active".into()))?;
                if marker["historyRequestId"] != value["historyRequestId"] {
                    return Err(RuntimeError::RequestConflict);
                }
                let prior = marker["previousStatus"].as_str().unwrap_or("completed").to_owned();
                if operation == "history_end" {
                    epoch_next = epoch_next.checked_add(1).ok_or_else(|| RuntimeError::InvalidCommand("epoch overflow".into()))?;
                    history_generation = history_generation
                        .checked_add(1)
                        .ok_or_else(|| RuntimeError::InvalidCommand("history generation overflow".into()))?;
                    active_run_id = None;
                    control.permissions.clear();
                    control.interactions.clear();
                    control.execution_lease = None;
                    projection.run = PValue::Null;
                    projection.live_chunks.clear();
                    projection.completed_step_ids.clear();
                    clear_queue = true;
                    for key in ["prompt", "contextSnapshotId"] {
                        if let Some(field) = value["historyFields"].get(key) {
                            projection.session.set(key, PValue::from_json(field));
                        }
                    }
                    if let Some(fields) = value["historyFields"]["sessionMetadata"].as_object() {
                        for (key, field) in fields {
                            set_session_metadata(&mut projection, key, field.clone());
                        }
                    }
                    projection.session.set("completedAt", PValue::Null);
                    projection.session.set("resultSummary", PValue::Null);
                    set_session_metadata(&mut projection, "lastHistoryRestore", value["historyRequestId"].clone());
                }
                control.runtime_control = None;
                set_session_metadata(&mut projection, "runtimeControl", Value::Null);
                set_projection_state(
                    &mut projection,
                    if operation == "history_end" { "completed" } else { &prior },
                    None,
                    None,
                    None,
                    &now,
                );
                event_name = "history_restored";
            }
            "permission_request" => {
                let id = value["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| RuntimeError::InvalidCommand("permission id is required".into()))?;
                if control.permissions.iter().any(|item| item["id"].as_str() == Some(id)) {
                    return Err(RuntimeError::RequestConflict);
                }
                let mut item = value.clone();
                if item["createdAt"].is_null() {
                    item["createdAt"] = json!(now);
                }
                if item["resolvedAt"].is_null() {
                    item["resolvedAt"] = Value::Null;
                }
                control.permissions.push(item.clone());
                entity = Some(("permission", item.clone()));
                event_run_id = item["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                if item["action"] == "ask" && item["resolvedAt"].is_null() {
                    let reason = item["reason"].as_str().unwrap_or("Permission required");
                    set_projection_state(
                        &mut projection,
                        "waiting_permission",
                        Some(&event_run_id),
                        item["resumeToken"].as_str(),
                        Some(reason),
                        &now,
                    );
                }
                event_name = "permission_requested";
            }
            "permission_expire" => {
                let id = required_string(value, "id")?;
                let item = control.permissions.iter_mut().find(|item| item["id"].as_str() == Some(id))
                    .ok_or_else(|| RuntimeError::InvalidCommand("permission was not found".into()))?;
                item["action"] = json!("deny");
                item["resolvedAt"] = json!(now);
                item["resumeToken"] = Value::Null;
                item["reason"] = json!("运行已中断，原权限请求已失效。");
                event_run_id = item["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                entity = Some(("permission", item.clone()));
                event_name = "permission_resolved";
            }
            "permission_reply" => {
                let id = required_string(value, "id")?;
                let reply = required_string(value, "reply")?;
                let item = control
                    .permissions
                    .iter_mut()
                    .find(|item| item["id"].as_str() == Some(id))
                    .ok_or_else(|| RuntimeError::InvalidCommand("permission was not found".into()))?;
                if item["resolvedAt"].is_string() {
                    if item["userReply"].as_str() == Some(reply) {
                        return Err(RuntimeError::RequestConflict);
                    }
                    return Err(RuntimeError::InvalidCommand("permission was already resolved".into()));
                }
                let action = if reply == "reject" { "deny" } else { "allow" };
                item["userReply"] = json!(reply);
                item["action"] = json!(action);
                item["resolvedAt"] = json!(now);
                if let Some(message) = value["message"].as_str() {
                    item["reason"] = json!(format!("{} {}", item["reason"].as_str().unwrap_or_default(), message));
                }
                event_run_id = item["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                let resume = item["resumeToken"].as_str();
                if action == "allow" && resume.is_some() {
                    set_projection_state(&mut projection, "running", Some(&event_run_id), None, None, &now);
                    projection.session.set("completedAt", PValue::Null);
                    projection.session.set("resultSummary", PValue::Null);
                } else {
                    let reason = item["reason"].as_str().unwrap_or("Permission denied").to_owned();
                    set_projection_state(&mut projection, "completed", None, None, Some(&reason), &now);
                    projection.session.set("completedAt", PValue::String(now.clone()));
                    projection.session.set("resultSummary", PValue::String(reason.clone()));
                    deny_deny(&mut projection, item, &event_run_id, &reason, &now);
                }
                entity = Some(("permission", item.clone()));
                event_name = "permission_resolved";
            }
            "interaction_request" => {
                let id = required_string(value, "id")?;
                if control.interactions.iter().any(|item| item["id"].as_str() == Some(id)) {
                    return Err(RuntimeError::RequestConflict);
                }
                let mut item = value.clone();
                if item["status"].is_null() {
                    item["status"] = json!("pending");
                }
                if item["createdAt"].is_null() {
                    item["createdAt"] = json!(now);
                }
                control.interactions.push(item.clone());
                entity = Some(("interaction", item.clone()));
                event_run_id = item["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                let title = item["request"]["title"].as_str().unwrap_or("Input required");
                set_projection_state(
                    &mut projection,
                    "waiting_input",
                    Some(&event_run_id),
                    Some(&format!("interaction:{id}")),
                    Some(title),
                    &now,
                );
                event_name = "interaction_requested";
            }
            "interaction_reply" => {
                let id = required_string(value, "id")?;
                let reply = value.get("reply").cloned().unwrap_or(Value::Null);
                let item = control
                    .interactions
                    .iter_mut()
                    .find(|item| item["id"].as_str() == Some(id))
                    .ok_or_else(|| RuntimeError::InvalidCommand("interaction was not found".into()))?;
                if item["status"] != "pending" {
                    if item["response"] == reply {
                        return Err(RuntimeError::RequestConflict);
                    }
                    return Err(RuntimeError::InvalidCommand("interaction was already resolved".into()));
                }
                if let Some(expected) = value["revision"].as_u64()
                    && item["revision"].as_u64() != Some(expected)
                {
                    return Err(RuntimeError::RevisionConflict {
                        expected,
                        actual: item["revision"].as_u64().unwrap_or_default(),
                    });
                }
                let status = if reply["action"] == "cancel" { "cancelled" } else { "answered" };
                item["status"] = json!(status);
                item["response"] = reply;
                item["resolvedAt"] = json!(now);
                event_run_id = item["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                entity = Some(("interaction", item.clone()));
                event_name = "interaction_resolved";
            }
            "interaction_consume" | "interaction_cancel" => {
                let id = required_string(value, "id")?;
                let item = control
                    .interactions
                    .iter_mut()
                    .find(|item| item["id"].as_str() == Some(id))
                    .ok_or_else(|| RuntimeError::InvalidCommand("interaction was not found".into()))?;
                item["consumedAt"] = json!(now);
                if operation == "interaction_cancel" {
                    item["status"] = json!("cancelled");
                    item["resolvedAt"] = json!(now);
                }
                entity = Some(("interaction", item.clone()));
                event_run_id = item["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                if operation == "interaction_consume" {
                    set_projection_state(&mut projection, "running", Some(&event_run_id), None, None, &now);
                }
                event_name = if operation == "interaction_consume" {
                    "interaction_consumed"
                } else {
                    "interaction_cancelled"
                };
            }
            "stop_begin" | "stop_unconfirmed" => {
                let run_id = value["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                let control_state = if operation == "stop_begin" { "stopping" } else { "unconfirmed" };
                control.runtime_control = Some(json!({"state":control_state,"runId":run_id,"reason":value["reason"],"updatedAt":now}));
                set_projection_state(&mut projection, "stopping", Some(&run_id), None, value["reason"].as_str(), &now);
                event_run_id = run_id;
                event_name = operation;
            }
            "stop_ack" => {
                control.runtime_control = None;
                event_run_id = value["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                set_projection_state(&mut projection, "interrupted", None, None, value["reason"].as_str(), &now);
                event_name = "stop_acknowledged";
            }
            "resume" => {
                control.runtime_control = None;
                event_run_id = value["runId"].as_str().unwrap_or(&event_run_id).to_owned();
                set_projection_state(&mut projection, "running", Some(&event_run_id), None, None, &now);
                event_name = "run_resumed";
            }
            "lease_open" | "lease_close" => {
                let lease_id = required_string(value, "leaseId")?;
                control.process_leases.retain(|item| item["leaseId"].as_str() != Some(lease_id));
                if operation == "lease_open" {
                    control.process_leases.push(value.clone());
                }
                event_name = operation;
            }
            "run_patch" => {
                let run_id = required_string(value, "runId")?;
                let patch = value["patch"]
                    .as_object()
                    .ok_or_else(|| RuntimeError::InvalidCommand("run patch must be an object".into()))?;
                if projection.run_id() != Some(run_id) {
                    return Err(RuntimeError::InvalidCommand("run patch does not target the projected run".into()));
                }
                for key in patch.keys() {
                    if !matches!(
                        key.as_str(),
                        "status" | "currentStep" | "completedAt" | "stopReason" | "triggerMessageId" | "metadata" | "model"
                    ) {
                        return Err(RuntimeError::InvalidCommand(format!("run field cannot be patched: {key}")));
                    }
                }
                let PValue::Object(target) = &mut projection.run else {
                    return Err(RuntimeError::InvalidCommand("projected run is not an object".into()));
                };
                for (key, patch_value) in patch {
                    if key == "metadata"
                        && target.get(key).is_some_and(PValue::is_object)
                        && patch_value.is_object()
                    {
                        if let (Some(PValue::Object(metadata)), Some(nested)) = (target.get_mut(key), patch_value.as_object()) {
                            for (nested_key, nested_value) in nested {
                                metadata.insert(nested_key.clone(), PValue::from_json(nested_value));
                            }
                        }
                    } else {
                        target.insert(key.clone(), PValue::from_json(patch_value));
                    }
                }
                event_run_id = run_id.to_owned();
                event_name = "run_updated";
            }
            "session_patch" => {
                let patch = value["patch"]
                    .as_object()
                    .ok_or_else(|| RuntimeError::InvalidCommand("session patch must be an object".into()))?;
                for (key, patch_value) in patch {
                    match key.as_str() {
                        "title" | "prompt" | "contextSnapshotId" | "profileId" | "nodeId" | "reasoningEffort"
                        | "childSessionIds" | "skillIds" | "mcpServerIds" | "permissionRules" | "pinned" | "mode"
                        | "status" | "activeRunId" | "completedAt" | "updatedAt" | "archivedAt" | "archiveBatchId"
                        | "resultSummary" | "blockedReason" | "pendingResumeToken" => {
                            if key == "status" && !patch_value.as_str().is_some_and(crate::runtime::projection::is_valid_status) {
                                return Err(RuntimeError::InvalidCommand("invalid session status patch".into()));
                            }
                            projection.session.set(key, PValue::from_json(patch_value));
                        }
                        "sessionMetadata" => {
                            let source = patch_value
                                .as_object()
                                .ok_or_else(|| RuntimeError::InvalidCommand("sessionMetadata patch must be an object".into()))?;
                            for (nested_key, nested_value) in source {
                                set_session_metadata(&mut projection, nested_key, nested_value.clone());
                            }
                        }
                        _ => {
                            return Err(RuntimeError::InvalidCommand(format!("session field cannot be patched: {key}")));
                        }
                    }
                }
                if let Some(active) = patch.get("activeRunId") {
                    active_run_id = active.as_str().map(str::to_owned);
                    // The event identity must describe the value written by
                    // this patch. Legacy callers can patch activeRunId before
                    // the run admission event reaches the sidecar; keeping
                    // the previous identity makes Projection::apply reject
                    // the otherwise valid session update.
                    event_run_id = active.as_str().unwrap_or_default().to_owned();
                }
                event_name = "session_updated";
            }
            _ => {
                return Err(RuntimeError::InvalidCommand(format!("unknown control operation: {operation}")));
            }
        }

        let cursor = self.state.cursor + 1;
        control
            .permissions
            .retain(|item| item["action"] == "ask" && item["resolvedAt"].is_null());
        control.interactions.retain(|item| {
            item["consumedAt"].is_null() && (item["status"] == "pending" || !item["response"].is_null())
        });
        if clear_queue {
            let queue = QueueState::default();
            projection.set_queue(&queue);
        }
        let mut payload = json!({
            "schema": 1,
            "chunk": {"type": event_name, "sessionId": session_id, "runId": event_run_id, "control": control.clone()},
            "state": {
                "status": projection.session.get("status").map(PValue::to_json),
                "activeRunId": projection.session.get("activeRunId").map(PValue::to_json),
                "pendingResumeToken": projection.session.get("pendingResumeToken").map(PValue::to_json),
                "blockedReason": projection.session.get("blockedReason").map(PValue::to_json),
                "updatedAt": projection.session.get("updatedAt").map(PValue::to_json)
            }
        });
        let mut result_state = to_value(&control).map_err(|error| RuntimeError::InvalidCommand(error.to_string()))?;
        if let Some((field, value)) = &entity {
            payload["chunk"][*field] = value.clone();
            result_state["entity"] = value.clone();
            result_state["entityKind"] = Value::String((*field).to_owned());
        }
        let event = StreamEvent {
            sequence: cursor,
            run_id: event_run_id.clone(),
            kind: event_name.to_owned(),
            payload: value_to_bytes(&payload)?,
            ephemeral: false,
        };
        projection.apply(cursor, &event_run_id, &PendingEvent { kind: event.kind.clone(), payload: event.payload.clone() })?;
        let mut tx = Tx {
            cursor,
            revision: self.state.revision + 1,
            epoch: epoch_next,
            projection,
            control: Some(control.clone()),
            ..Default::default()
        };
        let result = ControlCommandReceipt {
            state_json: value_to_bytes(&result_state)?,
            snapshot: crate::runtime::actor::SessionSnapshot {
                session_id: session_id.to_owned(),
                epoch: epoch_next,
                revision: self.state.revision + 1,
                active_run_id,
                cursor,
                retained_from: cursor.saturating_sub(super::super::session::EVENT_WINDOW) + 1,
            },
            event: Some(event.clone()),
            reused: false,
        };
        tx.events.push(event.clone());
        tx.fan_out.push(event);
        tx.header = Some(tx.projection.session.clone());
        tx.receipt = Some((
            "control".into(),
            request_id.to_owned(),
            identity,
            to_value(&result).map_err(|error| RuntimeError::InvalidCommand(error.to_string()))?,
        ));
        let _ = history_generation;
        if tx.queue.is_none() {
            tx.queue = Some(tx.projection.queue());
        }
        let handle = self.this();
        self.write(&handle, tx)?;
        Ok(result)
    }
}

fn deny_deny(projection: &mut Projection, item: &Value, run_id: &str, reason: &str, now: &str) {
    if projection.run_id() == Some(run_id) {
        projection.run.set("status", PValue::String("blocked".into()));
        projection.run.set("completedAt", PValue::String(now.to_owned()));
        projection.run.set("stopReason", PValue::String(reason.to_owned()));
        if let PValue::Object(run) = &mut projection.run {
            if let Some(PValue::Object(metadata)) = run.get_mut("metadata")
                && let Some(PValue::Object(lease)) = metadata.get_mut("executionLease")
            {
                lease.insert("closed".into(), PValue::Bool(true));
            }
        }
    }
    let tool_call_id = item["toolCallId"].as_str();
    for chunk in projection.live_chunks.iter_mut() {
        let kind = chunk.get("type").and_then(PValue::as_str);
        if matches!(kind, Some("tool_call" | "tool_result"))
            && chunk.get("toolCall").and_then(|call| call.get("id")).and_then(PValue::as_str) == tool_call_id
            && let Some(PValue::Object(call)) = chunk.get_mut("toolCall")
        {
            call.insert("status".into(), PValue::String("denied".into()));
            call.insert("endedAt".into(), PValue::String(now.to_owned()));
            call.insert("error".into(), PValue::String(reason.to_owned()));
        }
    }
}

fn set_session_metadata(projection: &mut Projection, key: &str, value: Value) {
    if !projection.session.get("sessionMetadata").is_some_and(PValue::is_object) {
        projection.session.set("sessionMetadata", PValue::from_json(&json!({})));
    }
    if let PValue::Object(session) = &mut projection.session
        && let Some(PValue::Object(metadata)) = session.get_mut("sessionMetadata")
    {
        metadata.insert(key.to_owned(), PValue::from_json(&value));
    }
}

impl SessionActor {
    /// Mutate the queued inputs. A change emits one `input_queue_changed`
    /// event and bumps the revision; an unchanged command only stores its
    /// receipt.
    pub fn queue_mutation(
        &mut self,
        handle: &SessionHandle,
        request_id: &str,
        epoch: u64,
        revision: u64,
        operation: &str,
        payload: &[u8],
    ) -> Result<QueueMutationReceipt, RuntimeError> {
        if request_id.is_empty()
            || request_id.len() > 256
            || operation.len() > 32
            || payload.len() > MAX_REQUEST_BYTES
        {
            return Err(RuntimeError::InvalidCommand("queue command exceeds bounds".into()));
        }
        let value = parse_json(payload)?;
        let identity = hash(&("queue.v1", operation, &value))?;
        if let Some(saved) = self.receipt("queue", request_id) {
            if saved.fingerprint != identity {
                return Err(RuntimeError::RequestConflict);
            }
            let mut result: QueueMutationReceipt = serde_json::from_value(saved.result.clone())
                .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))?;
            result.reused = true;
            return Ok(result);
        }
        ensure_epoch(&self.state, epoch)?;
        ensure_revision(&self.state, revision)?;
        if operation == "consume" {
            let run = value["runId"]
                .as_str()
                .ok_or_else(|| RuntimeError::InvalidCommand("consumption requires active run".into()))?;
            if self.state.active_run_id.as_deref() != Some(run) {
                return Err(RuntimeError::InvalidCommand("input consumer is not active run".into()));
            }
        }
        let mut projection = self.projection.clone().ok_or(RuntimeError::ProjectionMissing)?;
        if operation == "consume" && projection.force_inject_item_id.as_deref() != value["id"].as_str() {
            return Err(RuntimeError::InvalidCommand("forced input changed before consumption".into()));
        }
        let mut queue = projection.queue();
        let changed = queue.apply(operation, &value)?;
        projection.set_queue(&queue);
        let mut tx = Tx {
            cursor: self.state.cursor,
            revision: self.state.revision,
            epoch: self.state.epoch,
            projection,
            queue: Some(queue.clone()),
            ..Default::default()
        };
        let mut event = None;
        if changed {
            tx.cursor += 1;
            tx.revision += 1;
            let run_id = tx.projection.session.get("activeRunId").and_then(PValue::as_str).unwrap_or_default().to_owned();
            let body = json!({"schema":1,
                "chunk":{"type":"input_queue_changed","sessionId":self.id,"queueSize":queue.items.len(),"forceInjectItemId":queue.force_inject_item_id,"queueRevision":queue.revision},
                "state":{"status":tx.projection.session.get("status").map(PValue::to_json),"activeRunId":tx.projection.session.get("activeRunId").map(PValue::to_json),"pendingResumeToken":tx.projection.session.get("pendingResumeToken").map(PValue::to_json),"blockedReason":tx.projection.session.get("blockedReason").map(PValue::to_json),"updatedAt":tx.projection.session.get("updatedAt").map(PValue::to_json)}
            });
            let pending = PendingEvent { kind: "input_queue_changed".into(), payload: value_to_bytes(&body)? };
            tx.projection.apply(tx.cursor, &run_id, &pending)?;
            let record = StreamEvent {
                sequence: tx.cursor,
                run_id,
                kind: pending.kind,
                payload: pending.payload,
                ephemeral: false,
            };
            event = Some(record.clone());
            tx.events.push(record.clone());
            tx.fan_out.push(record);
            tx.header = Some(tx.projection.session.clone());
        }
        let result = QueueMutationReceipt {
            queue,
            snapshot: crate::runtime::actor::SessionSnapshot {
                session_id: self.id.clone(),
                epoch: tx.epoch,
                revision: tx.revision,
                active_run_id: self.state.active_run_id.clone(),
                cursor: tx.cursor,
                retained_from: self.state.retained_from,
            },
            event,
            reused: false,
        };
        tx.receipt = Some((
            "queue".into(),
            request_id.to_owned(),
            identity,
            serde_json::to_value(&result).map_err(|error| RuntimeError::InvalidCommand(error.to_string()))?,
        ));
        self.write(handle, tx)?;
        Ok(result)
    }
}
