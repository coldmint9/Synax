//! Provider-specific request controls are resolved once, inside the native runtime.
use super::contract::ProviderRequest;
use serde_json::{Value, json};

pub(crate) fn prepare(mut input: ProviderRequest) -> ProviderRequest {
    input.prompt = super::expanded_messages(&input.prompt).into_iter().cloned().collect();
    super::cache::prepare(&mut input);
    // Volatile runtime reminders belong to the input tail, outside the stable
    // system instructions. Keep original text and per-block metadata intact.
    for message in &mut input.prompt {
        if message["role"] == "system" {
            let text = message["content"].as_str().unwrap_or("").trim();
            if text.starts_with("<system-reminder>") && text.ends_with("</system-reminder>") {
                message["role"] = json!("user");
            }
        }
    }
    let disabled = matches!(
        input.purpose.as_deref(),
        Some("session-title" | "input-optimization" | "context-signal" | "validate")
    );
    let deepseek = input
        .provider_id
        .as_deref()
        .is_some_and(|id| id.to_lowercase().contains("deepseek"))
        || input
            .base_url
            .as_deref()
            .is_some_and(|url| url.contains("deepseek.com"));
    let reasoning = input.response_options["forceReasoning"]
        .as_bool()
        .unwrap_or(input.reasoning_capable);
    if !input.provider_options.is_object() {
        input.provider_options = json!({});
    }
    let namespace = if input.api_format == "anthropic" {
        "anthropic"
    } else {
        "openai"
    };
    if !input.provider_options[namespace].is_object() {
        input.provider_options[namespace] = json!({});
    }
    // A cheap utility request is not evidence that the model supports disabling reasoning.
    // Prefer low over none when both are supported: gateways may map a legacy alias to a reasoning-only model.
    let utility_effort = if disabled {
        ["low", "none", "medium", "high", "xhigh", "max"]
            .into_iter()
            .find(|effort| {
                input
                    .supported_reasoning_efforts
                    .iter()
                    .any(|value| value == effort)
            })
            .or(if deepseek { Some("none") } else { None })
            .map(str::to_owned)
    } else {
        None
    };
    let options = &mut input.provider_options[namespace];
    if input.api_format == "openai-responses" {
        if let Some(controls) = input.response_options.as_object() {
            options.as_object_mut().unwrap().extend(controls.clone());
        }
    }
    if input.api_format == "openai" && deepseek {
        let enabled = !disabled && input.reasoning_effort.as_deref() != Some("none");
        options["thinking"] = json!({"type":if enabled { "enabled" } else { "disabled" }});
        if enabled {
            options["reasoningEffort"] = json!(input.reasoning_effort.as_deref().unwrap_or("high"));
            input.temperature = None;
        } else {
            options.as_object_mut().unwrap().remove("reasoningEffort");
        }
    } else if reasoning && matches!(input.api_format.as_str(), "openai" | "openai-responses") {
        let effort = if disabled {
            utility_effort.as_deref()
        } else {
            Some(input.reasoning_effort.as_deref().unwrap_or(if deepseek {
                "high"
            } else {
                "medium"
            }))
        };
        if let Some(effort) = effort {
            options["reasoningEffort"] = json!(effort);
        } else {
            // Let an unknown model use its own default, including custom gateway aliases.
            options.as_object_mut().unwrap().remove("reasoningEffort");
        }
        if effort != Some("none") {
            input.top_p = None;
            input.temperature = None;
        }
    }
    if input.api_format != "anthropic" {
        for tool in &mut input.tools {
            if let Some(schema) = tool.get_mut("inputSchema") {
                strip_property_names(schema);
            }
        }
        if let Some(format) = &mut input.response_format {
            if let Some(schema) = format.get_mut("schema") {
                strip_property_names(schema);
            }
        }
    }
    input
}

fn strip_property_names(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("propertyNames");
            for value in object.values_mut() {
                strip_property_names(value);
            }
        }
        Value::Array(items) => {
            for item in items {
                strip_property_names(item);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_reasoning_and_schema_compatibility_without_host_sdk() {
        let input: ProviderRequest = serde_json::from_value(
            json!({"apiFormat":"openai-responses","model":"custom", "reasoningCapable":true,
            "reasoningEffort":"high","temperature":0.4,"responseOptions":{"store":false},
            "tools":[{"inputSchema":{"type":"object","propertyNames":{"type":"string"}}}]}),
        )
        .unwrap();
        let result = prepare(input);
        assert_eq!(result.temperature, None);
        assert_eq!(result.provider_options["openai"]["reasoningEffort"], "high");
        assert_eq!(result.provider_options["openai"]["store"], false);
        assert!(
            result.tools[0]["inputSchema"]
                .get("propertyNames")
                .is_none()
        );
    }
    #[test]
    fn utility_calls_disable_deepseek_thinking() {
        let input: ProviderRequest = serde_json::from_value(json!({"apiFormat":"openai","model":"fixture", "providerId":"deepseek", "purpose":"session-title"})).unwrap();
        assert_eq!(
            prepare(input).provider_options["openai"]["thinking"]["type"],
            "disabled"
        );
    }
    #[test]
    fn title_effort_uses_model_capabilities_and_unknown_aliases_use_defaults() {
        for protocol in ["openai", "openai-responses"] {
            let input:ProviderRequest=serde_json::from_value(json!({"apiFormat":protocol,"model":"gpt-6-sol",
                "purpose":"session-title","reasoningCapable":true,"reasoningEffort":"none","temperature":0.3,
                "supportedReasoningEfforts":["low","medium","high","xhigh","max"]})).unwrap();
            let result = prepare(input);
            assert_eq!(result.provider_options["openai"]["reasoningEffort"], "low");
            assert_eq!(result.temperature, None);
            let input:ProviderRequest=serde_json::from_value(json!({"apiFormat":protocol,"model":"gateway-alias",
                "purpose":"session-title","reasoningCapable":true,"reasoningEffort":"none","temperature":0.3})).unwrap();
            let result = prepare(input);
            assert!(
                result.provider_options["openai"]
                    .get("reasoningEffort")
                    .is_none()
            );
            assert_eq!(result.temperature, None);
        }
        let input:ProviderRequest=serde_json::from_value(json!({"apiFormat":"openai-responses","model":"allows-none",
            "purpose":"input-optimization","reasoningCapable":true,"supportedReasoningEfforts":["none"]})).unwrap();
        assert_eq!(
            prepare(input).provider_options["openai"]["reasoningEffort"],
            "none"
        );
    }
}
