//! Session-local compaction runs and bounded, atomic checkpoint publication.
use super::*;
use crate::agent::checkpoint::{ContextCheckpoint, MAX_SUMMARY_TOKENS};
use serde_json::json;

const CURRENT: &str = "context\0current";
const ACTIVE: &str = "context\0active";

fn invalid(message: &str) -> HistoryError {
    HistoryError::InvalidCommand(message.into())
}

pub(super) fn configuration_fingerprint(actor: &crate::storage::jsonl::session::SessionActor) -> Result<String, HistoryError> {
    let session = actor.projection.as_ref().map(|projection| &projection.session);
    let field = |key: &str| session.and_then(|value| value.get(key)).map(|v| v.to_json()).unwrap_or(Value::Null);
    let metadata = session.and_then(|value| value.get("sessionMetadata"));
    let meta = |key: &str| metadata.and_then(|value| value.get(key)).map(|v| v.to_json()).unwrap_or(Value::Null);
    Ok(layout::sha256_hex(&serialized(&json!({"permissionRules":field("permissionRules"),
        "skillIds":field("skillIds"),"mcpServerIds":field("mcpServerIds"),"backend":meta("backend"),
        "permissionConfig":meta("permissionConfig"),"permissionTier":meta("permissionTier")}))?))
}

impl SessionOps<'_> {
    pub(super) fn context_permissions(&self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let ids = value["messageIds"].as_array().filter(|ids| ids.len() <= 256).ok_or_else(|| invalid("message permissions batch exceeds 256 items"))?;
        let mut sealed = Vec::new();
        for id in ids {
            let id = id.as_str().filter(|id| id.len() <= 256).ok_or_else(|| invalid("invalid message ID"))?;
            if self.context_sealed("message", id) { sealed.push(id); }
        }
        serialized(&json!({"readOnlyMessageIds":sealed}))
    }

    /// Active execution state after a logical seal. Historical UI/query state
    /// stays in the source log. Non-transcript records are loaded only by
    /// authoritative current-work/context/evidence references supplied by host.
    pub(super) fn execution_entities(&self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let from = required_u64(value, "fromRevision")?;
        let through = required_u64(value, "throughRevision")?;
        let generation = required_u64(value, "generation")?;
        if generation != self.index().index_generation || through > self.index().head.revision || from > through { return Err(HistoryError::StaleCursor); }
        let collection = required_string(value, "collection")?;
        let cursor = &value["cursor"];
        if !cursor.is_null() && (cursor["sessionId"] != self.session_id || cursor["collection"] != collection
            || cursor["throughRevision"] != through || cursor["fromRevision"] != from) { return Err(invalid("execution cursor scope mismatch")); }
        let start = (collection.to_owned(), cursor["revision"].as_u64().unwrap_or(from.saturating_add(1)), cursor["after"].as_str().unwrap_or("").to_owned());
        let end = (collection.to_owned(), through, char::MAX.to_string());
        let mut items = Vec::new();
        let mut bytes = 4096;
        let mut next = Value::Null;
        if start <= end {
            for ((_, revision, key), identity) in self.index().birth_order.range(start..=end) {
                let Some(entity) = self.index().identity.get(identity).and_then(|key| self.index().order.get(key)) else { continue; };
                let item = self.history_wire_value(entity, 32 * 1024);
                let size = serialized(&item)?.len();
                if items.len() == 128 || bytes + size > 512 * 1024 {
                    next = json!({"sessionId":self.session_id,"collection":collection,"fromRevision":from,"throughRevision":through,
                        "revision":revision,"after":key}); break;
                }
                bytes += size; items.push(item);
            }
        }
        serialized(&json!({"items":items,"cursor":next}))
    }

    pub(super) fn execution_refs(&self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let references = value["refs"].as_array().filter(|r| r.len() <= 128).ok_or_else(|| invalid("execution refs exceed 128 items"))?;
        let mut items = Vec::new();
        if value["includeHints"] == true {
            for source in ["git_merge_task", "git_merge_receipt", "subagent_summary"] {
                if let Some(hints) = self.index().aux_value(&format!("context\0hint\0{source}")).and_then(Value::as_array) {
                    for hint in hints {
                        if let Some(object) = hint["objectId"].as_str().and_then(|id| self.index().objects.get(id)) {
                            items.push(json!({"kind":"message","value":self.history_wire_value(object, 2048)}));
                        }
                    }
                }
            }
        }
        for reference in references {
            let kind = required_string(reference, "kind")?;
            let id = required_string(reference, "id")?;
            if id.len() > 256 { return Err(invalid("execution reference too long")); }
            let identity = super::super::identity_key(kind, self.session_id, id);
            if let Some(object) = self.index().identity.get(&identity).and_then(|key| self.index().order.get(key)) {
                items.push(json!({"kind":kind,"value":self.history_wire_value(object, 2048)}));
            }
        }
        serialized(&json!({"items":items}))
    }

    /// Incremental working-set refresh for all entity categories, not only UI
    /// messages. Each page seeks its revision cursor; no full cache snapshots.
    pub(super) fn history_updates(&self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let generation = required_u64(value, "generation")?;
        let until = required_u64(value, "throughRevision")?;
        if generation != self.index().index_generation || until > self.index().head.revision { return Err(HistoryError::StaleCursor); }
        let cursor = &value["cursor"];
        let position = if cursor.is_null() { (required_u64(value, "afterRevision")?, usize::MAX) }
            else {
                if cursor["sessionId"] != self.session_id || cursor["throughRevision"] != until { return Err(invalid("history update cursor scope mismatch")); }
                (required_u64(cursor, "revision")?, required_u64(cursor, "offset")? as usize)
            };
        if position.0 > until { return Err(invalid("history update cursor is ahead of range")); }
        let mut items = Vec::new();
        let mut last = position;
        let mut bytes = 4096;
        let mut more = false;
        use std::ops::Bound::{Excluded, Included};
        for ((revision, offset), change) in self.index().changes.range((Excluded(position), Included((until, usize::MAX)))) {
            let Some(object) = self.index().objects.get(&change.object_id) else { continue; };
            let Some(kind) = indexed_kind(&object.kind, &object.value) else { continue; };
            let item = json!({"kind":kind,"id":object.value["id"],"deleted":object.kind == "runtime.tombstone",
                "value":self.history_wire_value(object, 32 * 1024)});
            let size = serialized(&item)?.len();
            if items.len() >= 128 || bytes + size > 512 * 1024 { more = true; break; }
            bytes += size;
            items.push(item);
            last = (*revision, *offset);
        }
        serialized(&json!({"items":items,"cursor":if more { json!({"sessionId":self.session_id,"throughRevision":until,
            "revision":last.0,"offset":last.1}) } else { Value::Null }}))
    }

    pub(super) fn context_read(&self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let kind = required_string(value, "kind")?;
        let id = required_string(value, "id")?;
        if kind == "step" {
            let identity = super::super::identity_key("step", self.session_id, id);
            if !self.index().identity.contains_key(&identity) { return Err(HistoryError::ObjectMissing(id.into())); }
            let part_id = value["partId"].as_str().unwrap_or("");
            let start = if part_id.is_empty() { String::new() } else {
                self.index().identity.get(&super::super::identity_key("part", self.session_id, part_id))
                    .and_then(|key| self.index().order.get(key)).and_then(|object| super::super::step_text_key(object))
                    .filter(|(step, _)| step == id).map(|(_, key)| key)
                    .ok_or_else(|| HistoryError::ObjectMissing(part_id.into()))?
            };
            let mut parts = self.index().step_text.range((id.to_owned(), start)..=(id.to_owned(), char::MAX.to_string()));
            let Some((_, object)) = parts.next() else {
                return serialized(&json!({"text":"","hasMore":false,"historical":true}));
            };
            let mut request = value.clone();
            request["kind"] = json!("object"); request["id"] = json!(object.object_id);
            let mut result: Value = serde_json::from_slice(&self.context_read(&request)?).map_err(|_| invalid("invalid text slice"))?;
            result["partId"] = object.value["id"].clone();
            if result["hasMore"] == false {
                if let Some((_, next)) = parts.next() {
                    result["hasMore"] = json!(true); result["nextPartId"] = next.value["id"].clone(); result["nextOffset"] = json!(0);
                }
            } else { result["nextPartId"] = object.value["id"].clone(); }
            return serialized(&result);
        }
        let saved = if kind == "object" {
            let id = self.index().aux_value(&format!("fork\0object\0{id}")).and_then(Value::as_str).unwrap_or(id);
            self.read_object(id)?
        } else {
            let collection = match kind { "message" => "message", "checkpoint" => "compaction", _ => return Err(invalid("invalid context reference kind")) };
            let key = super::super::identity_key(collection, self.session_id, id);
            self.index().identity.get(&key).and_then(|key| self.index().order.get(key)).cloned()
                .ok_or_else(|| HistoryError::ObjectMissing(id.into()))?
        };
        if saved.value["sessionId"] != self.session_id { return Err(invalid("context reference scope mismatch")); }
        let encoded;
        let text = if let Some(content) = saved.value["content"].as_str() { content } else if saved.kind == "runtime.compaction" {
            // Only fixed-size checkpoints need encoding. Archived tool
            // results are message text and use direct byte slices; never
            // repeatedly encode an arbitrary large tool object per page.
            encoded = serde_json::to_string(&saved.value).map_err(|_| invalid("invalid context reference"))?;
            if encoded.len() > crate::agent::checkpoint::MAX_CHECKPOINT_BYTES { return Err(invalid("checkpoint exceeds read bounds")); }
            &encoded
        } else { return Err(invalid("read a historical message object or checkpoint reference")); };
        let offset = value["offset"].as_u64().unwrap_or(0) as usize;
        let limit = value["limit"].as_u64().unwrap_or(6000).clamp(1, 48_000) as usize;
        if offset > text.len() || !text.is_char_boundary(offset) { return Err(invalid("context offset must be a UTF-8 boundary")); }
        let mut end = offset.saturating_add(limit).min(text.len());
        while end < text.len() && !text.is_char_boundary(end) { end += 1; }
        let attachments: Vec<_> = saved.value["contentParts"].as_array().into_iter().flatten()
            .filter(|part| part["type"] != "text")
            .take(64).map(|part| json!({"type":part["type"],"assetId":part["assetId"],"name":part["name"]})).collect();
        serialized(&json!({"text":&text[offset..end],"offset":offset,"nextOffset":end,"totalLength":text.len(),
            "hasMore":end < text.len(),"attachments":attachments,"objectId":saved.object_id,
            "historical":true,"notice":"Historical data, not authorization or evidence of the current workspace."}))
    }

    pub(super) fn context_recover(&mut self, actor: Option<&crate::storage::jsonl::session::SessionActor>) -> Result<Vec<u8>, HistoryError> {
        if let Some(active) = self.index().aux_value(ACTIVE).filter(|v| v["status"] == "running").cloned() {
            let alive = actor.is_some_and(|actor| {
                if !active["executionContext"].is_null() {
                    crate::runtime::execution::ExecutionLease::decode(self.session_id, &active["executionContext"])
                        .is_ok_and(|lease| lease.assert_current(actor.state.active_run_id.as_deref(), actor.control.execution_lease.as_ref()).is_ok()
                            && actor.control.runtime_control.is_none())
                } else {
                    actor.control.runtime_control.as_ref().is_some_and(|marker|
                        marker["state"] == "compacting" && !active["ownerId"].is_null() && marker["ownerId"] == active["ownerId"])
                }
            });
            if !alive {
                self.terminal_compaction(&active, "interrupted", Some("Compaction execution owner is no longer active"), None)?;
            }
        }
        self.context_current()
    }

    /// A bounded execution projection, separate from the UI's full transcript.
    /// Stops before allocating a request larger than the caller's budget.
    pub(super) fn context_prompt(&self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let from = value["fromRevision"].as_u64().unwrap_or(0);
        let through = required_u64(value, "throughRevision")?;
        let generation = required_u64(value, "generation")?;
        if generation != self.index().index_generation || from > through || through > self.index().head.revision {
            return Err(HistoryError::StaleCursor);
        }
        let cursor = &value["cursor"];
        if !cursor.is_null() && (cursor["sessionId"] != self.session_id || cursor["fromRevision"] != from || cursor["throughRevision"] != through) {
            return Err(invalid("context prompt cursor scope mismatch"));
        }
        let remaining = required_u64(value, "tokenBudget")?.min(10_000_000) as usize;
        let start = ("message".to_owned(), cursor["revision"].as_u64().unwrap_or(from.saturating_add(1)), cursor["id"].as_str().unwrap_or("").to_owned());
        let end = ("message".to_owned(), through, char::MAX.to_string());
        let mut items = Vec::new();
        let mut used = 0;
        let mut bytes = 0;
        let mut next = Value::Null;
        if start <= end {
            for ((_, revision, id), identity) in self.index().birth_order.range(start..=end) {
                let Some(message) = self.index().identity.get(identity).and_then(|key| self.index().order.get(key)) else { continue; };
                if !matches!(message.value["role"].as_str(), Some("user" | "assistant" | "tool"))
                    || message.value["metadata"]["source"] == "subagent_summary" { continue; }
                let canonical = message.value.pointer("/metadata/rustMessage").filter(|m| !m.is_null()).cloned()
                    .unwrap_or_else(|| json!({"role":message.value["role"],"content":message.value.get("contentParts").filter(|parts| parts.is_array()).unwrap_or(&message.value["content"])}));
                let tokens = crate::agent::context::message_tokens(&canonical).map_err(|_| invalid("context accounting failed"))?;
                // Large tool results must be summarized, not transferred in
                // unbounded IPC frames. User input remains a hard constraint.
                let mut item = json!({"id":message.value["id"],"role":message.value["role"],"content":message.value["content"],
                    "contentParts":message.value["contentParts"],"metadata":{"rustMessage":message.value["metadata"]["rustMessage"]}});
                if used + tokens > remaining {
                    return serialized(&json!({"items":items,"tokens":used,"cursor":null,"overflow":true}));
                }
                if serialized(&item)?.len() > 256 * 1024 { item = self.history_wire_value(message, 256 * 1024); }
                let item_bytes = serialized(&item)?.len();
                if items.len() == 64 || bytes + item_bytes > 512 * 1024 {
                    next = json!({"sessionId":self.session_id,"fromRevision":from,"throughRevision":through,"revision":revision,"id":id});
                    break;
                }
                used += tokens;
                bytes += item_bytes;
                items.push(item);
            }
        }
        serialized(&json!({"items":items,"tokens":used,"cursor":next,"overflow":false}))
    }

    /// Read only new messages by birth revision. Each summary page slices the
    /// stored text directly, so an oversized result is not reserialized for
    /// every slice. The UI continues to read the original message objects.
    pub(super) fn context_messages(&self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let from = value["fromRevision"].as_u64().unwrap_or(0);
        let through = required_u64(value, "throughRevision")?;
        let generation = required_u64(value, "generation")?;
        if generation != self.index().index_generation || from > through || through > self.index().head.revision {
            return Err(HistoryError::StaleCursor);
        }
        let cursor = &value["cursor"];
        if !cursor.is_null() && (cursor["sessionId"] != self.session_id || cursor["fromRevision"] != from || cursor["throughRevision"] != through) {
            return Err(invalid("context page cursor scope mismatch"));
        }
        let after_revision = cursor["revision"].as_u64().unwrap_or(from.saturating_add(1));
        let after_id = cursor["id"].as_str().unwrap_or("");
        let mut offset = cursor["offset"].as_u64().unwrap_or(0) as usize;
        let start = ("message".to_owned(), after_revision, after_id.to_owned());
        let end = ("message".to_owned(), through, char::MAX.to_string());
        let mut items = Vec::new();
        let mut used = 0;
        let mut next = Value::Null;
        if after_revision <= through {
            for ((_, revision, id), identity) in self.index().birth_order.range(start..=end) {
                let Some(message) = self.index().identity.get(identity).and_then(|key| self.index().order.get(key)) else { continue; };
                if message.value["metadata"]["source"] == "context_compaction" { continue; }
                let has_media = crate::agent::context::contains_attachment(&message.value);
                // The native tool wire form has a text preamble followed by
                // media parts. Borrow that text; the stored display content
                // can be serialized JSON containing base64 image/file bytes.
                let content = if has_media && message.value["role"] == "tool" {
                    message.value.pointer("/metadata/rustMessage/content/0/output/value/0/text").and_then(Value::as_str)
                        .unwrap_or("Archived media result. Use the original object reference to inspect the record and attachment.")
                } else { message.value["content"].as_str().unwrap_or("") };
                if offset > content.len() || !content.is_char_boundary(offset) { return Err(invalid("invalid context text offset")); }
                let mut end = (offset + (48 * 1024_usize).saturating_sub(used)).min(content.len());
                while !content.is_char_boundary(end) { end -= 1; }
                if end == offset && offset < content.len() || items.len() == 64 {
                    next = json!({"sessionId":self.session_id,"fromRevision":from,"throughRevision":through,
                        "revision":revision,"id":id,"offset":offset});
                    break;
                }
                items.push(json!({"id":message.value["id"],"objectId":message.object_id,"revision":revision,
                    "role":message.value["role"],"stepId":message.value["stepId"],
                    "offset":offset,"text":&content[offset..end],
                    "hasAttachments":has_media}));
                used += end - offset;
                if end < content.len() {
                    next = json!({"sessionId":self.session_id,"fromRevision":from,"throughRevision":through,
                        "revision":revision,"id":id,"offset":end});
                    break;
                }
                offset = 0;
            }
        }
        serialized(&json!({"items":items,"cursor":next}))
    }

    pub(super) fn context_sealed(&self, kind: &str, id: &str) -> bool {
        let Some(boundary) = self.index().aux_value(CURRENT).and_then(|v| v["throughRevision"].as_u64()) else {
            return false;
        };
        let identity = super::super::identity_key(kind, self.session_id, id);
        self.index().first_revision.get(&identity).is_some_and(|revision| *revision <= boundary)
    }

    pub(super) fn guard_context_write(&self, kind: &str, value: &Value) -> Result<(), HistoryError> {
        let Some(collection) = indexed_kind(kind, value) else { return Ok(()); };
        if !matches!(collection, "message" | "step" | "part" | "tool" | "event" | "run" | "compaction") {
            return Ok(());
        }
        let Some(id) = value["id"].as_str() else { return Ok(()); };
        if !self.context_sealed(collection, id) { return Ok(()); }
        let identity = super::super::identity_key(collection, self.session_id, id);
        let previous = self.index().identity.get(&identity).and_then(|key| self.index().order.get(key));
        if previous.is_some_and(|old| old.value == *value && old.kind == kind) { return Ok(()); }
        // A user run can cross a context boundary; its lifecycle is mutable,
        // but the individual sealed steps, messages and receipts are not.
        if collection == "run" && kind != "runtime.tombstone" && previous.is_some_and(|old|
            matches!(old.value["status"].as_str(), Some("running" | "queued" | "waiting_input" | "waiting_permission")))
        { return Ok(()); }
        Err(HistoryError::ReadOnlyHistory)
    }

    pub(super) fn guard_context_head(&self, root: &str) -> Result<(), HistoryError> {
        let Some(required) = self.index().aux_value(CURRENT).and_then(|v| v["objectId"].as_str()) else { return Ok(()); };
        let mut pending = vec![root.to_owned()];
        let mut visited = HashSet::new();
        while let Some(id) = pending.pop() {
            if id == required { return Ok(()); }
            if !visited.insert(id.clone()) { continue; }
            let object = self.read_object(&id)?;
            // Only roots link to prior history; no need to walk tool payloads.
            if object.kind.starts_with("runtime.session.root") { pending.extend(object.refs.iter().cloned()); }
        }
        Err(HistoryError::ReadOnlyHistory)
    }

    pub(super) fn context_current(&self) -> Result<Vec<u8>, HistoryError> {
        let published = self.index().aux_value(CURRENT);
        let mut checkpoint = None;
        let mut checkpoint_object = None;
        if let Some(published) = published {
            // Validate bounded semantic state without loading its transcript.
            // A fallback changes only the model's starting point; the sealed
            // write floor remains the latest committed throughRevision.
            for id in [published["objectId"].as_str(), published["previousObjectId"].as_str()].into_iter().flatten() {
                if let Ok(object) = self.read_object(id) {
                    let content = serialized(&object.value)?;
                    let digest = format!("sha256:{}", layout::sha256_hex(&serialized(&(&object.kind, &object.value, &object.refs))?));
                    if digest == object.object_id && ContextCheckpoint::parse(&content, MAX_SUMMARY_TOKENS).is_ok() {
                        checkpoint = Some(object.value.clone());
                        checkpoint_object = Some(object.object_id.clone());
                        break;
                    }
                }
            }
            if checkpoint.is_none() { return Err(invalid("CHECKPOINT_UNAVAILABLE: no valid committed context checkpoint")); }
        }
        let boundary = self.index().aux_value("context\0latest-boundary");
        let latest_step = boundary.map(|value| value["throughStepId"].clone());
        serialized(&json!({"checkpoint":checkpoint,"active":self.index().aux_value(ACTIVE),
            "checkpointObjectId":checkpoint_object,
            "sealedThroughRevision":published.map(|v| v["throughRevision"].clone()),
            "revision":self.index().head.revision,"generation":self.index().index_generation,"latestStepId":latest_step,
            "messageSequence":self.index().aux_value("context\0message-sequence").and_then(Value::as_u64).unwrap_or(0),
            "throughRevision":boundary.map(|v| v["throughRevision"].clone())}))
    }

    pub(super) fn context_begin(&mut self, value: &Value, configuration: Option<&str>) -> Result<Vec<u8>, HistoryError> {
        if self.index().aux_value(ACTIVE).is_some_and(|v| v["status"] == "running") {
            let active = self.index().aux_value(ACTIVE).unwrap().clone();
            if active["deadline"].as_i64().unwrap_or(i64::MAX) > chrono::Utc::now().timestamp_millis() {
                return Err(invalid("COMPACTION_BUSY"));
            }
            self.terminal_compaction(&active, "interrupted", Some("Compaction deadline expired"), None)?;
        }
        let run_id = required_string(value, "runId")?;
        let step_id = required_string(value, "stepId")?;
        let through_step = required_string(value, "throughStepId")?;
        for id in [run_id, step_id, through_step] {
            if id.len() > 256 { return Err(invalid("invalid compaction identity")); }
        }
        let head = self.index().head.clone();
        let expected = required_u64(value, "expectedRevision")?;
        if expected != head.revision {
            return Err(HistoryError::RevisionConflict { expected, actual: head.revision });
        }
        let identity = super::super::identity_key("step", self.session_id, through_step);
        let through = self.index().identity.get(&identity).and_then(|key| self.index().order.get(key))
            .ok_or_else(|| HistoryError::ObjectMissing(through_step.into()))?;
        if !matches!(through.value["status"].as_str(), Some("completed" | "failed" | "interrupted" | "cancelled")) {
            return Err(invalid("compaction boundary must be a completed step"));
        }
        let boundary_at = through.value["completedAt"].as_str().or_else(|| through.value["startedAt"].as_str()).unwrap_or("").to_owned();
        let boundary = self.index().aux_value("context\0latest-boundary")
            .filter(|b| b["throughStepId"] == through_step).cloned()
            .ok_or_else(|| invalid("compaction boundary is no longer current"))?;
        let through_revision = required_u64(&boundary, "throughRevision")?;
        let source_root = required_string(&boundary, "rootId")?;
        // The boundary is captured once. Later queued inputs may append after
        // it; a destructive history edit invalidates indexGeneration instead.
        let at = now_iso();
        let fingerprint = layout::sha256_hex(&serialized(&(
            self.session_id, source_root, through_revision, through_step,
        ))?);
        let active = json!({"runId":run_id,"stepId":step_id,"throughStepId":through_step,
            "configurationFingerprint":configuration,
            "boundaryAt":boundary_at,
            "ownerId":value["ownerId"],"executionContext":value["executionContext"],
            "throughRevision":through_revision,"sourceFingerprint":fingerprint,
            "sourceRootId":source_root,
            "previousCheckpointId":self.index().aux_value(CURRENT).map(|v| v["id"].clone()),
            "indexGeneration":self.index().index_generation,"startedAt":at,"status":"running",
            "deadline":chrono::Utc::now().timestamp_millis() + 300_000});
        self.stage_append(&json!({"objects":[
            {"kind":"runtime.run","value":{"id":run_id,"sessionId":self.session_id,"status":"running",
                "startedAt":at,"completedAt":null,"triggerMessageId":null,"currentStep":1,"model":value["model"],
                "stopReason":null,"metadata":{"kind":"context-compaction"}}},
            {"kind":"runtime.step","value":{"id":step_id,"sessionId":self.session_id,"runId":run_id,
                "index":1,"status":"running","startedAt":at,"completedAt":null,"model":value["model"],
                "finishReason":null,"metadata":{"kind":"context-compaction"}}},
            {"kind":"runtime.message","value":{"id":format!("context:{run_id}"),"sessionId":self.session_id,
                "runId":run_id,"stepId":step_id,"role":"system","content":"正在压缩上下文","createdAt":at,
                "metadata":{"source":"context_compaction","contextCompaction":{"id":format!("context:{run_id}"),
                    "runId":run_id,"stepId":step_id,"status":"running","startedAt":at,"requestId":null}}}}
        ]}), None)?;
        self.set_aux(ACTIVE.into(), Some(active.clone()));
        serialized(&active)
    }

    fn active_compaction(&self, run_id: &str) -> Result<Value, HistoryError> {
        self.index().aux_value(ACTIVE)
            .filter(|v| v["runId"] == run_id && v["status"] == "running")
            .cloned().ok_or_else(|| invalid("COMPACTION_SUPERSEDED"))
    }

    fn terminal_compaction(&mut self, active: &Value, status: &str, error: Option<&str>, checkpoint: Option<&ContextCheckpoint>) -> Result<Value, HistoryError> {
        let at = now_iso();
        let mut objects = Vec::with_capacity(5);
        for (kind, id_field) in [("run", "runId"), ("step", "stepId")] {
            let id = required_string(active, id_field)?;
            let key = super::super::identity_key(kind, self.session_id, id);
            let mut value = self.index().identity.get(&key).and_then(|key| self.index().order.get(key))
                .ok_or_else(|| HistoryError::ObjectMissing(id.into()))?.value.clone();
            value["status"] = json!(status);
            value["completedAt"] = json!(at);
            value[if kind == "run" { "stopReason" } else { "finishReason" }] = json!(error.unwrap_or(status));
            objects.push(json!({"kind":format!("runtime.{kind}"),"value":value}));
        }
        let mut state = active.clone();
        state["status"] = json!(if status == "interrupted" { "failed" } else { status });
        state["completedAt"] = json!(at);
        state["id"] = json!(format!("context:{}", required_string(active, "runId")?));
        state["requestId"] = Value::Null;
        state["compacted"] = json!(checkpoint.is_some());
        state["error"] = json!(error);
        if let Some(checkpoint) = checkpoint {
            state["checkpointId"] = json!(checkpoint.id);
            let refs: Vec<_> = active["sourceRootId"].as_str().into_iter()
                .chain(self.index().aux_value(CURRENT).and_then(|v| v["objectId"].as_str())).collect();
            objects.push(json!({"kind":"runtime.compaction","value":checkpoint, "refs":refs}));
        }
        let text = if checkpoint.is_some() { "上下文已压缩" } else if status == "completed" { "上下文无需进一步压缩" } else { "上下文压缩已中断或失败" };
        objects.push(json!({"kind":"runtime.message","value":{"id":state["id"],"sessionId":self.session_id,
            "runId":active["runId"],"stepId":active["stepId"],"role":"system","content":text,
            "createdAt":active["startedAt"],"metadata":{"source":"context_compaction","contextCompaction":state}}}));
        objects.push(json!({"kind":"runtime.event","value":{"id":format!("context:{}:terminal", active["runId"].as_str().unwrap()),
            "sessionId":self.session_id,"type":if status == "completed" {"context_compacted"} else {"context_compaction_failed"},
            "timestamp":at,"visibility":"user_visible","summary":text,"payload":state}}));
        self.stage_append(&json!({"objects":objects}), None)?;
        self.set_aux(ACTIVE.into(), Some(state.clone()));
        Ok(state)
    }

    pub(super) fn context_finish(&mut self, value: &Value) -> Result<Vec<u8>, HistoryError> {
        let active = self.active_compaction(required_string(value, "runId")?)?;
        let status = required_string(value, "status")?;
        if !matches!(status, "failed" | "interrupted" | "completed") { return Err(invalid("invalid compaction terminal status")); }
        let error = value["error"].as_str();
        if error.is_some_and(|e| e.len() > 4096) { return Err(invalid("compaction error exceeds bounds")); }
        serialized(&self.terminal_compaction(&active, status, error, None)?)
    }

    pub(super) fn context_commit(&mut self, value: &Value, configuration: Option<&str>) -> Result<Vec<u8>, HistoryError> {
        let checkpoint = ContextCheckpoint::parse(&serialized(&value["checkpoint"])? , MAX_SUMMARY_TOKENS)
            .map_err(invalid)?;
        if checkpoint.session_id != self.session_id { return Err(invalid("checkpoint session mismatch")); }
        let active = self.active_compaction(&checkpoint.compaction_run_id)?;
        if active["configurationFingerprint"].as_str() != configuration { return Err(invalid("COMPACTION_CONFIGURATION_CHANGED")); }
        if active["deadline"].as_i64().unwrap_or(0) <= chrono::Utc::now().timestamp_millis() {
            return Err(invalid("COMPACTION_EXPIRED"));
        }
        if active["indexGeneration"].as_u64() != Some(self.index().index_generation)
            || active["ownerId"] != value["ownerId"] || active["executionContext"] != value["executionContext"]
            || active["throughRevision"].as_u64() != Some(checkpoint.through_revision)
            || active["throughStepId"] != checkpoint.through_step_id
            || active["sourceFingerprint"] != checkpoint.source_fingerprint
            || active["previousCheckpointId"] != self.index().aux_value(CURRENT).map(|v| v["id"].clone()).unwrap_or(Value::Null)
        { return Err(invalid("COMPACTION_SOURCE_CHANGED")); }
        for reference in &checkpoint.source_refs {
            // References are immutable history object IDs, resolved by the
            // existing O(1) content index, never by scanning a transcript.
            let source = self.read_object(reference)?;
            if source.value["sessionId"] != self.session_id { return Err(invalid("checkpoint reference scope mismatch")); }
        }
        let state = self.terminal_compaction(&active, "completed", None, Some(&checkpoint))?;
        let key = super::super::identity_key("compaction", self.session_id, &checkpoint.id);
        let object_id = self.index().identity.get(&key).and_then(|key| self.index().order.get(key))
            .ok_or_else(|| invalid("checkpoint publication missing"))?.object_id.clone();
        let previous_object = self.index().aux_value(CURRENT).map(|value| value["objectId"].clone());
        self.set_aux(CURRENT.into(), Some(json!({"id":checkpoint.id,"objectId":object_id,"previousObjectId":previous_object,
            "throughRevision":checkpoint.through_revision,"throughStepId":checkpoint.through_step_id})));
        serialized(&state)
    }
}
