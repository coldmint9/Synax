//! Preserve explicit cache boundaries through Rig's canonical message mapping.
//! Protocol bodies and HTTP/SSE transport remain owned by Rig.
use crate::llm::contract::ProviderRequest;
use bytes::Bytes;
use rig_core::{
    http_client::{self, HeaderMap, HttpMiddleware, Method, Uri},
    wasm_compat::WasmBoxedFuture,
};
use serde_json::{Value, json};

pub(crate) struct RequestMetadata {
    headers: HeaderMap,
    protocol: String,
    boundaries: Vec<Boundary>,
    image_details: Vec<Option<String>>,
}
struct Boundary {
    section: &'static str,
    signature: Value,
    key: &'static str,
    value: Option<Value>,
}

fn cache(value: &Value, protocol: &str) -> Option<Value> {
    if protocol == "anthropic" {
        value
            .pointer("/providerOptions/anthropic/cacheControl")
            .or_else(|| value.pointer("/providerOptions/anthropic/cache_control"))
            .cloned()
    } else if protocol == "openai" {
        value
            .pointer("/providerOptions/openai/promptCacheBreakpoint")
            .cloned()
    } else {
        None
    }
}
impl RequestMetadata {
    pub(crate) fn new(
        input: &ProviderRequest,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let mut headers = HeaderMap::new();
        for (key, value) in &input.headers {
            headers.insert(key.parse::<http::HeaderName>()?, value.parse()?);
        }
        let protocol = &input.api_format;
        let key = if protocol == "anthropic" {
            "cache_control"
        } else {
            "prompt_cache_breakpoint"
        };
        let mut boundaries = Vec::new();
        for tool in &input.tools {
            boundaries.push(Boundary {
                section: "tools",
                signature: json!({"name":tool["name"]}),
                key,
                value: cache(tool, protocol),
            });
        }
        for message in &input.prompt {
            let section = if protocol == "anthropic" && message["role"] == "system" {
                "system"
            } else {
                "messages"
            };
            let parts = message["content"]
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![json!({"type":"text","text":message["content"]})]);
            let last = parts.len().saturating_sub(1);
            for (index, part) in parts.iter().enumerate() {
                let signature = match part["type"].as_str() {
                    Some("text") => json!({"type":"text","text":part["text"]}),
                    Some("tool-call" | "tool_use") if protocol == "anthropic" => {
                        json!({"type":"tool_use","id":part.get("toolCallId").or_else(||part.get("id"))})
                    }
                    Some("tool-result" | "tool_result") if protocol == "anthropic" => {
                        json!({"type":"tool_result","tool_use_id":part.get("toolCallId").or_else(||part.get("tool_use_id"))})
                    }
                    Some("image" | "file") if protocol == "anthropic" => json!({"type":"image"}),
                    _ => continue,
                };
                let value = cache(part, protocol)
                    .or_else(|| cache(&part["output"], protocol))
                    .or_else(|| {
                        if index == last {
                            cache(message, protocol)
                        } else {
                            None
                        }
                    });
                boundaries.push(Boundary {
                    section,
                    signature,
                    key,
                    value,
                });
            }
        }
        Ok(Self {
            headers,
            protocol: protocol.clone(),
            boundaries,
            image_details: image_details(&json!(input.prompt)),
        })
    }

    fn apply(&self, body: &mut Value) {
        apply_image_details(body, &mut self.image_details.iter());
        for section in ["tools", "system", "messages"] {
            let mut entries = Vec::new();
            paths(&body[section], format!("/{section}"), &mut entries);
            let mut cursor = 0;
            for boundary in self
                .boundaries
                .iter()
                .filter(|item| item.section == section)
            {
                let matched = entries
                    .iter()
                    .enumerate()
                    .skip(cursor)
                    .find(|(_, (_, value))| {
                        boundary.signature.as_object().is_some_and(|signature| {
                            signature
                                .iter()
                                .all(|(key, expected)| value.get(key) == Some(expected))
                        })
                    });
                let Some((index, (path, _))) = matched else {
                    continue;
                };
                cursor = index + 1;
                if let Some(marker) = &boundary.value {
                    if let Some(target) = body.pointer_mut(path) {
                        target[boundary.key] = marker.clone();
                    }
                }
            }
        }
        if self.protocol == "openai" {
            if let Some(messages) = body["messages"].as_array_mut() {
                for message in messages {
                    if let Some(parts) = message["content"].as_array() {
                        if parts.len() == 1
                            && parts[0]["type"] == "text"
                            && parts[0].as_object().is_some_and(|part| part.len() == 2)
                        {
                            message["content"] = parts[0]["text"].clone();
                        }
                    }
                }
            }
        }
    }
}
fn image_details(value: &Value) -> Vec<Option<String>> {
    let mut details = Vec::new();
    match value {
        Value::Array(items) => {
            for item in items {
                details.extend(image_details(item));
            }
        }
        Value::Object(object) => {
            if value["type"] == "image"
                || (value["type"] == "file"
                    && value["mediaType"]
                        .as_str()
                        .is_some_and(|media| media.starts_with("image/")))
            {
                details.push(
                    value
                        .pointer("/providerOptions/openai/imageDetail")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                );
            } else {
                for key in ["content", "output", "value"] {
                    if let Some(child) = object.get(key) {
                        details.extend(image_details(child));
                    }
                }
            }
        }
        _ => {}
    }
    details
}

fn apply_image_details<'a>(
    value: &mut Value,
    details: &mut impl Iterator<Item = &'a Option<String>>,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                apply_image_details(item, details);
            }
        }
        Value::Object(object) => match object.get("type").and_then(Value::as_str) {
            Some("input_image") if object.contains_key("image_url") => {
                if let Some(Some(detail)) = details.next() {
                    object.insert("detail".into(), json!(detail));
                }
            }
            Some("image_url") if object.contains_key("image_url") => {
                if let Some(Some(detail)) = details.next() {
                    object.get_mut("image_url").unwrap()["detail"] = json!(detail);
                }
            }
            _ => {
                for key in ["input", "messages", "content", "output"] {
                    if let Some(child) = object.get_mut(key) {
                        apply_image_details(child, details);
                    }
                }
            }
        },
        _ => {}
    }
}
fn paths(value: &Value, path: String, output: &mut Vec<(String, Value)>) {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                paths(item, format!("{path}/{index}"), output);
            }
        }
        Value::Object(map) => {
            if map.contains_key("type") || map.contains_key("name") {
                output.push((path.clone(), value.clone()));
            }
            for key in ["content", "function"] {
                if let Some(value) = map.get(key) {
                    paths(value, format!("{path}/{key}"), output);
                }
            }
        }
        _ => {}
    }
}
impl HttpMiddleware for RequestMetadata {
    fn before_request_headers<'a>(
        &'a self,
        _: &'a Method,
        _: &'a Uri,
        headers: &'a mut HeaderMap,
    ) -> WasmBoxedFuture<'a, http_client::Result<()>> {
        Box::pin(async move {
            headers.extend(self.headers.clone());
            Ok(())
        })
    }
    fn before_request_body<'a>(
        &'a self,
        _: &'a Method,
        _: &'a Uri,
        _: &'a HeaderMap,
        body: Bytes,
    ) -> WasmBoxedFuture<'a, http_client::Result<Bytes>> {
        Box::pin(async move {
            let mut value: Value = serde_json::from_slice(&body)
                .map_err(|error| http_client::Error::Instance(Box::new(error)))?;
            self.apply(&mut value);
            crate::llm::tool_names::validate_body(&value, &self.protocol)
                .map_err(http_client::Error::Instance)?;
            Ok(Bytes::from(serde_json::to_vec(&value).map_err(
                |error| http_client::Error::Instance(Box::new(error)),
            )?))
        })
    }
}
