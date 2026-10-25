//! Renew length-limited model requests inside one visible agent step.
use super::{
    Error, completion::provider_events, contract::ProviderRequest, errors::InvalidToolArguments,
};
use futures_util::{StreamExt, stream::BoxStream};
use rig_core::message::{AssistantContent, Message};
use serde_json::{Value, json};

const MAX_CONTINUATIONS: usize = 8;
const CONTINUE: &str = "Your previous response reached its output token limit. Continue exactly where it stopped. Do not repeat the text already delivered, add a new preamble, or describe this continuation. Finish the requested work.";
const RETRY_TOOLS: &str = "Your previous response reached its output token limit while producing tool calls. None of those calls were executed. Reissue the intended calls with complete valid JSON; split large writes into smaller calls. Do not repeat text already delivered.";

/// Each upstream attempt keeps its own retry/cancellation/resource accounting.
/// Only the final assistant/tool batch and finish marker reach the agent runner.
pub(crate) fn continuing_provider_events(
    mut input: ProviderRequest,
    input_budget: Option<usize>,
    count_input: fn(&ProviderRequest) -> Result<usize, Error>,
) -> BoxStream<'static, Result<Value, Error>> {
    Box::pin(async_stream::try_stream! {
        let mut chain = Vec::new();
        let mut text = String::new();
        let mut output_tokens = 0u64;
        let mut thinking_tokens = 0u64;
        let mut usage = Value::Null;
        let mut raw_usage_complete = true;
        let mut no_progress = 0;
        for attempt in 0..=MAX_CONTINUATIONS {
            if attempt > 0 {
                if let Some(budget) = input_budget {
                    if count_input(&input)? > budget {
                        Err("OUTPUT_CONTINUATION_CONTEXT_LIMIT: not enough context to continue the partial answer")?;
                    }
                }
            }
            let mut stream = provider_events(input.clone());
            let mut assistant = None;
            let mut calls = Vec::new();
            let mut finish = None;
            let mut truncated_call = false;
            let mut prefix = Prefix::new(&text);
            let before = text.len();
            let base_output = output_tokens;
            let base_thinking = thinking_tokens;
            while let Some(event) = stream.next().await {
                let mut event = match event {
                    Ok(event) => event,
                    Err(error) if error.downcast_ref::<InvalidToolArguments>().is_some_and(|error| error.is_truncated()) => {
                        truncated_call = true;
                        break;
                    }
                    Err(error) => Err(error)?,
                };
                match event["type"].as_str() {
                    Some("text-delta") => {
                        output_tokens = base_output + event["outputTokens"].as_u64().unwrap_or(0);
                        event["outputTokens"] = json!(output_tokens);
                        if attempt > 0 { event.as_object_mut().unwrap().remove("firstTokenTiming"); }
                        let delta = prefix.push(event["delta"].as_str().unwrap_or_default(), false);
                        if !delta.is_empty() {
                            text.push_str(&delta);
                            event["delta"] = json!(delta);
                            yield event;
                        }
                    }
                    Some("reasoning-delta") => {
                        thinking_tokens = base_thinking + event["thinkingTokens"].as_u64().unwrap_or(0);
                        event["thinkingTokens"] = json!(thinking_tokens);
                        yield event;
                    }
                    Some("usage") => {
                        raw_usage_complete &= event["usage"]["raw"].is_object();
                        add_usage(&mut usage, &event["usage"]);
                        if !raw_usage_complete {
                            if let Some(usage) = usage.as_object_mut() { usage.remove("raw"); }
                        }
                        event["usage"] = usage.clone();
                        event["usage"]["providerRequestCount"] = json!(attempt + 1);
                        yield event;
                    }
                    Some("assistant-message") => assistant = event.get("message").cloned(),
                    Some("tool-call") => calls.push(event),
                    Some("finish") => finish = Some(event),
                    Some("stream-start") if attempt > 0 => {},
                    _ => yield event,
                }
            }
            let suffix = prefix.push("", true);
            if !suffix.is_empty() {
                text.push_str(&suffix);
                yield json!({"type":"text-delta","id":"rust-continuation-tail","delta":suffix,"outputTokens":output_tokens});
            }
            let limited = truncated_call || finish.as_ref().is_some_and(|event| event["finishReason"] == "length");
            let mut assistant = assistant.ok_or("provider continuation is missing assistant content")?;
            if limited {
                no_progress = if text.len() == before { no_progress + 1 } else { 0 };
                if attempt == MAX_CONTINUATIONS || no_progress >= 2 {
                    Err("OUTPUT_CONTINUATION_LIMIT: repeated output truncation could not complete the answer; partial text was retained")?;
                }
                let had_calls = truncated_call || !calls.is_empty();
                if let Some(partial) = without_tools(assistant)? {
                    input.prompt.push(partial.clone());
                    chain.push(partial);
                }
                let instruction = json!({"role":"user","content":[{"type":"text","text":if had_calls { RETRY_TOOLS } else { CONTINUE }}]});
                input.prompt.push(instruction.clone());
                chain.push(instruction);
                tracing::info!(event = "provider.output_continuation", attempt = attempt + 1,
                    max_continuations = MAX_CONTINUATIONS, tool_batch_discarded = had_calls,
                    "Continuing a length-limited response in the same agent step");
                continue;
            }
            let finish = finish.ok_or("provider continuation ended without a finish marker")?;
            if finish["finishReason"] == "content-filter" {
                Err("Provider response was stopped by a content filter")?;
            }
            if !chain.is_empty() {
                chain.push(assistant.clone());
                let mut parts = assistant["content"].as_array().cloned().unwrap_or_default();
                parts.retain(|part| part["type"] != "text");
                if !text.is_empty() { parts.insert(0, json!({"type":"text","text":text})); }
                // Preserve the original signed messages and intervening user
                // turns for replay. A synthetic merged rigMessage loses origins.
                assistant = json!({"role":"assistant","content":parts,"continuationMessages":chain});
            }
            yield json!({"type":"assistant-message","message":assistant});
            for call in calls { yield call; }
            yield finish;
            break;
        }
    })
}

fn without_tools(mut message: Value) -> Result<Option<Value>, Error> {
    if let Some(parts) = message["content"].as_array_mut() {
        parts.retain(|part| !matches!(part["type"].as_str(), Some("tool_use" | "tool-call")));
    }
    if let Some(rig) = message.get_mut("rigMessage") {
        let mut parsed: Message = serde_json::from_value(rig.clone())?;
        if let Message::Assistant(assistant) = &mut parsed {
            assistant
                .content
                .retain(|part| !matches!(part, AssistantContent::ToolCall(_)));
        }
        *rig = serde_json::to_value(parsed)?;
    }
    Ok(message["content"]
        .as_array()
        .is_some_and(|parts| !parts.is_empty())
        .then_some(message))
}

fn add_usage(total: &mut Value, next: &Value) {
    match (&mut *total, next) {
        (Value::Object(total), Value::Object(next)) => {
            for (key, value) in next {
                add_usage(total.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (total, Value::Number(next)) if next.as_u64().is_some() => {
            *total = json!(
                total
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(next.as_u64().unwrap())
            );
        }
        (total, next) if total.is_null() => *total = next.clone(),
        _ => {}
    }
}

/// Hold only the start of a continuation while it might repeat the previous
/// suffix. Short common words are never removed; UTF-8 boundaries are respected.
struct Prefix {
    tail: String,
    pending: String,
    decided: bool,
}
impl Prefix {
    fn new(previous: &str) -> Self {
        let tail = previous
            .chars()
            .rev()
            .take(512)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<String>();
        Self {
            decided: tail.chars().count() < 24,
            tail,
            pending: String::new(),
        }
    }
    fn push(&mut self, delta: &str, flush: bool) -> String {
        if self.decided {
            return delta.to_owned();
        }
        self.pending.push_str(delta);
        let candidates = self
            .tail
            .char_indices()
            .map(|(index, _)| &self.tail[index..])
            .filter(|suffix| suffix.chars().count() >= 24)
            .collect::<Vec<_>>();
        if !flush
            && candidates
                .iter()
                .any(|suffix| suffix.starts_with(&self.pending))
        {
            return String::new();
        }
        let overlap = candidates
            .iter()
            .filter(|suffix| self.pending.starts_with(**suffix))
            .map(|suffix| suffix.len())
            .max()
            .unwrap_or(0);
        self.decided = true;
        self.pending.drain(..overlap);
        std::mem::take(&mut self.pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drops_only_a_substantial_repeated_suffix_across_unicode_chunks() {
        let previous = "The first part has already been delivered to the user. 中文输出结束。";
        let mut prefix = Prefix::new(previous);
        assert_eq!(prefix.push("already been delivered", false), "");
        assert_eq!(
            prefix.push(" to the user. 中文输出结束。 Next part.", false),
            " Next part."
        );
        assert_eq!(prefix.push(" More.", false), " More.");
        assert_eq!(
            Prefix::new("the").push("the next part", true),
            "the next part"
        );
    }
    #[test]
    fn sums_raw_and_normalized_usage_without_adding_reasoning_twice() {
        let mut total = json!({"inputTokens":10,"outputTokens":8,"reasoningTokens":6,"raw":{"input_tokens":10,"output_tokens":8,"output_tokens_details":{"reasoning_tokens":6}}});
        add_usage(
            &mut total,
            &json!({"inputTokens":20,"outputTokens":5,"reasoningTokens":2,"raw":{"input_tokens":20,"output_tokens":5,"output_tokens_details":{"reasoning_tokens":2}}}),
        );
        assert_eq!(total["outputTokens"], 13);
        assert_eq!(total["raw"]["input_tokens"], 30);
        assert_eq!(total["raw"]["output_tokens_details"]["reasoning_tokens"], 8);
    }
}
