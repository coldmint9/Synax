//! The provider boundary owns wire-name validity, including callers and
//! checkpoints created before host-side tool-name mapping was introduced.
use crate::llm::contract::ProviderRequest;
use rig_core::message::{AssistantContent, Message, ToolName};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

type Error = Box<dyn std::error::Error + Send + Sync>;

pub(crate) fn valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn wire_name(name: &str) -> Result<String, Error> {
    if name.is_empty() {
        return Err("function tool name is empty".into());
    }
    if valid(name) {
        return Ok(name.into());
    }
    let prefix: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    let hash = format!("{:x}", Sha256::digest(name.as_bytes()));
    Ok(format!("{prefix}__{}", &hash[..16]))
}

#[derive(Default)]
pub(crate) struct ToolNames {
    aliases: HashMap<String, String>,
    runtime: HashMap<String, String>,
}

impl ToolNames {
    pub(crate) fn prepare(mut input: ProviderRequest) -> Result<(ProviderRequest, Self), Error> {
        let mut names = Self::default();
        for tool in &mut input.tools {
            if tool["type"] == "provider" {
                continue;
            }
            let original = tool["name"]
                .as_str()
                .ok_or("function tool name is missing")?
                .to_owned();
            let wire = wire_name(&original)?;
            let runtime = tool["runtimeName"].as_str().unwrap_or(&original).to_owned();
            if names
                .runtime
                .insert(wire.clone(), runtime.clone())
                .is_some()
            {
                return Err(
                    format!("duplicate or colliding function tool name '{original}'").into(),
                );
            }
            names.aliases.insert(original, wire.clone());
            // A runtime ID can also appear in older assistant messages.
            names.aliases.entry(runtime).or_insert_with(|| wire.clone());
            tool["name"] = Value::String(wire);
        }
        if let Some(choice) = input.tool_choice.as_mut() {
            if choice["type"] == "tool" {
                let name = choice["toolName"]
                    .as_str()
                    .ok_or("specific tool choice has no name")?;
                let wire = names
                    .aliases
                    .get(name)
                    .ok_or("specific tool choice is not declared")?
                    .clone();
                choice["toolName"] = Value::String(wire);
            }
        }
        for message in &mut input.prompt {
            names.rewrite_message(message)?;
        }
        Ok((input, names))
    }

    fn encode(&self, name: &str) -> Result<String, Error> {
        self.aliases
            .get(name)
            .cloned()
            .map(Ok)
            .unwrap_or_else(|| wire_name(name))
    }

    pub(crate) fn runtime_name<'a>(&'a self, wire: &'a str) -> &'a str {
        self.runtime.get(wire).map(String::as_str).unwrap_or(wire)
    }

    fn rewrite_message(&self, message: &mut Value) -> Result<(), Error> {
        if let Some(rig) = message.get_mut("rigMessage") {
            let mut parsed: Message = serde_json::from_value(rig.clone())?;
            if let Message::Assistant(assistant) = &mut parsed {
                for block in &mut assistant.content {
                    if let AssistantContent::ToolCall(call) = block {
                        let encoded = self.encode(call.function.name.as_str())?;
                        if encoded != call.function.name.as_str() {
                            call.function.name = ToolName::new(encoded.clone())?;
                            let item = call.native.take().map(|mut native| {
                                native.item["name"] = Value::String(encoded);
                                native.item
                            });
                            if let Some(item) = item {
                                *block = block.clone().with_native(item);
                            }
                        }
                    }
                }
            }
            *rig = serde_json::to_value(parsed)?;
        }
        if let Some(parts) = message["content"].as_array_mut() {
            for part in parts {
                let key = match part["type"].as_str() {
                    Some("tool-call" | "tool-result") => "toolName",
                    Some("tool_use") => "name",
                    _ => continue,
                };
                if let Some(name) = part.get(key).and_then(Value::as_str) {
                    part[key] = Value::String(self.encode(name)?);
                }
            }
        }
        Ok(())
    }
}

/// Inspect the serialized protocol body after middleware / extra options have
/// been applied. No caller can bypass the provider's function-name contract.
pub(crate) fn validate_body(body: &Value, protocol: &str) -> Result<(), Error> {
    if let Some(tools) = body["tools"].as_array() {
        for (index, tool) in tools.iter().enumerate() {
            let name = if protocol == "openai" {
                tool.pointer("/function/name")
            } else {
                tool.get("name")
            };
            if let Some(name) = name.and_then(Value::as_str) {
                if !valid(name) {
                    return Err(format!("invalid function name at tools[{index}]: '{name}'").into());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn maps_legacy_names_without_collisions_and_preserves_dispatch_and_choice() {
        let original: ProviderRequest = serde_json::from_value(json!({"apiFormat":"openai-responses","model":"fixture",
            "tools":[{"name":"file.read"},{"name":"file/read"},{"name":"file_read"},{"name":"mcp.tool:含中文"}],
            "toolChoice":{"type":"tool","toolName":"file.read"},
            "prompt":[{"role":"assistant","content":[{"type":"tool-call","toolCallId":"c","toolName":"file.read","input":{}}]}]})).unwrap();
        let (encoded, names) = ToolNames::prepare(original).unwrap();
        let values: Vec<_> = encoded
            .tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert!(values.iter().all(|name| valid(name)));
        assert_eq!(
            values
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            4
        );
        assert_eq!(names.runtime_name(values[0]), "file.read");
        assert_eq!(encoded.tool_choice.unwrap()["toolName"], values[0]);
        assert_eq!(encoded.prompt[0]["content"][0]["toolName"], values[0]);
        assert_eq!(values[2], "file_read");
    }
    #[test]
    fn validates_all_three_serialized_tool_shapes() {
        assert!(
            validate_body(
                &json!({"tools":[{"type":"function","function":{"name":"file.read"}}]}),
                "openai"
            )
            .is_err()
        );
        for protocol in ["openai-responses", "anthropic"] {
            assert!(validate_body(&json!({"tools":[{"name":"file.read"}]}), protocol).is_err());
            assert!(validate_body(&json!({"tools":[{"name":"file_read"}]}), protocol).is_ok());
        }
    }
    #[test]
    fn long_unicode_names_are_bounded_and_stable() {
        let name = "工具".repeat(90);
        let encoded = wire_name(&name).unwrap();
        assert!(valid(&encoded));
        assert_eq!(wire_name(&name).unwrap(), encoded);
    }
}
