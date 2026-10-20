//! The hot operations: admission, activation, completion, stream append,
//! control commands and the queue.
//!
//! Each operation has two halves. The first validates against the published
//! state and fills a [`Tx`]; the second is `SessionActor::commit`. Validation
//! never touches the disk, and a failed validation leaves nothing behind.


use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::actor::{
    ControlCommandReceipt, PendingEvent, RunAdmission, RuntimeError, SessionSnapshot, StreamAppendReceipt,
    StreamEvent,
};
use crate::input_queue::QueueState;
use crate::jsonl::record::SnapshotBody;
use crate::jsonl::segment::{PValue, Projection};
use crate::session_types::{ActivationReceipt, FinishReceipt};


use super::super::session::state::Tx;
use crate::jsonl::session::{SessionActor, SessionHandle};
use crate::session_types::append_fingerprint;

/// Control operations that answer from live state and own no receipt.
const RECEIPT_FREE: [&str; 2] = ["read", "execution_check"];

const MAX_EVENT_BYTES: usize = 1024 * 1024 - 8192;
const MAX_REQUEST_BYTES: usize = 512 * 1024;

pub fn value_to_bytes(value: &Value) -> Result<Vec<u8>, RuntimeError> {
    serde_json::to_vec(value).map_err(|error| RuntimeError::InvalidCommand(error.to_string()))
}

pub fn parse_json(bytes: &[u8]) -> Result<Value, RuntimeError> {
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(bytes).map_err(|_| RuntimeError::InvalidCommand("invalid JSON body".into()))
}

pub fn snapshot_of(state: &crate::jsonl::record::SnapshotCond, session_id: &str) -> SessionSnapshot {
    SessionSnapshot {
        session_id: session_id.to_owned(),
        epoch: state.epoch,
        revision: state.revision,
        active_run_id: state.active_run_id.clone(),
        cursor: state.cursor,
        retained_from: state.retained_from,
    }
}

pub fn ensure_epoch(state: &crate::jsonl::record::SnapshotCond, epoch: u64) -> Result<(), RuntimeError> {
    if epoch == state.epoch {
        Ok(())
    } else {
        Err(RuntimeError::StaleEpoch { expected: state.epoch, actual: epoch })
    }
}

pub fn ensure_revision(state: &crate::jsonl::record::SnapshotCond, revision: u64) -> Result<(), RuntimeError> {
    if revision == state.revision {
        Ok(())
    } else {
        Err(RuntimeError::RevisionConflict { expected: revision, actual: state.revision })
    }
}

pub fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, RuntimeError> {
    value[key]
        .as_str()
        .filter(|item| !item.is_empty())
        .ok_or_else(|| RuntimeError::InvalidCommand(format!("{key} is required")))
}

pub fn set_projection_state(
    projection: &mut Projection,
    status: &str,
    active_run_id: Option<&str>,
    pending_resume_token: Option<&str>,
    blocked_reason: Option<&str>,
    updated_at: &str,
) {
    projection.session.set("status", PValue::String(status.to_owned()));
    projection.session.set("activeRunId", active_run_id.map_or(PValue::Null, |id| PValue::String(id.to_owned())));
    projection
        .session
        .set("pendingResumeToken", pending_resume_token.map_or(PValue::Null, |token| PValue::String(token.to_owned())));
    projection
        .session
        .set("blockedReason", blocked_reason.map_or(PValue::Null, |reason| PValue::String(reason.to_owned())));
    projection.session.set("updatedAt", PValue::String(updated_at.to_owned()));
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}


impl SessionHandle {
    /// Read the published projection, encoding it when its generation moved.
    pub fn ui_snapshot(&self) -> Result<Vec<u8>, RuntimeError> {
        let actor = self.actor.lock();
        actor
            .projection
            .as_ref()
            .ok_or(RuntimeError::ProjectionMissing)?
            .encode()
    }

    pub fn exists_projection(&self) -> bool {
        self.actor.lock().projection.is_some()
    }

    /// Seed a brand-new session from the host's session document.
    pub fn seed(&self, session: &[u8]) -> Result<Vec<u8>, RuntimeError> {
        let seed = crate::projection::UiSnapshot::seed(&self.id, session)?;
        let mut actor = self.actor.lock();
        if actor.state.cursor != 0 || actor.state.revision != 0 || actor.state.active_run_id.is_some() {
            return Err(RuntimeError::ProjectionMigrationRequired);
        }
        let projection = Projection::from_snapshot(&seed);
        let bytes = projection.encode()?;
        let body = SnapshotBody {
            id: self.id.clone(),
            header: seed.session.clone(),
            state: actor.state.clone(),
            projection: seed,
        };
        actor.persist_snapshot(body, projection, &bytes, self)?;
        Ok(bytes)
    }
}

impl SessionActor {
    /// Write a full-session snapshot as the new recovery base.
    fn persist_snapshot(&mut self, body: SnapshotBody, projection: Projection, bytes: &[u8], handle: &SessionHandle) -> Result<(), RuntimeError> {
        let commit = self.commit + 1;
        let mut writer = crate::jsonl::record::LineWriter::new();
        let frame = writer.line(&crate::jsonl::record::Record::Snapshot(body)).to_vec();
        let mut extent = self.files.extent.clone();
        extent.offsets[crate::jsonl::write::Kind::Controls as usize] += frame.len() as u64 + 4;
        extent.frames[crate::jsonl::write::Kind::Controls as usize] += 1;
        let seal = crate::jsonl::session::encode_seal(self.files.segment, commit, &extent, &self.state, &mut writer)?;
        self.files.commit(
            &[crate::jsonl::write::Slot { kind: crate::jsonl::write::Kind::Controls, segment: self.files.segment, payload: frame }],
            &seal,
        )?;
        self.projection = Some(projection);
        self.header = self.projection.as_ref().map_or(Value::Null, |projection| projection.session.to_json());
        self.commit = commit;
        self.publish(handle);
        let _ = bytes;
        Ok(())
    }

    pub fn read_state(&self) -> &crate::jsonl::record::SnapshotCond {
        &self.state
    }

    /// Admit one queued run, idempotently on `request_id`.
    pub fn run_admission(
        &mut self,
        handle: &SessionHandle,
        request_id: &str,
        body_hash: &str,
        run_id: &str,
        epoch: u64,
        expected_revision: u64,
        queue_item: &[u8],
        run_json: &[u8],
    ) -> Result<RunAdmission, RuntimeError> {
        let queue_item = if queue_item.is_empty() { None } else { Some(parse_json(queue_item)?) };
        let run_document = if run_json.is_empty() {
            None
        } else {
            let document = parse_json(run_json)?;
            if document["id"].as_str() != Some(run_id)
                || document["sessionId"].as_str() != Some(&self.id)
                || document["status"] != "queued"
                || document["startedAt"].as_str().is_none()
            {
                return Err(RuntimeError::InvalidCommand(
                    "admission requires a queued run document with matching identity".into(),
                ));
            }
            Some(document)
        };
        if let Some(saved) = self.receipt("admit", request_id) {
            if saved.fingerprint != body_hash {
                return Err(RuntimeError::RequestConflict);
            }
            let mut admission: RunAdmission = serde_json::from_value(saved.result.clone())
                .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))?;
            admission.reused = true;
            return Ok(admission);
        }
        ensure_epoch(&self.state, epoch)?;
        ensure_revision(&self.state, expected_revision)?;
        if self.state.active_run_id.is_some() || self.control.runtime_control.is_some() {
            return Err(RuntimeError::SessionBusy);
        }
        let projection = self.projection.clone().ok_or(RuntimeError::ProjectionMissing)?;
        if projection.pending_queue_input.is_some() {
            return Err(RuntimeError::InvalidCommand(
                "previous input delivery requires recovery before admission".into(),
            ));
        }
        let mut tx = Tx {
            cursor: self.state.cursor,
            revision: self.state.revision + 1,
            epoch: self.state.epoch,
            projection,
            ..Default::default()
        };
        let mut queue_event = None;
        if let Some(item) = queue_item.as_ref() {
            let id = crate::input_queue::item_id(item)?;
            let mut queue = tx.projection.queue();
            let persisted = queue
                .items
                .iter()
                .find(|entry| entry["id"].as_str() == Some(id))
                .ok_or_else(|| RuntimeError::InvalidCommand("queued input no longer exists".into()))?;
            if persisted != item {
                return Err(RuntimeError::RequestConflict);
            }
            queue.apply("consume", &json!({"id": id, "runId": run_id}))?;
            queue.delivery = None;
            tx.projection.set_queue(&queue);
            tx.queue = Some(queue.clone());
            tx.cursor += 1;
            let payload = json!({"schema":1,
                "chunk":{"type":"input_queue_changed","sessionId":self.id,"queueSize":queue.items.len(),"forceInjectItemId":queue.force_inject_item_id,"queueRevision":queue.revision},
                "state":{"status":tx.projection.session.get("status").map(PValue::to_json),"activeRunId":tx.projection.session.get("activeRunId").map(PValue::to_json),"pendingResumeToken":tx.projection.session.get("pendingResumeToken").map(PValue::to_json),"blockedReason":tx.projection.session.get("blockedReason").map(PValue::to_json),"updatedAt":tx.projection.session.get("updatedAt").map(PValue::to_json)}
            });
            tx.projection.apply(
                tx.cursor,
                run_id,
                &PendingEvent { kind: "input_queue_changed".into(), payload: value_to_bytes(&payload)? },
            )?;
            queue_event = Some(StreamEvent {
                sequence: tx.cursor,
                run_id: run_id.to_owned(),
                kind: "input_queue_changed".into(),
                payload: value_to_bytes(&payload)?,
                ephemeral: false,
            });
        }
        tx.projection.admitted(run_id);
        if let Some(document) = run_document.clone() {
            tx.projection.run = PValue::from_json(&document);
        }
        tx.active_run_id = Some(Some(run_id.to_owned()));
        tx.revision = tx.revision.max(self.state.revision + 1);
        tx.epoch = self.state.epoch;
        let admission = RunAdmission {
            session_id: self.id.clone(),
            run_id: run_id.to_owned(),
            epoch: self.state.epoch,
            revision: tx.revision,
            reused: false,
            queue_event: queue_event.clone(),
        };
        tx.events.extend(queue_event.clone());
        tx.fan_out.extend(queue_event);
        tx.header = Some(tx.projection.session.clone());
        tx.receipt = Some((
            "admit".into(),
            request_id.to_owned(),
            body_hash.to_owned(),
            to_value(&admission).map_err(|error| RuntimeError::InvalidCommand(error.to_string()))?,
        ));
        self.write(handle, tx)?;
        if let Some(document) = run_document {
            self.active_runs.insert(run_id.to_owned(), document);
        } else {
            self.active_runs.insert(run_id.to_owned(), Value::Null);
        }
        Ok(admission)
    }
}

impl SessionActor {
    /// Turn an admitted queued run into a running one.
    pub fn activate(
        &mut self,
        handle: &SessionHandle,
        request_id: &str,
        run_json: &[u8],
        epoch: u64,
        revision: u64,
    ) -> Result<ActivationReceipt, RuntimeError> {
        if request_id.is_empty() || request_id.len() > 256 || run_json.len() > MAX_REQUEST_BYTES {
            return Err(RuntimeError::InvalidCommand("activation request exceeds its bounds".into()));
        }
        let mut document = parse_json(run_json)?;
        let run_id = document["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| RuntimeError::InvalidCommand("missing run identity".into()))?
            .to_owned();
        if document["sessionId"].as_str() != Some(&self.id)
            || document["status"] != "queued"
            || document["startedAt"].as_str().is_none()
        {
            return Err(RuntimeError::InvalidCommand(
                "activation requires an admitted queued run document".into(),
            ));
        }
        let identity = hash(&(epoch, revision, &document))?;
        if let Some(saved) = self.receipt("activate", request_id) {
            if saved.fingerprint != identity {
                return Err(RuntimeError::RequestConflict);
            }
            let mut receipt: ActivationReceipt = from_value(saved.result.clone())?;
            receipt.reused = true;
            return Ok(receipt);
        }
        ensure_epoch(&self.state, epoch)?;
        ensure_revision(&self.state, revision)?;
        if self.state.active_run_id.as_deref() != Some(&run_id) {
            return Err(RuntimeError::InvalidCommand("run is not admitted".into()));
        }
        if self.activated_runs.contains(&run_id) || self.terminated_runs.contains(&run_id) {
            return Err(RuntimeError::InvalidCommand("run was already activated or finalized".into()));
        }
        let mut active = self.projection.clone().ok_or(RuntimeError::ProjectionMissing)?;
        document["status"] = json!("running");
        document["completedAt"] = Value::Null;
        let payload = json!({"schema":1,
            "chunk":{"type":"run_activated", "run":document},
            "state":{"status":"running", "activeRunId":run_id, "pendingResumeToken":null, "blockedReason":null, "updatedAt":document["startedAt"]}
        });
        let pending = PendingEvent { kind: "run_activated".into(), payload: value_to_bytes(&payload)? };
        active.apply(self.state.cursor + 1, &run_id, &pending)?;
        let mut tx = Tx {
            cursor: self.state.cursor + 1,
            revision: self.state.revision + 1,
            epoch: self.state.epoch,
            projection: active,
            ..Default::default()
        };
        let event = StreamEvent {
            sequence: tx.cursor,
            run_id: run_id.clone(),
            kind: pending.kind,
            payload: pending.payload,
            ephemeral: false,
        };
        let snapshot = snapshot_of(&self.state, &self.id);
        let receipt = ActivationReceipt {
            snapshot: SessionSnapshot { cursor: tx.cursor, revision: tx.revision, ..snapshot },
            event: event.clone(),
            reused: false,
        };
        tx.events.push(event.clone());
        tx.fan_out.push(event);
        tx.header = Some(tx.projection.session.clone());
        tx.receipt = Some(("activate".into(), request_id.to_owned(), identity, to_value(&receipt)?));
        self.write(handle, tx)?;
        Ok(receipt)
    }

    /// Complete the active run with a terminal status.
    pub fn finish(
        &mut self,
        handle: &SessionHandle,
        request_id: &str,
        run_id: &str,
        status: &str,
        epoch: u64,
        revision: u64,
        run_json: &[u8],
    ) -> Result<FinishReceipt, RuntimeError> {
        if request_id.is_empty() || request_id.len() > 256 {
            return Err(RuntimeError::InvalidCommand("invalid completion request id".into()));
        }
        let supplied = crate::completion::decode_run_document(&self.id, run_id, status, run_json)?;
        let identity = serde_json::to_string(&(run_id, status, &supplied))
            .map_err(|error| RuntimeError::InvalidCommand(error.to_string()))?;
        if let Some(saved) = self.receipt("finish", request_id) {
            if saved.fingerprint != identity {
                return Err(RuntimeError::RequestConflict);
            }
            let mut receipt: FinishReceipt = from_value(saved.result.clone())?;
            receipt.reused = true;
            return Ok(receipt);
        }
        ensure_epoch(&self.state, epoch)?;
        ensure_revision(&self.state, revision)?;
        if self.state.active_run_id.as_deref() != Some(run_id) {
            return Err(RuntimeError::InvalidCommand("run is not active".into()));
        }
        if !self.active_runs.contains_key(run_id) {
            return Err(RuntimeError::InvalidCommand("active run is missing".into()));
        }
        let mut control = self.control.clone();
        if let Some(lease) = control.execution_lease.as_mut().filter(|lease| lease.run_id == run_id) {
            if let Some(identity) = supplied.as_ref().and_then(|run| run.pointer("/metadata/executionLease")) {
                let expected = crate::execution::ExecutionLease::decode(&self.id, identity)?;
                if !lease.same_owner(&expected) {
                    return Err(expected.superseded("owner changed before finish"));
                }
            }
            lease.closed = true;
        }
        let mut projection = self.projection.clone().ok_or(RuntimeError::ProjectionMissing)?;
        let projected_document = projection
            .run_id()
            .filter(|id| *id == run_id)
            .map(|_| projection.run.to_json());
        let previous_reason = projection.session.get("blockedReason").map(PValue::to_json).unwrap_or(Value::Null);
        let mut document = supplied
            .or(projected_document)
            .or_else(|| self.active_runs.get(run_id).and_then(|run| run.get("document").cloned()).filter(Value::is_object));
        if let (Some(document), Some(lease)) = (
            document.as_mut(),
            control.execution_lease.as_ref().filter(|lease| lease.run_id == run_id),
        ) {
            if !document["metadata"].is_object() {
                document["metadata"] = json!({});
            }
            document["metadata"]["executionLease"] = to_value(lease)?;
        }
        let mut completion = crate::completion::complete(run_id, status, document, previous_reason)?;
        if matches!(status, "interrupted" | "cancelled" | "failed")
            && let Some(message) = projection.take_partial_message(run_id, &completion.completed_at)
        {
            let mut payload: Value = parse_json(&completion.event.payload)?;
            payload["chunk"]["message"] = message;
            completion.event.payload = value_to_bytes(&payload)?;
        }
        control.permissions.retain(|item| item["action"] == "ask" && item["resolvedAt"].is_null());
        control.interactions.retain(|item| item["consumedAt"].is_null() && (item["status"] == "pending" || !item["response"].is_null()));
        let cursor = self.state.cursor + 1;
        projection.apply(cursor, run_id, &completion.event)?;
        projection.session.set("completedAt", PValue::String(completion.completed_at.clone()));
        let event = StreamEvent {
            sequence: cursor,
            run_id: run_id.to_owned(),
            kind: completion.event.kind,
            payload: completion.event.payload,
            ephemeral: false,
        };
        let receipt = FinishReceipt {
            snapshot: SessionSnapshot {
                session_id: self.id.clone(),
                epoch: self.state.epoch + 1,
                revision: self.state.revision + 1,
                active_run_id: None,
                cursor,
                retained_from: cursor.saturating_sub(crate::jsonl::session::EVENT_WINDOW) + 1,
            },
            event: Some(event.clone()),
            reused: false,
        };
        let mut tx = Tx {
            cursor,
            revision: self.state.revision + 1,
            epoch: self.state.epoch + 1,
            projection,
            control: Some(control),
            active_run_id: Some(None),
            ..Default::default()
        };
        tx.events.push(event.clone());
        tx.fan_out.push(event);
        tx.header = Some(tx.projection.session.clone());
        tx.receipt = Some(("finish".into(), request_id.to_owned(), identity, to_value(&receipt)?));
        self.write(handle, tx)?;
        self.activated_runs.remove(run_id);
        self.terminated_runs.insert(run_id.to_owned());
        self.active_runs.remove(run_id);
        self.state.producer_sequences.clear();
        Ok(receipt)
    }

    /// Append a producer-ordered batch of streamed events.
    pub fn append(
        &mut self,
        handle: &SessionHandle,
        run_id: &str,
        producer_id: &str,
        producer_sequence: u64,
        epoch: u64,
        durability: crate::actor::Durability,
        events: Vec<PendingEvent>,
    ) -> Result<StreamAppendReceipt, RuntimeError> {
        if events.is_empty() {
            return Err(RuntimeError::InvalidCommand("stream batch cannot be empty".to_owned()));
        }
        if events.len() > 256
            || events.iter().any(|event| event.payload.len() + event.kind.len() + run_id.len() > MAX_EVENT_BYTES)
        {
            return Err(RuntimeError::InvalidCommand("stream batch exceeds event or frame budget".into()));
        }
        if durability == crate::actor::Durability::Ephemeral {
            return Err(RuntimeError::InvalidCommand(
                "ephemeral events are published live and never persisted".into(),
            ));
        }
        let fingerprint = append_fingerprint(&self.id, run_id, producer_id, producer_sequence, epoch, durability, &events);
        let key = append_key(producer_id, producer_sequence);
        if let Some(saved) = self.receipt("stream", &key) {
            if saved.fingerprint != fingerprint {
                return Err(RuntimeError::RequestConflict);
            }
            let mut receipt: StreamAppendReceipt = from_value(saved.result.clone())?;
            receipt.reused = true;
            return Ok(receipt);
        }
        // The receipt is keyed by producer sequence, so it must be recorded
        // before the batch can be replayed.
        let _ = &key;
        ensure_epoch(&self.state, epoch)?;
        if self.state.active_run_id.as_deref() != Some(run_id) {
            return Err(RuntimeError::InvalidCommand("run is not active".into()));
        }
        let expected = self.state.producer_sequences.get(producer_id).copied().unwrap_or(0) + 1;
        if producer_sequence < expected {
            return Err(RuntimeError::ProducerSequenceReplay { expected, actual: producer_sequence });
        }
        if producer_sequence > expected {
            return Err(RuntimeError::ProducerSequenceGap { expected, actual: producer_sequence });
        }
        let mut projection = self.projection.clone().ok_or(RuntimeError::ProjectionMissing)?;
        let first = self.state.cursor + 1;
        let mut tx = Tx {
            cursor: self.state.cursor,
            revision: self.state.revision,
            epoch: self.state.epoch,
            projection,
            ..Default::default()
        };
        for pending in events {
            tx.cursor += 1;
            tx.projection.apply(tx.cursor, run_id, &pending)?;
            tx.events.push(StreamEvent {
                sequence: tx.cursor,
                run_id: run_id.to_owned(),
                kind: pending.kind,
                payload: pending.payload,
                ephemeral: false,
            });
        }
        tx.fan_out = tx.events.clone();
        let mut producer_sequences = self.state.producer_sequences.clone();
        producer_sequences.insert(producer_id.to_owned(), producer_sequence);
        tx.header = Some(tx.projection.session.clone());
        let receipt = StreamAppendReceipt {
            reused: false,
            session_id: self.id.clone(),
            run_id: run_id.to_owned(),
            first_sequence: first,
            last_sequence: tx.cursor,
            epoch: self.state.epoch,
        };
        tx.receipt = Some((
            "stream".into(),
            append_key(producer_id, producer_sequence),
            fingerprint,
            to_value(&receipt)?,
        ));
        self.write(handle, tx)?;
        self.state.producer_sequences = producer_sequences;
        Ok(receipt)
    }
}

fn append_key(producer_id: &str, producer_sequence: u64) -> String {
    format!("append:{producer_id}:{producer_sequence}")
}

pub fn hash(value: &impl serde::Serialize) -> Result<String, RuntimeError> {
    let bytes = serde_json::to_vec(value).map_err(|error| RuntimeError::InvalidCommand(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn to_value(value: &impl serde::Serialize) -> Result<Value, RuntimeError> {
    serde_json::to_value(value).map_err(|error| RuntimeError::InvalidCommand(error.to_string()))
}

fn from_value<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, RuntimeError> {
    serde_json::from_value(value).map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))
}
