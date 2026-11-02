//! Lossless conversation, tool receipt and attachment mapping.
use super::{Error, common::content_text, contract::ProviderRequest, tokenizer::tokens};
use rig_core::message::{
    AssistantContent, AssistantMessage, Audio, Document, DocumentSourceKind, Image, Message,
    Opaque, Origin, Reasoning, ToolCall, ToolFunction, ToolName, ToolResultContent, UserContent,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// A single displayed answer can retain several original signed provider turns.
pub(crate) fn expanded_messages(prompt: &[Value]) -> Vec<&Value> {
    prompt
        .iter()
        .flat_map(|message| {
            match message
                .get("continuationMessages")
                .and_then(Value::as_array)
            {
                Some(messages) if !messages.is_empty() => messages.iter().collect(),
                _ => vec![message],
            }
        })
        .collect()
}

const MESSAGE_OVERHEAD_TOKENS: usize = 4;
const TOOL_CALL_OVERHEAD_TOKENS: usize = 8;

/// Text tokens the provider receives for one prompt message.
///
/// A stored message can carry the same turn twice — the canonical content and
/// the provider's `rigMessage` copy with its native item echoes — while the
/// request rebuilds exactly one of them. Counting the whole record therefore
/// overstates context by the size of the duplicate, so this walks the parts the
/// provider is actually sent. It never fails on legacy or partial prompts
/// because it only classifies parts; unknown parts count as zero.
pub(crate) fn message_text_tokens(value: &Value) -> usize {
    let mut total = MESSAGE_OVERHEAD_TOKENS;
    if let Some(rig) = value.get("rigMessage") {
        for part in rig
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            total += content_part_tokens(part);
        }
        return total;
    }
    match value.get("content").unwrap_or(&Value::Null) {
        Value::String(text) => total += tokens(text),
        Value::Array(parts) => {
            for part in parts {
                total += content_part_tokens(part);
            }
        }
        _ => {}
    }
    total
}

fn content_part_tokens(part: &Value) -> usize {
    match part.get("type").and_then(Value::as_str).unwrap_or("text") {
        "text" => tokens(part.get("text").and_then(Value::as_str).unwrap_or_default()),
        "thinking" | "reasoning" => tokens(
            part.get("text")
                .or_else(|| part.get("thinking"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        "tool-call" | "tool_use" | "toolcall" => {
            let function = part.get("function");
            let name = function
                .and_then(|function| function.get("name"))
                .or_else(|| part.get("toolName"))
                .or_else(|| part.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let arguments = function
                .and_then(|function| function.get("arguments"))
                .or_else(|| part.get("input"))
                .or_else(|| part.get("arguments"));
            TOOL_CALL_OVERHEAD_TOKENS
                + tokens(name)
                + tokens(&match arguments {
                    Some(Value::String(arguments)) => arguments.clone(),
                    Some(arguments) => arguments.to_string(),
                    None => String::new(),
                })
        }
        "tool-result" | "tool_result" | "toolresult" => {
            TOOL_CALL_OVERHEAD_TOKENS
                + tokens(
                    part.get("toolName")
                        .or_else(|| part.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
                + tokens(&output_text(
                    part.get("output")
                        .or_else(|| part.get("content"))
                        .unwrap_or(&Value::Null),
                ))
        }
        // Media bytes are billed by the provider, never as prompt text.
        _ => 0,
    }
}

fn output_text(output: &Value) -> String {
    if let Value::Array(parts) = output {
        return text_parts(parts);
    }
    match output.get("type").and_then(Value::as_str) {
        Some("json" | "error-json") => output
            .get("value")
            .map(Value::to_string)
            .unwrap_or_default(),
        Some("content") => output
            .get("value")
            .and_then(Value::as_array)
            .map(|parts| text_parts(parts))
            .unwrap_or_default(),
        _ => match output.get("value") {
            Some(Value::String(text)) => text.clone(),
            Some(value) => value.to_string(),
            None => output
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        },
    }
}

fn text_parts(parts: &[Value]) -> String {
    parts
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn convert_message(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_a_turn_once_although_the_record_keeps_two_copies() {
        let text = "Resolve the kanban snapshot cache before revalidating.";
        // The stored turn keeps the canonical copy, the provider copy and the
        // provider item echo of one text the request sends once.
        let message = json!({
            "role":"assistant",
            "content":[{"type":"text","text":text}],
            "rigMessage":{"content":[{"type":"text","text":text,"native":{
                "item":{"type":"message","role":"assistant",
                    "content":[{"type":"output_text","text":text}],"id":"msg_1"},
                "fingerprint":"f"}}]}
        });
        assert_eq!(
            message_text_tokens(&message),
            tokens(text) + MESSAGE_OVERHEAD_TOKENS
        );
    }

    #[test]
    fn native_reasoning_echoes_and_media_are_not_prompt_text() {
        let reasoning = "Check the composer ring before changing the estimator.";
        let echoed = json!({
            "role":"assistant",
            "rigMessage":{"content":[{
                "type":"reasoning","text":reasoning,
                "native":{"item":{"type":"reasoning","id":"rs_1",
                    "summary":[{"type":"summary_text","text":reasoning}]}}
            }]}
        });
        assert_eq!(
            message_text_tokens(&echoed),
            tokens(reasoning) + MESSAGE_OVERHEAD_TOKENS
        );

        let media = json!({
            "role":"user",
            "content":[
                {"type":"text","text":"Look"},
                {"type":"file","source":{"type":"base64","data":"QUJD".repeat(20_000)}}
            ]
        });
        assert_eq!(
            message_text_tokens(&media),
            MESSAGE_OVERHEAD_TOKENS + tokens("Look")
        );
    }

    #[test]
    fn counts_tool_results_without_their_attachment_bytes() {
        let output = "Evidence line.\n".repeat(500);
        let message = json!({
            "role":"tool",
            "content":[{"type":"tool-result","toolCallId":"call","toolName":"bash","output":{
                "type":"content",
                "value":[{"type":"text","text":output},{"type":"image","source":{"type":"base64","data":"QUJD".repeat(5000)}}]
            }}]
        });
        let count = message_text_tokens(&message);
        assert!(count >= tokens(&output));
        assert!(
            count < tokens(&output)
                + tokens("bash")
                + MESSAGE_OVERHEAD_TOKENS
                + TOOL_CALL_OVERHEAD_TOKENS
                + 32
        );
    }

    #[test]
    fn cjk_text_is_estimated_per_character_not_per_byte() {
        let text = "修复上下文统计：总量取服务商实测，分类保持本地估算，中文按字符计费。";
        let characters = text.chars().count();
        let count = tokens(text);
        // A byte-level fallback would charge three UTF-8 bytes per character.
        assert!(count * 2 >= characters, "CJK text is under-counted: {count} for {characters} characters");
        assert!(
            count * 2 <= characters * 3,
            "CJK text is over-counted: {count} for {characters} characters"
        );
    }
}
