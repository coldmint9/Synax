//! Process identities are independent records, not edits to the session's
//! lifecycle revision. Apply each update under the actor lock and acknowledge
//! only after the router's durability barrier. No transcript event is needed.
use serde_json::{Value, json};

use crate::runtime::actor::{ControlCommandReceipt, RuntimeError};
use crate::runtime::execution::ExecutionLease;
use crate::storage::jsonl::session::{SessionActor, Tx};

use super::ops::{hash, required_string, snapshot_of, value_to_bytes};

impl SessionActor {
    pub(super) fn update_process_lease(
        &mut self,
        session_id: &str,
        request_id: &str,
        value: &Value,
    ) -> Result<ControlCommandReceipt, RuntimeError> {
        let identity = hash(&("process-lease.v1", value))?;
        if let Some(saved) = self.receipt("control", request_id) {
            if saved.fingerprint != identity {
                return Err(RuntimeError::RequestConflict);
            }
            let mut receipt: ControlCommandReceipt = serde_json::from_slice(&saved.result)
                .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))?;
            receipt.reused = true;
            return Ok(receipt);
        }
        let operation = required_string(value, "operation")?;
        if !matches!(operation, "lease_open" | "lease_close") {
            return Err(RuntimeError::InvalidCommand(
                "invalid process lease operation".into(),
            ));
        }
        let lease = &value["lease"];
        let id = required_string(lease, "leaseId")?;
        if id.len() > 256 {
            return Err(RuntimeError::InvalidCommand(
                "invalid process lease id".into(),
            ));
        }
        let existing = self
            .control
            .process_leases
            .iter()
            .find(|item| item["leaseId"] == id);
        if operation == "lease_open" {
            let host = required_string(lease, "hostId")?;
            if host.len() > 256 || existing.is_some_and(|item| item["hostId"] != host) {
                return Err(RuntimeError::InvalidCommand(
                    "process lease owner changed".into(),
                ));
            }
            if self.control.runtime_control.is_some() {
                return Err(RuntimeError::ExecutionSuperseded(
                    "process launch is stopping".into(),
                ));
            }
            if let Some(owner) = lease.get("executionLease").filter(|v| !v.is_null()) {
                let owner = ExecutionLease::decode(session_id, owner)?;
                if lease["runId"] != owner.run_id || host != owner.host_id {
                    return Err(RuntimeError::InvalidCommand(
                        "process lease execution identity mismatch".into(),
                    ));
                }
                owner.assert_current(
                    self.state.active_run_id.as_deref(),
                    self.control.execution_lease.as_ref(),
                )?;
            } else if lease.get("runId").is_some_and(|v| !v.is_null()) {
                // A run-scoped launcher must prove its generation, not just
                // name a run that could have been taken over by another worker.
                return Err(RuntimeError::InvalidCommand(
                    "process lease requires execution identity".into(),
                ));
            }
            if existing.is_none() && self.control.process_leases.len() >= 1024 {
                return Err(RuntimeError::Backpressure);
            }
        }
        // Closing an old, uniquely named lease remains legal after stop or
        // takeover. It cannot remove any replacement process's identity.
        let mut control = self.control.clone();
        control.process_leases.retain(|item| item["leaseId"] != id);
        if operation == "lease_open" {
            control.process_leases.push(lease.clone());
        }
        let projection = self
            .projection
            .clone()
            .ok_or(RuntimeError::ProjectionMissing)?;
        let receipt = ControlCommandReceipt {
            state_json: value_to_bytes(
                &json!({"leaseId":id,"state":if operation == "lease_close" {"closed"} else {"open"}}),
            )?,
            snapshot: snapshot_of(&self.state, session_id),
            event: None,
            reused: false,
        };
        let tx = Tx {
            control_only: true,
            cursor: self.state.cursor,
            revision: self.state.revision,
            epoch: self.state.epoch,
            projection,
            control: Some(control),
            receipt: Some((
                "control".into(),
                request_id.into(),
                identity,
                serde_json::to_value(&receipt)
                    .map_err(|error| RuntimeError::StorageUnavailable(error.to_string()))?,
            )),
            ..Default::default()
        };
        self.write(&self.this(), tx)?;
        Ok(receipt)
    }
}
