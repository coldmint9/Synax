//! Provider-specific request controls are resolved once, inside the native runtime.
use super::contract::ProviderRequest;
use serde_json::{Value, json};

pub(crate) fn prepare(mut input: ProviderRequest) -> ProviderRequest {
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
    let options = &mut input.provider_options[namespace];
    if input.api_format == "openai-responses" {
        if let Some(controls) = input.response_options.as_object() {
            options.as_object_mut().unwrap().extend(controls.clone());
        }
        if reasoning {
            options["reasoningEffort"] = json!(if disabled {
                "none"
            } else {
                input.reasoning_effort.as_deref().unwrap_or(if deepseek {
                    "high"
                } else {
                    "medium"
                })
            });
            if options["reasoningEffort"] != "none" {
                input.temperature = None;
            }
        }
    } else if deepseek {
        let enabled = !disabled && input.reasoning_effort.as_deref() != Some("none");
        options["thinking"] = json!({"type":if enabled { "enabled" } else { "disabled" }});
        if enabled {
            options["reasoningEffort"] = json!(input.reasoning_effort.as_deref().unwrap_or("high"));
            input.temperature = None;
        }
    } else if input.api_format == "openai" && reasoning {
        options["reasoningEffort"] = json!(if disabled {
            "none"
        } else {
            input.reasoning_effort.as_deref().unwrap_or("medium")
        });
        if options["reasoningEffort"] != "none" {
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
}
