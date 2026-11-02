//! The provider boundary owns wire-name validity, including callers and
//! checkpoints created before host-side tool-name mapping was introduced.
use crate::llm::contract::ProviderRequest;
use rig_core::message::{AssistantContent, Message, ToolName};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

type Error = Box<dyn std::error::Error + Send + Sync>;

pub(crate) fn valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn sanitized(name: &str) -> String {
    let mapped: String = name
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
    if mapped.is_empty() {
        "tool".into()
    } else {
        mapped
    }
}

fn hashed(name: &str) -> String {
    let hash = format!("{:x}", Sha256::digest(name.as_bytes()));
    format!("{}__{}", sanitized(name), &hash[..16])
}

/// Unknown/historical names must never collide with a live wire name, so they
/// keep the hash suffix. Live tools prefer the readable spelling instead.
fn wire_name(name: &str) -> Result<String, Error> {
    if name.is_empty() {
        return Err("function tool name is empty".into());
    }
    Ok(if valid(name) {
        name.into()
    } else {
        hashed(name)
    })
}

/// Canonical, provider-independent form of a tool name: separators collapse,
/// camelCase splits, and a `__<hash>` wire suffix is dropped.
fn normalize(name: &str) -> String {
    let base = without_wire_hash(name.trim());
    let mut normalized = String::new();
    let mut previous: Option<char> = None;
    for ch in base.chars() {
        if let Some(prev) = previous {
            if prev.is_ascii_lowercase() && ch.is_ascii_uppercase() {
                normalized.push('_');
            }
        }
        if ch.is_ascii_alphanumeric() {
            normalized.push(ch.to_ascii_lowercase());
        } else if !normalized.is_empty() && !normalized.ends_with('_') {
            normalized.push('_');
        }
        previous = Some(ch);
    }
    while normalized.ends_with('_') {
        normalized.pop();
    }
    normalized
}

fn without_wire_hash(name: &str) -> &str {
    match name.rsplit_once("__") {
        Some((prefix, hash))
            if hash.len() == 16 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
        {
            prefix
        }
        _ => name,
    }
}

#[derive(Default)]
pub(crate) struct ToolNames {
    aliases: HashMap<String, String>,
    runtime: HashMap<String, String>,
    normalized: HashMap<String, String>,
    ambiguous: HashSet<String>,
}

impl ToolNames {
    pub(crate) fn prepare(mut input: ProviderRequest) -> Result<(ProviderRequest, Self), Error> {
        let mut names = Self::default();
        // Names that are already valid keep their spelling; reserve them first
        // so a sanitized sibling can never take the exact name a model knows.
        let mut reserved = HashSet::new();
        for tool in &input.tools {
            if tool["type"] == "provider" {
                continue;
            }
            let original = tool["name"]
                .as_str()
                .ok_or("function tool name is missing")?;
            if valid(original) {
                reserved.insert(original.to_owned());
            }
        }
        let mut used = HashSet::new();
        for tool in &mut input.tools {
            if tool["type"] == "provider" {
                continue;
            }
            let original = tool["name"]
                .as_str()
                .ok_or("function tool name is missing")?
                .to_owned();
            // A readable name is what the model can echo back unchanged; the
            // hash only disambiguates real collisions.
            let wire = if valid(&original) {
                original.clone()
            } else {
                let candidate = sanitized(&original);
                if reserved.contains(&candidate) || used.contains(&candidate) {
                    hashed(&original)
                } else {
                    candidate
                }
            };
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
            used.insert(wire.clone());
            names.note_normalized(&runtime, &runtime);
            names.note_normalized(&wire, &runtime);
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
        if let Some(runtime) = self.runtime.get(wire) {
            return runtime;
        }
        // A model may drop the hash suffix or rewrite separators even though
        // the tool exists. Normalized aliases keep that call resolvable.
        if let Some(runtime) = self.normalized.get(&normalize(wire)) {
            return runtime;
        }
        wire
    }

    fn note_normalized(&mut self, name: &str, runtime: &str) {
        let key = normalize(name);
        if key.is_empty() || self.ambiguous.contains(&key) {
            return;
        }
        match self.normalized.get(&key) {
            None => {
                self.normalized.insert(key, runtime.to_owned());
            }
            Some(existing) if existing == runtime => {}
            Some(_) => {
                self.normalized.remove(&key);
                self.ambiguous.insert(key);
            }
        }
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
    fn keeps_readable_wire_names_when_nothing_collides() {
        let original: ProviderRequest = serde_json::from_value(json!({
        "apiFormat":"openai-responses","model":"fixture",
        "tools":[
            {"name":"file.write","runtimeName":"file.write"},
            {"name":"file.read","runtimeName":"file.read"}
        ]}))
        .unwrap();
        let (encoded, names) = ToolNames::prepare(original).unwrap();
        let values: Vec<_> = encoded
            .tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        // A model can only echo a name it can read; hashes stay a collision fallback.
        assert_eq!(values, vec!["file_write", "file_read"]);
        assert_eq!(names.runtime_name("file_write"), "file.write");
        assert_eq!(
            names.runtime_name("file_write__0123456789abcdef"),
            "file.write"
        );
        assert_eq!(names.runtime_name("File.Write"), "file.write");
        // Unknown vocabulary stays raw here; the host owns the alias table.
        assert_eq!(names.runtime_name("write"), "write");
    }
    #[test]
    fn hashes_only_the_colliding_sanitized_name() {
        let original: ProviderRequest = serde_json::from_value(json!({
        "apiFormat":"openai-responses","model":"fixture",
        "tools":[
            {"name":"file/read","runtimeName":"file/read"},
            {"name":"file.read","runtimeName":"file.read"}
        ]}))
        .unwrap();
        let (encoded, names) = ToolNames::prepare(original).unwrap();
        let values: Vec<_> = encoded
            .tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(values[0], "file_read");
        assert!(values[1].starts_with("file_read__"));
        assert!(valid(values[1]));
        assert_eq!(names.runtime_name(values[0]), "file/read");
        assert_eq!(names.runtime_name(values[1]), "file.read");
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
