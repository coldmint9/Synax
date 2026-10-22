//! Cache marker allocation follows tools → system → history wire order.
use super::contract::ProviderRequest;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Clone)]
struct Target {
    path: String,
    index: Option<usize>,
    existing: Option<Value>,
}

fn control(value: &Value) -> Option<Value> {
    let marker = value
        .pointer("/providerOptions/anthropic/cacheControl")
        .or_else(|| value.pointer("/providerOptions/anthropic/cache_control"))?;
    if marker["type"] != "ephemeral"
        || !matches!(
            marker.get("ttl").and_then(Value::as_str),
            None | Some("5m" | "1h")
        )
    {
        return None;
    }
    Some(marker.clone())
}
fn clear(value: &mut Value) {
    if let Some(options) = value
        .pointer_mut("/providerOptions/anthropic")
        .and_then(Value::as_object_mut)
    {
        options.remove("cacheControl");
        options.remove("cache_control");
    }
    if let Some(parts) = value.get_mut("content").and_then(Value::as_array_mut) {
        for part in parts {
            clear(part);
        }
    }
    if value["type"] == "tool-result" {
        if let Some(output) = value.get_mut("output") {
            clear(output);
        }
    }
    if value["type"] == "content" {
        if let Some(parts) = value.get_mut("value").and_then(Value::as_array_mut) {
            for part in parts {
                clear(part);
            }
        }
    }
}
fn reminder(message: &Value) -> bool {
    let content = &message["content"];
    let text = content
        .as_str()
        .or_else(|| {
            content
                .as_array()
                .filter(|parts| parts.len() == 1)
                .and_then(|parts| parts[0]["text"].as_str())
        })
        .unwrap_or("")
        .trim();
    matches!(message["role"].as_str(), Some("system" | "user"))
        && text.starts_with("<system-reminder>")
        && text.ends_with("</system-reminder>")
}
fn eligible(part: &Value, role: &str) -> bool {
    match part["type"].as_str() {
        Some("text") => part["text"].as_str().is_some_and(|text| !text.is_empty()),
        Some("image" | "file") => role == "user",
        Some("tool-call" | "tool-result") => part["providerExecuted"] != true,
        _ => false,
    }
}
fn mark(root: &mut Value, path: &str, namespace: &str, key: &str, value: Value) {
    let Some(target) = root.pointer_mut(path) else {
        return;
    };
    if !target["providerOptions"].is_object() {
        target["providerOptions"] = json!({});
    }
    if !target["providerOptions"][namespace].is_object() {
        target["providerOptions"][namespace] = json!({});
    }
    target["providerOptions"][namespace][key] = value;
}

pub(super) fn prepare(input: &mut ProviderRequest) {
    if input.cache_policy.is_null() {
        return;
    }
    let policy = &input.cache_policy;
    let enabled = policy["enabled"] != false && policy["mode"] != "off";
    let mut root = json!({"prompt":input.prompt,"tools":input.tools});
    let mut targets = Vec::<Target>::new();
    for (index, tool) in input.tools.iter().enumerate() {
        targets.push(Target {
            path: format!("/tools/{index}"),
            index: None,
            existing: if tool["type"] == "provider" {
                None
            } else {
                control(tool)
            },
        });
    }
    let mut systems = Vec::new();
    let mut history = Vec::new();
    let mut reminders = Vec::new();
    let mut latest_user = None;
    for (index, message) in input.prompt.iter().enumerate() {
        let role = message["role"].as_str().unwrap_or("user");
        let is_reminder = reminder(message)
            || policy["runtimeReminderIndices"]
                .as_array()
                .is_some_and(|items| items.contains(&json!(index)));
        if is_reminder {
            reminders.push(index);
        }
        if role == "user" {
            latest_user = Some(index);
        }
        if role == "system" {
            let position = targets.len();
            targets.push(Target {
                path: format!("/prompt/{index}"),
                index: None,
                existing: control(message),
            });
            if !is_reminder {
                systems.push(position);
            }
        }
    }
    for (index, message) in input.prompt.iter().enumerate() {
        let role = message["role"].as_str().unwrap_or("user");
        if role == "system" {
            continue;
        }
        if let Some(parts) = message["content"].as_array() {
            for (part_index, part) in parts.iter().enumerate() {
                if !eligible(part, role) {
                    continue;
                }
                let existing = control(part)
                    .or_else(|| control(&part["output"]))
                    .or_else(|| {
                        part["output"]["value"]
                            .as_array()
                            .and_then(|items| items.iter().find_map(control))
                    })
                    .or_else(|| {
                        if part_index + 1 == parts.len() {
                            control(message)
                        } else {
                            None
                        }
                    });
                history.push(targets.len());
                targets.push(Target {
                    path: format!("/prompt/{index}/content/{part_index}"),
                    index: Some(index),
                    existing,
                });
            }
        } else if message["content"]
            .as_str()
            .is_some_and(|text| !text.is_empty())
        {
            history.push(targets.len());
            targets.push(Target {
                path: format!("/prompt/{index}"),
                index: Some(index),
                existing: control(message),
            });
        }
    }
    for message in root["prompt"].as_array_mut().unwrap() {
        clear(message);
    }
    for tool in root["tools"].as_array_mut().unwrap() {
        clear(tool);
    }
    let latest = reminders.last().copied().or(latest_user);
    let previous = reminders.iter().rev().nth(1).copied();
    let before = |boundary: Option<usize>| {
        boundary.and_then(|boundary| {
            history
                .iter()
                .rev()
                .find(|&&position| {
                    targets[position]
                        .index
                        .is_some_and(|index| index < boundary)
                })
                .copied()
        })
    };
    if enabled && input.api_format == "anthropic" && policy["adapter"] == "@ai-sdk/anthropic" {
        let old = before(previous);
        let old_matches = policy["previousAnchorMatches"] != false;
        let mut chosen = Vec::<(usize, Value)>::new();
        let mut add = |position: Option<usize>| {
            let Some(position) = position else {
                return;
            };
            if chosen.len() >= 4 || chosen.iter().any(|(other, _)| *other == position) {
                return;
            }
            let marker = targets[position]
                .existing
                .clone()
                .unwrap_or(json!({"type":"ephemeral"}));
            let long = marker["ttl"] == "1h";
            if chosen.iter().any(|(other, value)| {
                (long && *other < position && value["ttl"] != "1h")
                    || (!long && *other > position && value["ttl"] == "1h")
            }) {
                return;
            }
            chosen.push((position, marker));
        };
        add(systems.last().copied());
        if old_matches {
            add(old);
        }
        add(before(latest));
        // Preserve explicit message markers before lower-priority tool markers;
        // TTL validation still uses their separate physical wire positions.
        let mut explicit_order: Vec<usize> = (0..targets.len()).collect();
        explicit_order.sort_by_key(|&position| {
            let parts: Vec<_> = targets[position].path.split('/').collect();
            (
                parts[1] == "tools",
                parts[2].parse::<usize>().unwrap_or(0),
                parts
                    .get(4)
                    .and_then(|index| index.parse::<usize>().ok())
                    .unwrap_or(0),
            )
        });
        for position in explicit_order {
            let target = &targets[position];
            if target.existing.is_none() || (!old_matches && old == Some(position)) {
                continue;
            }
            if target
                .index
                .is_some_and(|index| latest.is_none_or(|latest| index >= latest))
            {
                continue;
            }
            if latest.is_some_and(|latest| {
                target.path == format!("/prompt/{latest}") && reminder(&input.prompt[latest])
            }) {
                continue;
            }
            add(Some(position));
        }
        for (position, value) in chosen {
            mark(
                &mut root,
                &targets[position].path,
                "anthropic",
                "cacheControl",
                value,
            );
        }
    }
    if enabled
        && input.api_format == "openai"
        && policy["adapter"] == "@ai-sdk/openai"
        && policy["chatBreakpoints"] != false
    {
        for position in [systems.last().copied(), before(latest)]
            .into_iter()
            .flatten()
        {
            mark(
                &mut root,
                &targets[position].path,
                "openai",
                "promptCacheBreakpoint",
                json!({"mode":"explicit"}),
            );
        }
    }
    input.prompt = serde_json::from_value(root["prompt"].take()).expect("prompt remains an array");
    input.tools = serde_json::from_value(root["tools"].take()).expect("tools remain an array");
    if !enabled {
        return;
    }
    let session = policy["sessionId"].as_str();
    let provider = input.provider_id.as_deref().unwrap_or_default();
    let project = policy["projectId"].as_str();
    let adapter = policy["adapter"].as_str().unwrap_or_default();
    if input.api_format == "openai-responses"
        && adapter != "@ai-sdk/open-responses"
        && input.response_options["promptCacheKey"].is_null()
    {
        if let Some(session) = session {
            let identity = [
                "synax-prompt-cache-v1",
                provider,
                &input.model,
                project.unwrap_or("global"),
                session,
            ]
            .join("\0");
            if !input.response_options.is_object() {
                input.response_options = json!({});
            }
            input.response_options["promptCacheKey"] = json!(format!(
                "synax:v1:{:.40}",
                format!("{:x}", Sha256::digest(identity))
            ));
        }
    } else if input.api_format == "openai"
        && matches!(adapter, "@ai-sdk/openai" | "@ai-sdk/openai-compatible")
    {
        let namespace = if adapter == "@ai-sdk/openai" {
            "openai"
        } else {
            provider.split('.').next().unwrap_or(provider)
        };
        let field = if adapter == "@ai-sdk/openai" {
            "promptCacheKey"
        } else {
            "prompt_cache_key"
        };
        let explicit = input.response_options["promptCacheKey"]
            .as_str()
            .or(input.provider_options[namespace][field].as_str());
        let key = explicit.map(str::to_owned).or_else(|| {
            session.map(|session| {
                let identity = json!([
                    "synax-chat-v1",
                    provider,
                    input.base_url,
                    input.model,
                    project,
                    session
                ]);
                format!(
                    "synax:chat:v1:{:.40}",
                    format!("{:x}", Sha256::digest(identity.to_string()))
                )
            })
        });
        if let Some(key) = key {
            if !input.provider_options.is_object() {
                input.provider_options = json!({});
            }
            if !input.provider_options[namespace].is_object() {
                input.provider_options[namespace] = json!({});
            }
            input.provider_options[namespace][field] = json!(key);
        }
    }
}
