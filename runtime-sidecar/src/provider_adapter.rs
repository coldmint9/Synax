//! Rig is the only conversation provider transport. The host wire remains
//! provider-neutral; Rig's complete assistant message is retained for replay.
use crate::provider::ProviderRequest;
use futures_util::{StreamExt, stream::BoxStream};
use rig_core::{
    DynModel,
    completion::{CompletionRequest, FinishReason, ToolDefinition},
    message::{
        AssistantContent, AssistantMessage, Audio, Document, DocumentSourceKind, Image, Message,
        Opaque, Origin, Reasoning, ToolCall, ToolChoice, ToolFunction, ToolName, ToolResultContent,
        UserContent,
    },
    operation::Completion,
    providers::{anthropic::AnthropicConfig, openai::OpenAIConfig},
    streaming::{Item, StreamEvent},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

type Error = Box<dyn std::error::Error + Send + Sync>;

/// Only this error is eligible for model-side argument correction. Never
/// dispatch Rig's partial-object fallback or expose the argument payload.
#[derive(Debug, thiserror::Error)]
#[error("provider returned invalid JSON arguments for tool '{tool_name}' (call '{call_id}'): {detail}")]
pub(crate) struct InvalidToolArguments {
    tool_name: String,
    call_id: String,
    detail: String,
}

impl InvalidToolArguments {
    fn new(tool_name: &str, call_id: &str, arguments: &str, truncated: bool) -> Self {
        let mut detail = match serde_json::from_str::<Value>(arguments) {
            Err(error) => error.to_string(),
            Ok(Value::String(inner)) => match serde_json::from_str::<Value>(&inner) {
                Err(error) => format!("encoded arguments: {error}"),
                Ok(_) => "expected a JSON object".into(),
            },
            Ok(_) => "expected a JSON object".into(),
        };
        if truncated {
            detail.push_str("; the response reached the output token limit");
        }
        Self { tool_name: tool_name.into(), call_id: call_id.into(), detail }
    }
}

/// DeepSeek-compatible gateways occasionally emit literal newlines, tabs or
/// other control bytes inside a JSON string when a tool argument contains a
/// large source file. JSON requires those bytes to be escaped. Repair only
/// this unambiguous encoding defect; never close missing containers or accept
/// Rig's partial-object fallback, because that could execute truncated code.
fn repair_tool_arguments(text: &str) -> Option<serde_json::Map<String, Value>> {
    fn parse(value: &str) -> Option<serde_json::Map<String, Value>> {
        match serde_json::from_str::<Value>(value).ok()? {
            Value::Object(object) => Some(object),
            _ => None,
        }
    }

    let trimmed = text.trim();
    if let Some(object) = parse(trimmed) {
        return Some(object);
    }
    let fenced = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```JSON"))
        .and_then(|value| value.strip_suffix("```"))
        .map(str::trim);
    if let Some(object) = fenced.and_then(parse) {
        return Some(object);
    }

    let mut repaired = String::with_capacity(trimmed.len() + 32);
    let mut in_string = false;
    let mut escaped = false;
    for ch in trimmed.chars() {
        match ch {
            '"' if !escaped => {
                in_string = !in_string;
                repaired.push('"');
            }
            '\\' if in_string && !escaped => {
                escaped = true;
                repaired.push('\\');
            }
            '\n' if in_string => repaired.push_str("\\n"),
            '\r' if in_string => repaired.push_str("\\r"),
            '\t' if in_string => repaired.push_str("\\t"),
            ch if in_string && ch.is_control() => {
                repaired.push_str(&format!("\\u{:04x}", ch as u32));
            }
            ch => {
                repaired.push(ch);
                escaped = false;
            }
        }
        if escaped && ch != '\\' {
            escaped = false;
        }
    }
    parse(&repaired)
}

fn model(input: &ProviderRequest) -> Result<DynModel<Completion>, Error> {
    let extra = crate::provider_metadata::RequestMetadata::new(input)?;
    let key = input.api_key.clone().unwrap_or_default();
    if input.api_format == "anthropic" {
        let mut config = AnthropicConfig::new(key);
        if let Some(base) = &input.base_url {
            config = config.with_base_url(base);
        }
        let mut model = config.client().completion(&input.model);
        model.transport = model.transport.with_middleware(extra);
        Ok(model.erase())
    } else {
        let mut config = OpenAIConfig::new(key);
        if let Some(base) = &input.base_url {
            config = config.with_base_url(
                base.trim_end_matches('/')
                    .trim_end_matches("/responses")
                    .trim_end_matches("/chat/completions"),
            );
        }
        match input.api_format.as_str() {
            "openai" => {
                let mut model = config.client().chat(&input.model);
                model.transport = model.transport.with_middleware(extra);
                Ok(model.erase())
            }
            "openai-responses" => {
                let mut model = config.client().responses(&input.model);
                model.transport = model.transport.with_middleware(extra);
                Ok(model.erase())
            }
            other => Err(format!("unsupported provider protocol '{other}'").into()),
        }
    }
}

/// No spawned producer: dropping this stream drops the upstream HTTP body.
pub(crate) fn provider_events(input: ProviderRequest) -> BoxStream<'static, Result<Value, Error>> {
    Box::pin(async_stream::try_stream! {
        let (input, tool_names) = crate::provider_tool_names::ToolNames::prepare(input)?;
        let request = request(&input)?;
        let mut stream = model(&input)?.stream(request)?;
        yield json!({"type":"stream-start","warnings":[]});
        // Rig normalizes OpenAI Chat, OpenAI Responses and Anthropic streams
        // into the same events. Keep cumulative display telemetry here so the
        // native loop exposes the same live token counters for all protocols.
        let mut streamed_output = String::new();
        let mut streamed_reasoning = String::new();
        let mut reasoning_sent = HashMap::<usize, String>::new();
        while let Some(item) = stream.next().await {
            match item? {
                Item::Event(StreamEvent::Text { part, text }) => {
                    streamed_output.push_str(&text);
                    yield json!({"type":"text-delta","id":format!("rust-text-{}",part.index()),"delta":text,
                        "outputTokens":crate::loop_context::tokens(&streamed_output)});
                }
                Item::Event(StreamEvent::Reasoning { part, text }) => {
                    reasoning_sent.entry(part.index()).or_default().push_str(&text);
                    streamed_reasoning.push_str(&text);
                    yield json!({"type":"reasoning-delta","id":format!("rust-reasoning-{}",part.index()),"delta":text,
                        "thinkingTokens":crate::loop_context::tokens(&streamed_reasoning)});
                }
                Item::Event(StreamEvent::End { part, content: AssistantContent::Reasoning(reasoning) }) => {
                    // A compatible server may send reasoning only in item.done.
                    let sent = reasoning_sent.entry(part.index()).or_default();
                    if let Some(suffix) = reasoning.text.strip_prefix(sent.as_str()) {
                        if !suffix.is_empty() {
                            streamed_reasoning.push_str(suffix);
                            yield json!({"type":"reasoning-delta","id":format!("rust-reasoning-{}",part.index()),"delta":suffix,
                                "thinkingTokens":crate::loop_context::tokens(&streamed_reasoning)});
                        }
                    }
                    if let Some(native) = reasoning.native {
                        if let Some(signature) = native.item.get("signature") {
                            yield json!({"type":"reasoning-signature","id":format!("rust-reasoning-{}",part.index()),"delta":signature});
                        }
                        if input.api_format == "openai-responses" {
                            yield json!({"type":"raw","rawValue":{"type":"provider.opaque_reasoning","provider":"openai-responses","data":native.item}});
                        }
                    }
                }
                Item::Unknown(raw) => yield json!({"type":"raw","rawValue":raw.value()}),
                _ => {}
            }
        }
        let response = stream.finish().await?;
        if let Some(error) = &response.error { Err(error.clone())?; }
        let mut ids = HashSet::new();
        let mut calls = Vec::new();
        for call in response.tool_calls() {
            let id = call.id.to_string();
            if !ids.insert(id.clone()) { Err(format!("provider returned duplicate tool call ID '{id}'"))?; }
            let name = call.function.name.as_str();
            let runtime_name = tool_names.runtime_name(name);
            let arguments = if let Some(raw) = &call.function.invalid_arguments {
                match repair_tool_arguments(raw) {
                    Some(repaired) => Value::Object(repaired),
                    None => Err(InvalidToolArguments::new(runtime_name, &id, raw,
                        matches!(response.finish_reason(), Some(FinishReason::Length))))?,
                }
            } else {
                Value::Object(call.function.arguments.clone())
            };
            calls.push(json!({"type":"tool-call","toolCallId":id,"toolName":runtime_name,"input":arguments}));
        }
        let usage = &response.usage;
        yield json!({"type":"raw","rawValue":response.raw});
        yield json!({"type":"usage","usage":{"inputTokens":usage.input_tokens,"outputTokens":usage.output_tokens,
            "cachedInputTokens":usage.cached_input_tokens,"cacheWriteTokens":usage.cache_creation_input_tokens,"reasoningTokens":usage.reasoning_tokens,
            "raw":response.raw.get("usage")}});
        let message = response.message().unwrap_or_else(|| Message::Assistant(AssistantMessage::new(vec![])));
        // Legacy display blocks keep the public event stable. rigMessage carries
        // all original items, signatures, origin and ordering without loss.
        let content: Vec<Value> = response.choice.iter().map(display_block).collect();
        yield json!({"type":"assistant-message","message":{"role":"assistant","content":content,"rigMessage":message}});
        for call in calls { yield call; }
        let (reason, raw) = match response.finish_reason() {
            Some(FinishReason::Stop) => ("stop", "stop".to_owned()),
            Some(FinishReason::ToolCalls) => ("tool-calls", "tool_use".to_owned()),
            Some(FinishReason::Length) => ("length", "max_tokens".to_owned()),
            Some(FinishReason::ContentFilter) => ("content-filter", "content_filter".to_owned()),
            Some(FinishReason::Other(raw)) => ("other", raw),
            Some(_) => ("other", "unknown".to_owned()),
            None => Err("provider stream ended without a completion marker")?,
        };
        yield json!({"type":"finish","finishReason":reason,"rawFinishReason":raw});
    })
}

fn display_block(block: &AssistantContent) -> Value {
    match block {
        AssistantContent::Text(text) => json!({"type":"text","text":text.text}),
        AssistantContent::ToolCall(call) => {
            json!({"type":"tool_use","id":call.id.to_string(),"name":call.function.name.as_str(),"input":call.function.arguments})
        }
        AssistantContent::Reasoning(reasoning) => {
            json!({"type":"thinking","thinking":reasoning.text})
        }
        AssistantContent::Opaque(opaque) => json!({"type":"opaque_reasoning","data":opaque.item}),
        _ => serde_json::to_value(block).unwrap_or(Value::Null),
    }
}

fn request(input: &ProviderRequest) -> Result<CompletionRequest, Error> {
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
    for key in [Some(namespace), input.provider_id.as_deref()]
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

fn convert_message(
    value: &Value,
    input: &ProviderRequest,
    calls: &HashMap<String, ToolCall>,
) -> Result<Message, Error> {
    if let Some(rig) = value.get("rigMessage") {
        return Ok(serde_json::from_value(rig.clone())?);
    }
    let role = value["role"].as_str().unwrap_or("user");
    let content = value.get("content").unwrap_or(&Value::Null);
    if role == "system" {
        return Ok(Message::system(content_text(content)));
    }
    let parts = match content {
        Value::Array(parts) => parts.clone(),
        _ => vec![json!({"type":"text","text":content_text(content)})],
    };
    if role == "assistant" {
        let mut blocks = Vec::new();
        let mut origin = None;
        for part in parts {
            match part["type"].as_str().unwrap_or("text") {
                "text" => blocks.push(AssistantContent::text(
                    part["text"].as_str().unwrap_or_default(),
                )),
                "tool-call" | "tool_use" => {
                    let id = part
                        .get("toolCallId")
                        .or_else(|| part.get("id"))
                        .and_then(Value::as_str)
                        .ok_or("tool call has no ID")?;
                    let name = part
                        .get("toolName")
                        .or_else(|| part.get("name"))
                        .and_then(Value::as_str)
                        .ok_or("tool call has no name")?;
                    blocks.push(AssistantContent::ToolCall(ToolCall::from_wire(
                        id,
                        ToolFunction::new(
                            ToolName::new(name)?,
                            part.get("input").cloned().unwrap_or_else(|| json!({})),
                        ),
                    )));
                }
                "thinking" | "reasoning" => {
                    let text = part
                        .get("thinking")
                        .or_else(|| part.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let mut block = AssistantContent::Reasoning(Reasoning::new(text));
                    let signature = part
                        .get("signature")
                        .or_else(|| part.pointer("/providerOptions/anthropic/signature"));
                    if let Some(signature) = signature {
                        block = block.with_native(
                            json!({"type":"thinking","thinking":text,"signature":signature}),
                        );
                        origin = Some(Origin::new("anthropic.messages", "anthropic", &input.model));
                    }
                    if let Some(redacted) = part
                        .pointer("/providerOptions/anthropic/redactedData")
                        .filter(|_| input.api_format == "anthropic")
                    {
                        let mut hidden = Reasoning::new("");
                        hidden.redacted = true;
                        block = AssistantContent::Reasoning(hidden)
                            .with_native(json!({"type":"redacted_thinking","data":redacted}));
                        origin = Some(Origin::new("anthropic.messages", "anthropic", &input.model));
                    }
                    if let Some(options) = part
                        .pointer("/providerOptions/openai")
                        .filter(|_| input.api_format == "openai-responses")
                    {
                        if options.get("reasoningContent").is_some()
                            || options.get("reasoningEncryptedContent").is_some()
                        {
                            let mut item = json!({"type":"reasoning","summary":if text.is_empty() || options.get("reasoningContent").is_some() { json!([]) } else {json!([{"type":"summary_text","text":text}])}});
                            if let Some(content) = options.get("reasoningContent") {
                                item["content"] = content.clone();
                            }
                            if let Some(id) = options.get("itemId") {
                                item["id"] = id.clone();
                            }
                            if let Some(encrypted) = options.get("reasoningEncryptedContent") {
                                item["encrypted_content"] = encrypted.clone();
                            }
                            block = block.with_native(item);
                            origin = Some(Origin::new("openai.responses", "openai", &input.model));
                        }
                    }
                    blocks.push(block);
                }
                "opaque_reasoning" => {
                    blocks.push(AssistantContent::Opaque(Opaque {
                        item: part["data"].clone(),
                        replay: true,
                    }));
                    origin = Some(Origin::new("openai.responses", "openai", &input.model));
                }
                "redacted_thinking" => {
                    let mut reasoning = Reasoning::new("");
                    reasoning.redacted = true;
                    blocks.push(AssistantContent::Reasoning(reasoning).with_native(part));
                    origin = Some(Origin::new("anthropic.messages", "anthropic", &input.model));
                }
                kind => return Err(format!("unsupported assistant content '{kind}'").into()),
            }
        }
        if origin
            .as_ref()
            .is_some_and(|origin| origin.api.as_str() == "openai.responses")
        {
            // Responses reasoning belongs to the following output item. Older
            // Synax transcripts kept its native body but only canonical text /
            // calls after it. Reconstruct those items before Rig pairs them.
            let identity = format!("{:x}", Sha256::digest(serde_json::to_vec(value)?));
            for (index, block) in blocks.iter_mut().enumerate() {
                let item = match block {
                    AssistantContent::Text(text) => Some(
                        json!({"type":"message","id":format!("msg_{}_{}",&identity[..16],index),
                        "role":"assistant","status":"completed","content":[{"type":"output_text","text":text.text,"annotations":[]}]}),
                    ),
                    AssistantContent::ToolCall(call) => Some(
                        json!({"type":"function_call","id":format!("fc_{}_{}",&identity[..16],index),
                        "call_id":call.id.to_string(),"name":call.function.name.as_str(),"arguments":serde_json::to_string(&call.function.arguments)?,"status":"completed"}),
                    ),
                    _ => None,
                };
                if let Some(item) = item {
                    *block = block.clone().with_native(item);
                }
            }
        }
        return Ok(Message::Assistant(
            AssistantMessage::new(blocks).with_origin(origin),
        ));
    }
    let mut blocks = Vec::new();
    for part in parts {
        match part["type"].as_str().unwrap_or("text") {
            "text" => blocks.push(UserContent::text(part["text"].as_str().unwrap_or_default())),
            "tool-result" | "tool_result" => {
                let id = part
                    .get("toolCallId")
                    .or_else(|| part.get("tool_use_id"))
                    .and_then(Value::as_str)
                    .ok_or("tool result has no ID")?;
                let call = calls
                    .get(id)
                    .ok_or_else(|| format!("tool result '{id}' has no preceding call"))?;
                let output = part
                    .get("output")
                    .or_else(|| part.get("content"))
                    .unwrap_or(&Value::Null);
                let data = match output.get("type").and_then(Value::as_str) {
                    Some("text" | "error-text" | "json" | "error-json") => {
                        output.get("value").unwrap_or(output)
                    }
                    _ => output,
                };
                let result_content = if output["type"] == "content" {
                    output["value"]
                        .as_array()
                        .ok_or("tool content must be an array")?
                        .iter()
                        .map(|part| {
                            if part["type"] == "text" {
                                Ok(ToolResultContent::Text(
                                    part["text"].as_str().unwrap_or_default().to_owned().into(),
                                ))
                            } else {
                                match attachment(part)? {
                                    UserContent::Image(image) => {
                                        Ok(ToolResultContent::Image(image))
                                    }
                                    _ => Err("tool outputs support text, JSON and images".into()),
                                }
                            }
                        })
                        .collect::<Result<Vec<_>, Error>>()?
                } else if let Value::String(text) = data {
                    vec![ToolResultContent::Text(text.clone().into())]
                } else {
                    vec![ToolResultContent::Json {
                        value: data.clone(),
                    }]
                };
                let mut result = call.result(result_content);
                result.is_error = part
                    .get("isError")
                    .or_else(|| part.get("is_error"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || output["type"]
                        .as_str()
                        .is_some_and(|kind| kind.starts_with("error-"));
                blocks.push(UserContent::ToolResult(result));
            }
            "image" | "file" | "document" => blocks.push(attachment(&part)?),
            kind => return Err(format!("unsupported user content '{kind}'").into()),
        }
    }
    Ok(Message::User { content: blocks })
}

fn attachment(part: &Value) -> Result<UserContent, Error> {
    let source = part.get("source");
    let media = part
        .get("mediaType")
        .or_else(|| part.get("mimeType"))
        .or_else(|| source.and_then(|s| s.get("media_type")))
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");
    let data = part
        .get("data")
        .or_else(|| part.get("image"))
        .or_else(|| source.and_then(|s| s.get("data").or_else(|| s.get("url"))))
        .ok_or("attachment has no data")?;
    let data = match data.get("type").and_then(Value::as_str) {
        Some("data") => data.get("data").ok_or("attachment has no bytes")?,
        Some("url") => data.get("url").ok_or("attachment has no URL")?,
        _ => data,
    };
    let data = if let Some(text) = data.as_str() {
        if text.starts_with("https://") || text.starts_with("http://") {
            DocumentSourceKind::Url(text.into())
        } else if let Some((_, base64)) = text.split_once(";base64,") {
            DocumentSourceKind::Base64(base64.into())
        } else {
            DocumentSourceKind::Base64(text.into())
        }
    } else if let Some(items) = data.as_array() {
        DocumentSourceKind::Raw(
            items
                .iter()
                .map(|v| {
                    v.as_u64()
                        .filter(|n| *n <= 255)
                        .map(|n| n as u8)
                        .ok_or("invalid attachment byte")
                })
                .collect::<Result<Vec<_>, _>>()?,
        )
    } else {
        return Err("attachment must contain base64 data, a URL or bytes".into());
    };
    if media.starts_with("image/") || part["type"] == "image" {
        let media_type = match media {
            "image/jpeg" => Some(rig_core::message::ImageMediaType::JPEG),
            "image/png" => Some(rig_core::message::ImageMediaType::PNG),
            "image/webp" => Some(rig_core::message::ImageMediaType::WEBP),
            "image/gif" => Some(rig_core::message::ImageMediaType::GIF),
            _ => None,
        };
        let detail = match part
            .pointer("/providerOptions/openai/imageDetail")
            .and_then(Value::as_str)
        {
            Some("high") => Some(rig_core::message::ImageDetail::High),
            Some("low") => Some(rig_core::message::ImageDetail::Low),
            Some("auto") => Some(rig_core::message::ImageDetail::Auto),
            _ => None,
        };
        Ok(UserContent::Image(Image {
            data,
            media_type,
            detail,
            native: None,
        }))
    } else if media.starts_with("audio/") {
        let media_type = match media {
            "audio/wav" => Some(rig_core::message::AudioMediaType::WAV),
            "audio/mpeg" => Some(rig_core::message::AudioMediaType::MP3),
            _ => None,
        };
        Ok(UserContent::Audio(Audio { data, media_type }))
    } else if media == "application/pdf" {
        Ok(UserContent::Document(Document {
            data,
            media_type: Some(rig_core::message::DocumentMediaType::PDF),
            additional_params: None,
        }))
    } else {
        Err(format!("unsupported attachment media type '{media}'").into())
    }
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, Error> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("missing nonempty '{key}'").into())
}
fn content_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p["type"] == "text")
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::repair_tool_arguments;

    #[test]
    fn repairs_literal_control_bytes_inside_large_code_strings() {
        let repaired = repair_tool_arguments(
            "{\"path\":\"game.html\",\"content\":\"const title = \\\"鹈鹕\\\";\nconsole.log(title);\"}",
        )
        .expect("literal newline should be escaped");
        assert_eq!(repaired["path"], "game.html");
        assert_eq!(repaired["content"], "const title = \"鹈鹕\";\nconsole.log(title);");
    }

    #[test]
    fn never_repairs_a_truncated_object() {
        assert!(repair_tool_arguments("{\"path\":\"game.html\",\"content\":\"const x = 1").is_none());
    }

    #[test]
    fn strips_json_code_fences_without_changing_unicode() {
        let repaired = repair_tool_arguments("```json\n{\"text\":\"中文\"}\n```").unwrap();
        assert_eq!(repaired["text"], "中文");
    }
}
