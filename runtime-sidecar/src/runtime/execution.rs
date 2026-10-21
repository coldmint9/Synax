//! Execution ownership is control state, independent of the UI's run/status projection.
use crate::runtime::actor::RuntimeError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionLease {
    pub session_id: String,
    pub run_id: String,
    pub epoch: String,
    pub host_id: String,
    #[serde(default)]
    pub closed: bool,
}

impl ExecutionLease {
    pub fn decode(session_id: &str, value: &serde_json::Value) -> Result<Self, RuntimeError> {
        let mut lease: Self = serde_json::from_value(value.clone())
            .map_err(|_| RuntimeError::InvalidCommand("invalid execution lease identity".into()))?;
        if lease.session_id != session_id
            || [&lease.run_id, &lease.epoch, &lease.host_id]
                .iter()
                .any(|value| value.is_empty() || value.len() > 256)
        {
            return Err(RuntimeError::InvalidCommand(
                "invalid execution lease identity".into(),
            ));
        }
        lease.closed = false;
        Ok(lease)
    }

    pub fn same_owner(&self, other: &Self) -> bool {
        self.session_id == other.session_id
            && self.run_id == other.run_id
            && self.epoch == other.epoch
            && self.host_id == other.host_id
    }

    pub fn superseded(&self, reason: &str) -> RuntimeError {
        RuntimeError::ExecutionSuperseded(format!(
            "Execution lease is no longer current ({reason}; session={}, run={}, epoch={}).",
            self.session_id, self.run_id, self.epoch,
        ))
    }

    pub fn assert_current(
        &self,
        active_run_id: Option<&str>,
        current: Option<&Self>,
    ) -> Result<(), RuntimeError> {
        if active_run_id != Some(self.run_id.as_str()) {
            return Err(self.superseded("run finished or replaced"));
        }
        let current = current.ok_or_else(|| self.superseded("lease missing"))?;
        if !self.same_owner(current) {
            return Err(self.superseded("owner changed"));
        }
        if current.closed {
            return Err(self.superseded("lease closed"));
        }
        Ok(())
    }
}
