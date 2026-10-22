//! Conversation streaming and canonical assistant output.
use super::{
    Error,
    client::model,
    contract::ProviderRequest,
    errors::{InvalidToolArguments, repair_tool_arguments},
    request::request,
};
use futures_util::{StreamExt, stream::BoxStream};
use rig_core::{
    completion::FinishReason,
    message::{AssistantContent, AssistantMessage, Message},
    streaming::{Item, StreamEvent},
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

/// No spawned producer: dropping this stream drops the upstream HTTP body.
pub(crate) fn provider_events(input: ProviderRequest) -> BoxStream<'static, Result<Value, Error>> {
    let span = tracing::error_span!("provider", provider_request_id = %uuid::Uuid::new_v4(),
        provider_id = input.provider_id.as_deref().unwrap_or("unknown"), model = %input.model,
        api_format = %input.api_format, operation = "completion");
    let input = super::policy::prepare(input);
    let max_retries = input
        .max_retries
        .unwrap_or(crate::llm::retry::MAX_RETRIES)
        .min(crate::llm::retry::MAX_RETRIES);
    crate::logging::observe_stream(
        crate::llm::retry::with_retry(
            move || super::scheduling::schedule(input.clone(), provider_events_once),
            max_retries,
        ),
        span,
    )
}

fn provider_events_once(input: ProviderRequest) -> BoxStream<'static, Result<Value, Error>> {
    Box::pin(async_stream::try_stream! {
        let (input, tool_names) = crate::llm::tool_names::ToolNames::prepare(input)?;
        let request = request(&input)?;
        let mut stream = model(&input)?.stream(request)?;
        yield json!({"type":"stream-start","warnings":[]});
        // Rig normalizes OpenAI Chat, OpenAI Responses and Anthropic streams
        // into the same events. Keep cumulative display telemetry here so the
        // native loop exposes the same live token counters for all protocols.
        let mut streamed_output = String::new();
        let mut streamed_reasoning = String::new();
        let mut reasoning_sent = HashMap::<usize, String>::new();
        let idle_timeout = super::deadline::configured_timeout();
        while let Some(item) = super::deadline::next(stream.next(), idle_timeout).await? {
            match item? {
                Item::Event(StreamEvent::Text { part, text }) => {
                    streamed_output.push_str(&text);
                    yield json!({"type":"text-delta","id":format!("rust-text-{}",part.index()),"delta":text,
                        "outputTokens":super::tokenizer::tokens(&streamed_output)});
                }
                Item::Event(StreamEvent::Reasoning { part, text }) => {
                    reasoning_sent.entry(part.index()).or_default().push_str(&text);
                    streamed_reasoning.push_str(&text);
                    yield json!({"type":"reasoning-delta","id":format!("rust-reasoning-{}",part.index()),"delta":text,
                        "thinkingTokens":super::tokenizer::tokens(&streamed_reasoning)});
                }
                Item::Event(StreamEvent::End { part, content: AssistantContent::Reasoning(reasoning) }) => {
                    // A compatible server may send reasoning only in item.done.
                    let sent = reasoning_sent.entry(part.index()).or_default();
                    if let Some(suffix) = reasoning.text.strip_prefix(sent.as_str()) {
                        if !suffix.is_empty() {
                            streamed_reasoning.push_str(suffix);
                            yield json!({"type":"reasoning-delta","id":format!("rust-reasoning-{}",part.index()),"delta":suffix,
                                "thinkingTokens":super::tokenizer::tokens(&streamed_reasoning)});
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
        let mut response = stream.finish().await?;
        // The Responses API ends a turn it cut short as `incomplete`, and Rig
        // keeps the provider's own reason as the failure text
        // (`Response incomplete: <reason>`). A limit the provider reached is a
        // truncated answer, not a failed request: keep the content the user
        // already read and end the step as a length stop. A turn that produced
        // nothing at all stays an error, so the loop never retries it forever.
        let truncated =
            truncation_reason(response.error.as_deref(), !response.choice.is_empty())
                .map(str::to_owned);
        if let Some(reason) = &truncated {
            tracing::warn!(event = "provider.incomplete", reason = %reason,
                "Provider ended the response early; keeping the truncated answer");
            response.error = None;
            response = response.with_finish_reason(FinishReason::Length);
        } else if let Some(error) = &response.error {
            Err(error.clone())?;
        }
        if input.response_format.as_ref().is_some_and(|format| format["type"] == "json") {
            let text: String = response.choice.iter().filter_map(|part| match part {
                AssistantContent::Text(text) => Some(text.text.as_str()),
                _ => None,
            }).collect();
            let value: Value = serde_json::from_str(&text)?;
            yield json!({"type":"structured-output","value":value});
        }
        let limit_reached = truncated.is_some();
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
                        limit_reached || matches!(response.finish_reason(), Some(FinishReason::Length))))?,
                }
            } else {
                Value::Object(call.function.arguments.clone())
            };
            calls.push(json!({"type":"tool-call","toolCallId":id,"toolName":runtime_name,"input":arguments}));
        }
        let usage = &response.usage;
        yield json!({"type":"raw","rawValue":response.raw});
        yield json!({"type":"usage","usage":{"source":"native","protocol":input.api_format,"adapter":input.adapter,
            "inputTokens":usage.input_tokens,"outputTokens":usage.output_tokens,
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
            Some(FinishReason::Length) => ("length", truncated.unwrap_or_else(|| "max_tokens".to_owned())),
            Some(FinishReason::ContentFilter) => ("content-filter", "content_filter".to_owned()),
            Some(FinishReason::Other(raw)) => ("other", raw),
            Some(_) => ("other", "unknown".to_owned()),
            None => Err("provider stream ended without a completion marker")?,
        };
        yield json!({"type":"finish","finishReason":reason,"rawFinishReason":raw});
    })
}

/// The provider's own reason for ending a response early, when Rig reports it
/// as `Response incomplete: <reason>` (`rig-core`'
/// `responses_api::finish_reason_of`). Only that status keeps the streamed
/// answer: a failed or cancelled response stays an error.
fn incomplete_reason(error: &str) -> Option<&str> {
    let reason = error
        .strip_prefix("Response incomplete")?
        .trim_start_matches(':')
        .trim();
    Some(reason)
}

/// The reason a cut-short turn is kept, if it is one: the provider reported an
/// incomplete response and there is a partial answer to keep. A turn that
/// produced nothing is a failure the loop may retry, never a silent success.
fn truncation_reason<'a>(error: Option<&'a str>, has_answer: bool) -> Option<&'a str> {
    if !has_answer {
        return None;
    }
    error.and_then(incomplete_reason)
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

#[cfg(test)]
mod tests {
    use super::{incomplete_reason, truncation_reason};

    #[test]
    fn keeps_a_cut_short_answer_instead_of_failing_the_turn() {
        assert_eq!(
            truncation_reason(Some("Response incomplete: length"), true),
            Some("length")
        );
        assert_eq!(
            truncation_reason(Some("Response incomplete: max_output_tokens"), true),
            Some("max_output_tokens")
        );
        assert_eq!(
            truncation_reason(Some("Response incomplete: max_tool_calls"), true),
            Some("max_tool_calls")
        );
        assert_eq!(
            truncation_reason(Some("Response incomplete without a provider reason"), true),
            Some("without a provider reason")
        );
    }

    #[test]
    fn keeps_reported_failures_fatal() {
        assert_eq!(
            truncation_reason(
                Some("Response failed: server_error: upstream refused"),
                true
            ),
            None
        );
        assert_eq!(
            truncation_reason(Some("Response cancelled: client closed the request"), true),
            None
        );
        assert_eq!(
            truncation_reason(Some("Response ended while in_progress"), true),
            None
        );
        assert_eq!(
            truncation_reason(Some("error decoding response body"), true),
            None
        );
        assert_eq!(truncation_reason(None, true), None);
    }

    #[test]
    fn keeps_a_turn_without_an_answer_fatal() {
        assert_eq!(
            truncation_reason(Some("Response incomplete: length"), false),
            None
        );
        assert_eq!(
            incomplete_reason("Response incomplete: length"),
            Some("length")
        );
    }
}
