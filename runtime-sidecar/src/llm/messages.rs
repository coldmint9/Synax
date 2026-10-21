//! Lossless conversation, tool receipt and attachment mapping.
use super::{Error, common::content_text, contract::ProviderRequest};
use rig_core::message::{
    AssistantContent, AssistantMessage, Audio, Document, DocumentSourceKind, Image, Message,
    Opaque, Origin, Reasoning, ToolCall, ToolFunction, ToolName, ToolResultContent, UserContent,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

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
