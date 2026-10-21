//! Canonical request construction and native protocol options.
use super::{Error, common::required_str, contract::ProviderRequest, messages::convert_message};
use rig_core::{
    completion::{CompletionRequest, ToolDefinition},
    message::{Message, ToolChoice, ToolName},
};
use serde_json::{Value, json};
use std::collections::HashMap;

pub(super) fn request(input: &ProviderRequest) -> Result<CompletionRequest, Error> {
    let mut calls = HashMap::new();
    let mut messages = Vec::new();
    for value in &input.prompt {
        let message = convert_message(value, input, &calls)?;
        if let Message::Assistant(assistant) = &message {
            for call in assistant.tool_calls() {
                calls.insert(call.id.to_string(), call.clone());
            }
        }
        messages.push(message);
    }
    let max_tokens = input
        .max_output_tokens
        .map(u64::from)
        .or_else(|| (input.api_format == "anthropic").then_some(8192));
    let mut request = CompletionRequest::from(messages)
        .temperature(input.temperature)
        .max_tokens(max_tokens);
    if let Some(top_p) = input.top_p {
        request = request.top_p(top_p);
    }
    if let Some(seed) = input.seed {
        request = request.seed(seed);
    }
    if !input.stop_sequences.is_empty() {
        request = request.stop(input.stop_sequences.clone());
    }
    if let Some(choice) = &input.tool_choice {
        request = request.tool_choice(match choice["type"].as_str() {
            Some("auto") => ToolChoice::Auto,
            Some("none") => ToolChoice::None,
            Some("required") => ToolChoice::Required,
            Some("tool") => ToolChoice::Specific {
                function_names: vec![ToolName::new(required_str(choice, "toolName")?)?],
            },
            _ => return Err("unsupported tool choice".into()),
        });
    }
    let mut extra = provider_options(input)?;
    let mut hosted = Vec::new();
    for tool in &input.tools {
        if tool["type"] == "provider" {
            hosted.push(native_tool(tool, &input.api_format)?);
            continue;
        }
        request.tools.push(ToolDefinition::new(
            ToolName::new(required_str(tool, "name")?)?,
            tool["description"].as_str().unwrap_or_default(),
            tool.get("inputSchema")
                .or_else(|| tool.get("parameters"))
                .cloned()
                .unwrap_or_else(|| json!({"type":"object","properties":{}})),
        ));
    }
    if !hosted.is_empty() {
        extra["tools"] = json!(hosted);
    }
    if input.tools.is_empty() && !calls.is_empty() {
        // Rig preserves tool exchanges only when a request declares tools. A
        // history-only declaration with choice=none preserves those receipts
        // without making retired operations callable by the next response.
        let names: std::collections::BTreeSet<_> = calls
            .values()
            .map(|call| call.function.name.as_str().to_owned())
            .collect();
        for name in names {
            request.tools.push(ToolDefinition::new(
                ToolName::new(name)?,
                "Historical operation; unavailable in this turn",
                json!({"type":"object","properties":{}}),
            ));
        }
        request.tool_choice = Some(ToolChoice::None);
    }
    if let Some(format) = &input.response_format {
        if format["type"] == "json" {
            let mut schema = format.get("schema").cloned();
            if let Some(Value::Object(object)) = &mut schema {
                if let Some(name) = format.get("name") {
                    object.insert("title".into(), name.clone());
                }
            }
            if let Some(schema) = schema {
                request = request.output_schema(Some(serde_json::from_value::<
                    rig_core::schemars::Schema,
                >(schema)?));
            } else if input.api_format == "openai" {
                extra["response_format"] = json!({"type":"json_object"});
            } else if input.api_format == "openai-responses" {
                extra["text"]["format"] = json!({"type":"json_object"});
            } else {
                return Err("Messages JSON output requires a schema".into());
            }
        }
    }
    Ok(request.additional_params(extra))
}

fn provider_options(input: &ProviderRequest) -> Result<Value, Error> {
    let mut extra = json!({});
    // A native adapter's fixed namespace and the configured provider namespace
    // are merged, with the connection-specific options taking precedence.
    let namespace = if input.api_format == "anthropic" {
        "anthropic"
    } else {
        "openai"
    };
    let mut options = serde_json::Map::new();
    let adapter_namespace = input.adapter.as_deref().and_then(|adapter| {
        if adapter == "@openrouter/ai-sdk-provider" {
            Some("openrouter")
        } else {
            adapter
                .strip_prefix("@ai-sdk/")
                .filter(|name| !matches!(*name, "openai-compatible" | "open-responses"))
        }
    });
    let compatible_namespace = input
        .provider_id
        .as_deref()
        .and_then(|id| id.split('.').next());
    for key in [
        adapter_namespace,
        Some(namespace),
        compatible_namespace,
        input.provider_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(map) = input.provider_options.get(key).and_then(Value::as_object) {
            options.extend(map.clone());
        }
    }
    for (key, value) in options {
        match key.as_str() {
            "reasoningEffort" if input.api_format == "openai" => extra["reasoning_effort"] = value,
            "reasoningEffort" if input.api_format == "openai-responses" => {
                extra["reasoning"]["effort"] = value
            }
            "reasoningSummary" => extra["reasoning"]["summary"] = value,
            "textVerbosity" => extra["text"]["verbosity"] = value,
            "parallelToolCalls" => extra["parallel_tool_calls"] = value,
            "promptCacheKey" => extra["prompt_cache_key"] = value,
            "promptCacheRetention" => extra["prompt_cache_retention"] = value,
            "serviceTier" => extra["service_tier"] = value,
            "previousResponseId" => extra["previous_response_id"] = value,
            "maxToolCalls" => extra["max_tool_calls"] = value,
            "safetyIdentifier" => extra["safety_identifier"] = value,
            "thinking" => {
                let mut thinking = value;
                if let Some(map) = thinking.as_object_mut() {
                    if let Some(budget) = map.remove("budgetTokens") {
                        map.insert("budget_tokens".into(), budget);
                    }
                }
                extra["thinking"] = thinking;
            }
            "effort" if input.api_format == "anthropic" => extra["output_config"]["effort"] = value,
            "extraBody" => {
                let map = value.as_object().ok_or("extraBody must be an object")?;
                for (key, value) in map {
                    if ["model", "messages", "input", "stream", "tools"].contains(&key.as_str()) {
                        return Err(
                            format!("extraBody cannot override runtime field '{key}'").into()
                        );
                    }
                    extra[key] = value.clone();
                }
            }
            "store" | "include" | "metadata" | "user" | "truncation" | "reasoning"
            | "frequency_penalty" | "presence_penalty" | "top_k" | "thinking_budget" => {
                extra[key] = value
            }
            // SDK-only cache hints are handled by request content policy.
            "cacheControl"
            | "passThroughUnsupportedFiles"
            | "forceReasoning"
            | "strictJsonSchema" => {}
            _ => {
                extra[key] = value;
            }
        }
    }
    if let Some(value) = input.top_k {
        extra["top_k"] = json!(value);
    }
    if let Some(value) = input.presence_penalty {
        extra["presence_penalty"] = json!(value);
    }
    if let Some(value) = input.frequency_penalty {
        extra["frequency_penalty"] = json!(value);
    }
    Ok(extra)
}

fn native_tool(tool: &Value, protocol: &str) -> Result<Value, Error> {
    let id = required_str(tool, "id")?;
    let (namespace, name) = id
        .split_once('.')
        .ok_or("provider tool ID needs a namespace")?;
    if (protocol == "anthropic") != (namespace == "anthropic") {
        return Err(format!("provider tool '{id}' does not match protocol '{protocol}'").into());
    }
    let mut wire = tool.get("args").cloned().unwrap_or_else(|| json!({}));
    if !wire.is_object() {
        return Err("provider tool args must be an object".into());
    }
    wire["type"] = json!(name);
    if protocol == "anthropic" {
        wire["name"] = json!(if name.starts_with("web_search") {
            "web_search"
        } else if name.starts_with("web_fetch") {
            "web_fetch"
        } else {
            name
        });
    }
    Ok(wire)
}
