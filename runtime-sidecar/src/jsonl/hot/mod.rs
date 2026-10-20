//! Hot-path operations and the façade the router calls.

pub mod control;
pub mod ops;

use std::sync::Arc;

use crate::actor::{
    ControlCommandReceipt, Durability, PendingEvent, RunAdmission, RuntimeError, SessionSnapshot,
    StreamAppendReceipt, StreamEvent,
};
use crate::jsonl::error::JsonlError;
use crate::jsonl::session::SessionHandle;
use crate::jsonl::store::JsonlStore;
use crate::session_types::{ActivationReceipt, FinishReceipt, QueueMutationReceipt};

pub use crate::jsonl::error::JsonlError as StorageError;

#[derive(Clone)]
pub struct HotOps {
    store: Arc<JsonlStore>,
}

impl HotOps {
    pub fn new(store: Arc<JsonlStore>) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &JsonlStore {
        &self.store
    }

    pub fn root(&self) -> &std::path::Path {
        self.store.root()
    }

    pub fn handle(&self, session_id: &str) -> Result<SessionHandle, RuntimeError> {
        self.store.session(session_id).map_err(RuntimeError::from)
    }

    pub fn snapshot(&self, session_id: &str) -> Result<SessionSnapshot, RuntimeError> {
        Ok(self.handle(session_id)?.snapshot())
    }

    pub fn ui_snapshot(&self, session_id: &str, seed: Option<&[u8]>) -> Result<Vec<u8>, RuntimeError> {
        let handle = self.handle(session_id)?;
        match seed {
            Some(seed) => handle.seed(seed),
            None => handle.ui_snapshot(),
        }
    }

    pub fn replay(&self, session_id: &str, after: u64, max_events: usize, max_bytes: usize) -> Result<Vec<StreamEvent>, RuntimeError> {
        let handle = self.handle(session_id)?;
        let lake = handle.read();
        if after > 0 && after + 1 < lake.state.retained_from {
            return Err(RuntimeError::CursorExpired { after, retained_from: lake.state.retained_from });
        }
        let mut events = Vec::new();
        let mut bytes = 0usize;
        for event in lake.snapshot_events(after) {
            if events.len() >= max_events || bytes + event.payload.len() > max_bytes {
                break;
            }
            bytes += event.payload.len();
            events.push(event);
        }
        Ok(events)
    }

    pub fn subscribe(
        &self,
        session_id: &str,
        after: u64,
        capacity: usize,
    ) -> Result<(SessionSnapshot, Vec<StreamEvent>, tokio::sync::mpsc::Receiver<Arc<StreamEvent>>), RuntimeError> {
        let handle = self.handle(session_id)?;
        let (sender, receiver) = tokio::sync::mpsc::channel(capacity);
        let mut actor = handle.actor.lock();
        let backlog = crate::jsonl::session::backlog(&handle.read(), after, 4 * 1024 * 1024)?;
        actor.subscribers.retain(|subscriber| !subscriber.is_closed());
        actor.subscribers.push(sender);
        Ok((handle.snapshot(), backlog, receiver))
    }

    pub fn admit_run(&self, session_id: &str, request_id: &str, body_hash: &str, run_id: &str, epoch: u64, expected_revision: u64, queue_item: &[u8], run_json: &[u8]) -> Result<RunAdmission, RuntimeError> {
        let handle = self.handle(session_id)?;
        let mut actor = handle.actor.lock();
        actor.run_admission(&handle, request_id, body_hash, run_id, epoch, expected_revision, queue_item, run_json)
    }

    pub fn activate_run(&self, session_id: &str, request_id: &str, run_json: &[u8], epoch: u64, revision: u64) -> Result<ActivationReceipt, RuntimeError> {
        let handle = self.handle(session_id)?;
        let mut actor = handle.actor.lock();
        actor.activate(&handle, request_id, run_json, epoch, revision)
    }

    pub fn finish_run(&self, session_id: &str, request_id: &str, run_id: &str, status: &str, epoch: u64, revision: u64, run_json: &[u8]) -> Result<FinishReceipt, RuntimeError> {
        let handle = self.handle(session_id)?;
        let mut actor = handle.actor.lock();
        actor.finish(&handle, request_id, run_id, status, epoch, revision, run_json)
    }

    pub fn append_stream(&self, session_id: &str, run_id: &str, producer_id: &str, producer_sequence: u64, epoch: u64, durability: Durability, events: Vec<PendingEvent>) -> Result<StreamAppendReceipt, RuntimeError> {
        let handle = self.handle(session_id)?;
        let mut actor = handle.actor.lock();
        actor.append(&handle, run_id, producer_id, producer_sequence, epoch, durability, events)
    }

    pub fn control(&self, session_id: &str, request_id: &str, epoch: u64, revision: u64, operation: &str, payload: &[u8]) -> Result<ControlCommandReceipt, RuntimeError> {
        self.handle(session_id)?.control(request_id, epoch, revision, operation, payload)
    }

    pub fn queue_read(&self, session_id: &str) -> Result<Vec<u8>, RuntimeError> {
        let actor = self.handle(session_id)?.actor.clone();
        let actor = actor.lock();
        serde_json::to_vec(&actor.queue).map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))
    }

    pub fn queue_mutation(&self, session_id: &str, request_id: &str, epoch: u64, revision: u64, operation: &str, payload: &[u8]) -> Result<QueueMutationReceipt, RuntimeError> {
        let handle = self.handle(session_id)?;
        let mut actor = handle.actor.lock();
        actor.queue_mutation(&handle, request_id, epoch, revision, operation, payload)
    }

    /// Make every session's appended frames durable.
    pub fn flush(&self) -> Result<(), JsonlError> {
        self.store.flush()
    }

    /// Drop every session (test reset).
    pub fn reset_for_tests(&self) -> Result<(), JsonlError> {
        self.store.reset_all()
    }

    /// Append one agent-loop checkpoint batch.
    pub fn commit_agent_loop(&self, loop_id: String, checkpoint: Vec<u8>, events: Vec<(u64, Vec<u8>)>) -> Result<(), JsonlError> {
        let root = self.root();
        let checkpoint: serde_json::Value = serde_json::from_slice(&checkpoint)
            .map_err(|error| JsonlError::corrupt(root, 0, error.to_string()))?;
        let raw = serde_json::value::to_raw_value(&checkpoint)
            .map_err(|error| JsonlError::corrupt(root, 0, error.to_string()))?;
        let mut owned: Vec<(u64, Box<serde_json::value::RawValue>)> = Vec::with_capacity(events.len());
        for (sequence, payload) in &events {
            let value: serde_json::Value = serde_json::from_slice(payload)
                .map_err(|error| JsonlError::corrupt(root, 0, error.to_string()))?;
            let raw = serde_json::value::to_raw_value(&value)
                .map_err(|error| JsonlError::corrupt(root, 0, error.to_string()))?;
            owned.push((*sequence, raw));
        }
        let sequence = owned.last().map(|(sequence, _)| *sequence).unwrap_or(0);
        let borrowed: Vec<(u64, &serde_json::value::RawValue)> = owned.iter().map(|(sequence, value)| (*sequence, value.as_ref())).collect();
        let mut journal = crate::jsonl::loop_journal::LoopJournal::open(root, &loop_id)?;
        journal.append(Some((&raw, sequence)), &borrowed)?;
        journal.sync()
    }

    pub fn load_agent_loop(&self, loop_id: String) -> Result<Option<(Vec<u8>, Vec<Vec<u8>>)>, JsonlError> {
        Ok(crate::jsonl::loop_journal::LoopJournal::load(self.root(), &loop_id)?
            .map(|journal| (journal.checkpoint, journal.events)))
    }

    /// The outbox was folded into the hot commit: nothing is ever pending.
    pub fn history_outbox(&self, _session_id: &str, _limit: usize) -> Vec<StreamEvent> {
        Vec::new()
    }
}
