//! Bounded input queue state machine, evaluated only by its session actor.
use crate::actor::RuntimeError;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_QUEUE: usize = 20;
pub const MAX_QUEUE_BYTES: usize = 512 * 1024;
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueState {
    #[serde(default)]
    pub delivery: Option<Value>,
    pub items: Vec<Value>,
    pub force_inject_item_id: Option<String>,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub consumed: Option<Value>,
}
fn invalid(message: &str) -> RuntimeError {
    RuntimeError::InvalidCommand(message.into())
}
pub fn item_id(value: &Value) -> Result<&str, RuntimeError> {
    value["id"]
        .as_str()
        .filter(|id| !id.trim().is_empty() && id.len() <= 256)
        .ok_or_else(|| invalid("queued input requires a bounded id"))
}
pub fn validate_item(value: &Value) -> Result<(), RuntimeError> {
    item_id(value)?;
    let time = value["enqueuedAt"]
        .as_str()
        .ok_or_else(|| invalid("enqueuedAt is required"))?;
    chrono::DateTime::parse_from_rfc3339(time)
        .map_err(|_| invalid("enqueuedAt must be RFC3339"))?;
    let message = value["message"]
        .as_str()
        .ok_or_else(|| invalid("queued message is required"))?;
    if message.encode_utf16().count() > 100_000 {
        return Err(invalid("queued message is too long"));
    }
    if let Some(parts) = value.get("contentParts") {
        if !parts.is_array() {
            return Err(invalid("invalid contentParts"));
        }
    }
    if message.trim().is_empty()
        && !value["contentParts"]
            .as_array()
            .is_some_and(|parts| !parts.is_empty())
    {
        return Err(invalid("queued input is empty"));
    }
    if let Some(model) = value.get("model").filter(|v| !v.is_null()) {
        if !model
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 1024)
        {
            return Err(invalid("invalid model"));
        }
    }
    if let Some(effort) = value.get("reasoningEffort") {
        if !matches!(
            effort.as_str(),
            Some("none" | "low" | "medium" | "high" | "xhigh" | "max")
        ) {
            return Err(invalid("invalid reasoning effort"));
        }
    }
    if let Some(references) = value.get("references") {
        if !references.as_array().is_some_and(|items| items.len() <= 20) {
            return Err(invalid("invalid queued references"));
        }
    }
    Ok(())
}
impl QueueState {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if let Some(delivery) = &self.delivery {
            if !delivery["runId"]
                .as_str()
                .is_some_and(|id| !id.is_empty() && id.len() <= 256)
            {
                return Err(invalid("invalid delivery owner"));
            }
            validate_item(&delivery["item"])?;
        }
        if self.items.len() > MAX_QUEUE {
            return Err(invalid("input queue is full"));
        }
        let mut ids = std::collections::HashSet::new();
        for item in &self.items {
            validate_item(item)?;
            if !ids.insert(item_id(item)?) {
                return Err(RuntimeError::RequestConflict);
            }
        }
        if self
            .force_inject_item_id
            .as_deref()
            .is_some_and(|id| !ids.contains(id))
        {
            return Err(invalid("force marker refers to missing input"));
        }
        if serde_json::to_vec(self)
            .map_err(|e| invalid(&e.to_string()))?
            .len()
            > MAX_QUEUE_BYTES
        {
            return Err(invalid("input queue exceeds byte budget"));
        }
        Ok(())
    }
    pub fn apply(&mut self, operation: &str, payload: &Value) -> Result<bool, RuntimeError> {
        self.consumed = None;
        let before = (
            self.items.clone(),
            self.force_inject_item_id.clone(),
            self.delivery.clone(),
        );
        match operation {
            "enqueue" => {
                validate_item(payload)?;
                if self.items.len() >= MAX_QUEUE {
                    return Err(invalid("input queue is full"));
                }
                if self.items.iter().any(|item| item["id"] == payload["id"]) {
                    return Err(RuntimeError::RequestConflict);
                }
                self.items.push(payload.clone());
            }
            "remove" | "consume" => {
                let id = item_id(payload)?;
                let index = self
                    .items
                    .iter()
                    .position(|item| item["id"].as_str() == Some(id))
                    .ok_or_else(|| invalid("queued input not found"))?;
                let item = self.items.remove(index);
                if operation == "consume" {
                    if self.delivery.is_some() {
                        return Err(invalid("previous queued input delivery is unacknowledged"));
                    }
                    let run_id = payload["runId"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| invalid("delivery requires runId"))?;
                    self.delivery = Some(serde_json::json!({"runId":run_id,"item":item}));
                    self.consumed = Some(item);
                }
                if self.force_inject_item_id.as_deref() == Some(id) {
                    self.force_inject_item_id = None;
                }
            }
            "move" => {
                let id = item_id(payload)?;
                let index = self
                    .items
                    .iter()
                    .position(|item| item["id"].as_str() == Some(id))
                    .ok_or_else(|| invalid("queued input not found"))?;
                let to = match (payload.get("direction"), payload.get("toIndex")) {
                    (Some(direction), None) => match direction.as_str() {
                        Some("up") => index as i64 - 1,
                        Some("down") => index as i64 + 1,
                        _ => return Err(invalid("invalid queue direction")),
                    },
                    (None, Some(to)) => to
                        .as_i64()
                        .ok_or_else(|| invalid("queue index must be an integer"))?,
                    _ => return Err(invalid("choose direction or toIndex")),
                };
                if to >= 0 && to < self.items.len() as i64 && to != index as i64 {
                    let item = self.items.remove(index);
                    self.items.insert(to as usize, item);
                }
            }
            "force" => {
                let id = item_id(payload)?;
                if !self
                    .items
                    .iter()
                    .any(|item| item["id"].as_str() == Some(id))
                {
                    return Err(invalid("queued input not found"));
                }
                self.force_inject_item_id = Some(id.into());
            }
            "ack_consume" => {
                let id = item_id(payload)?;
                let delivery = self
                    .delivery
                    .as_ref()
                    .ok_or_else(|| invalid("no pending input delivery"))?;
                if delivery["runId"] != payload["runId"]
                    || delivery["item"]["id"].as_str() != Some(id)
                {
                    return Err(invalid("input delivery identity mismatch"));
                }
                self.delivery = None;
            }
            "clear_force" => {
                self.force_inject_item_id = None;
            }
            _ => return Err(invalid("unknown queue operation")),
        }
        self.validate()?;
        let changed = before.0 != self.items
            || before.1 != self.force_inject_item_id
            || before.2 != self.delivery;
        if changed {
            self.revision += 1;
        }
        Ok(changed)
    }
}
