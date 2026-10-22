//! Hot-path operations and the façade the router calls.

pub mod control;
pub mod ops;

use std::sync::Arc;

use crate::runtime::actor::{
    ControlCommandReceipt, Durability, PendingEvent, RunAdmission, RuntimeError, SessionSnapshot,
    StreamAppendReceipt, StreamEvent,
};
use crate::runtime::session_types::{ActivationReceipt, FinishReceipt, QueueMutationReceipt};
use crate::storage::jsonl::error::JsonlError;
use crate::storage::jsonl::session::SessionHandle;
use crate::storage::jsonl::store::JsonlStore;

pub use crate::storage::jsonl::error::JsonlError as StorageError;

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

    fn refresh_list(&self, handle: &SessionHandle) -> Result<(), RuntimeError> {
        let row = {
            let actor = handle.actor.lock();
            crate::storage::jsonl::session::list_row(&actor)
        };
        self.store.update_list(row).map_err(RuntimeError::from)
    }

    pub fn snapshot(&self, session_id: &str) -> Result<SessionSnapshot, RuntimeError> {
        Ok(self.handle(session_id)?.snapshot())
    }

    pub fn ui_snapshot(
        &self,
        session_id: &str,
        seed: Option<&[u8]>,
    ) -> Result<Vec<u8>, RuntimeError> {
        let handle = self.handle(session_id)?;
        match seed {
            Some(seed) => {
                let result = handle.seed(seed)?;
                self.refresh_list(&handle)?;
                Ok(result)
            }
            None => handle.ui_snapshot(),
        }
    }

    pub fn replay(
        &self,
        session_id: &str,
        after: u64,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<Vec<StreamEvent>, RuntimeError> {
        let handle = self.handle(session_id)?;
        let lake = handle.read();
        if after > 0 && after + 1 < lake.state.retained_from {
            return Err(RuntimeError::CursorExpired {
                after,
                retained_from: lake.state.retained_from,
            });
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
    ) -> Result<
        (
            SessionSnapshot,
            Vec<StreamEvent>,
            tokio::sync::mpsc::Receiver<Arc<StreamEvent>>,
        ),
        RuntimeError,
    > {
        let handle = self.handle(session_id)?;
        let (sender, receiver) = tokio::sync::mpsc::channel(capacity);
        let mut actor = handle.actor.lock();
        let backlog =
            crate::storage::jsonl::session::backlog(&handle.read(), after, 4 * 1024 * 1024)?;
        actor
            .subscribers
            .retain(|subscriber| !subscriber.is_closed());
        actor.subscribers.push(sender);
        Ok((handle.snapshot(), backlog, receiver))
    }

    pub fn admit_run(
        &self,
        session_id: &str,
        request_id: &str,
        body_hash: &str,
        run_id: &str,
        epoch: u64,
        expected_revision: u64,
        queue_item: &[u8],
        run_json: &[u8],
    ) -> Result<RunAdmission, RuntimeError> {
        let handle = self.handle(session_id)?;
        let mut actor = handle.actor.lock();
        let result = actor.run_admission(
            &handle,
            request_id,
            body_hash,
            run_id,
            epoch,
            expected_revision,
            queue_item,
            run_json,
        )?;
        drop(actor);
        self.refresh_list(&handle)?;
        Ok(result)
    }

    pub fn activate_run(
        &self,
        session_id: &str,
        request_id: &str,
        run_json: &[u8],
        epoch: u64,
        revision: u64,
    ) -> Result<ActivationReceipt, RuntimeError> {
        let handle = self.handle(session_id)?;
        let mut actor = handle.actor.lock();
        let result = actor.activate(&handle, request_id, run_json, epoch, revision)?;
        drop(actor);
        self.refresh_list(&handle)?;
        Ok(result)
    }

    pub fn finish_run(
        &self,
        session_id: &str,
        request_id: &str,
        run_id: &str,
        status: &str,
        epoch: u64,
        revision: u64,
        run_json: &[u8],
    ) -> Result<FinishReceipt, RuntimeError> {
        let handle = self.handle(session_id)?;
        let mut actor = handle.actor.lock();
        let result = actor.finish(
            &handle, request_id, run_id, status, epoch, revision, run_json,
        )?;
        drop(actor);
        self.refresh_list(&handle)?;
        Ok(result)
    }

    pub fn append_stream(
        &self,
        session_id: &str,
        run_id: &str,
        producer_id: &str,
        producer_sequence: u64,
        epoch: u64,
        durability: Durability,
        events: Vec<PendingEvent>,
    ) -> Result<StreamAppendReceipt, RuntimeError> {
        let handle = self.handle(session_id)?;
        let mut actor = handle.actor.lock();
        let result = actor.append(
            &handle,
            run_id,
            producer_id,
            producer_sequence,
            epoch,
            durability,
            events,
        )?;
        drop(actor);
        self.refresh_list(&handle)?;
        Ok(result)
    }

    pub fn control(
        &self,
        session_id: &str,
        request_id: &str,
        epoch: u64,
        revision: u64,
        operation: &str,
        payload: &[u8],
    ) -> Result<ControlCommandReceipt, RuntimeError> {
        let handle = self.handle(session_id)?;
        let result = handle.control(request_id, epoch, revision, operation, payload)?;
        self.refresh_list(&handle)?;
        Ok(result)
    }

    pub fn queue_read(&self, session_id: &str) -> Result<Vec<u8>, RuntimeError> {
        let lake = self.handle(session_id)?.read();
        serde_json::to_vec(&*lake.queue)
            .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))
    }

    pub fn queue_mutation(
        &self,
        session_id: &str,
        request_id: &str,
        epoch: u64,
        revision: u64,
        operation: &str,
        payload: &[u8],
    ) -> Result<QueueMutationReceipt, RuntimeError> {
        let handle = self.handle(session_id)?;
        let mut actor = handle.actor.lock();
        let result =
            actor.queue_mutation(&handle, request_id, epoch, revision, operation, payload)?;
        drop(actor);
        self.refresh_list(&handle)?;
        Ok(result)
    }

    /// Make every session's appended frames durable.
    pub fn flush(&self) -> Result<(), JsonlError> {
        self.store.flush()
    }

    pub fn flush_session(&self, session_id: &str) -> Result<(), JsonlError> {
        self.store.flush_session(session_id)
    }

    /// Drop every session (test reset).
    pub fn reset_for_tests(&self) -> Result<(), JsonlError> {
        self.store.reset_all()
    }

    /// A small durable identity prevents a lost start acknowledgement from
    /// starting the same execution again after a process restart.
    pub fn claim_agent_loop(
        &self,
        loop_id: &str,
        fingerprint: &str,
        request_id: Option<&str>,
        run_id: Option<&str>,
    ) -> Result<bool, JsonlError> {
        use std::io::Write;
        crate::storage::jsonl::layout::validate_loop_id(loop_id)?;
        let directory = self.root().join("loop-receipts");
        let path = directory.join(format!("{loop_id}.json"));
        if path.exists() {
            let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
            if saved["fingerprint"] != fingerprint {
                return Err(JsonlError::Runtime(RuntimeError::RequestConflict));
            }
            return Ok(false);
        }
        // An old journal is evidence of a previous execution, never a resume base.
        if crate::storage::jsonl::layout::loop_journal_path(self.root(), loop_id)?.exists() {
            return Ok(false);
        }
        std::fs::create_dir_all(&directory).map_err(JsonlError::io)?;
        let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec(
            &serde_json::json!({"version":2,"loopId":loop_id,"requestId":request_id,"runId":run_id,"fingerprint":fingerprint}),
        )?;
        let mut file = std::fs::File::create(&temporary).map_err(JsonlError::io)?;
        file.write_all(&bytes).map_err(JsonlError::io)?;
        file.sync_all().map_err(JsonlError::io)?;
        std::fs::rename(&temporary, &path).map_err(JsonlError::io)?;
        #[cfg(unix)]
        std::fs::File::open(&directory)?
            .sync_all()
            .map_err(JsonlError::io)?;
        Ok(true)
    }

    /// The outbox was folded into the hot commit: nothing is ever pending.
    pub fn history_outbox(&self, _session_id: &str, _limit: usize) -> Vec<StreamEvent> {
        Vec::new()
    }
}
