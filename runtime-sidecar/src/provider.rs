//! Rust-owned LLM provider bridge.
//!
//! The Rust loop owns model/tool iteration; the host executes local tools. This module
//! owns provider SDKs, HTTP connections, protocol serialization and streaming.
//! It intentionally exposes a tiny loopback HTTP endpoint so the existing Node
//! LanguageModel abstraction can remain the compatibility boundary while all
//! provider network I/O happens in Rust.

use crate::agent_loop::{
    AgentLoopManager, AgentLoopRequest, ResumeLoopRequest, StepContextRequest, ToolResultRequest,
};
pub(crate) use crate::provider_adapter::provider_events;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_HEADERS_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct ProviderRequest {
    #[serde(rename = "apiFormat")]
    pub(crate) api_format: String,
    #[serde(default, rename = "providerId")]
    pub(crate) provider_id: Option<String>,
    #[serde(default, rename = "providerOptions")]
    pub(crate) provider_options: Value,
    #[serde(rename = "baseUrl")]
    pub(crate) base_url: Option<String>,
    #[serde(rename = "apiKey", skip_serializing)]
    pub(crate) api_key: Option<String>,
    #[serde(default, skip_serializing)]
    pub(crate) headers: HashMap<String, String>,
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) prompt: Vec<Value>,
    #[serde(default)]
    pub(crate) tools: Vec<Value>,
    #[serde(rename = "toolChoice")]
    pub(crate) tool_choice: Option<Value>,
    #[serde(rename = "maxOutputTokens")]
    pub(crate) max_output_tokens: Option<u32>,
    #[serde(default)]
    pub(crate) temperature: Option<f64>,
    #[serde(default, rename = "topP")]
    pub(crate) top_p: Option<f64>,
    #[serde(default, rename = "topK")]
    pub(crate) top_k: Option<u32>,
    #[serde(default, rename = "stopSequences")]
    pub(crate) stop_sequences: Vec<String>,
    #[serde(default, rename = "presencePenalty")]
    pub(crate) presence_penalty: Option<f64>,
    #[serde(default, rename = "frequencyPenalty")]
    pub(crate) frequency_penalty: Option<f64>,
    #[serde(default)]
    pub(crate) seed: Option<u64>,
    #[serde(default, rename = "responseFormat")]
    pub(crate) response_format: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct HttpRequest {
    method: String,
    path: String,
    authorization: Option<String>,
    content_length: usize,
    body: Vec<u8>,
}

pub async fn serve_http(
    listener: TcpListener,
    token: String,
    mut shutdown: watch::Receiver<bool>,
    store: Option<Arc<crate::storage::HotStore>>,
    router: Arc<crate::actor::SessionShardRouter>,
) -> Result<(), std::io::Error> {
    let token = Arc::new(token);
    let loops = AgentLoopManager::new(store).with_router(router);
    loop {
        tokio::select! {
            _ = shutdown.changed() => { loops.shutdown().await; return Ok(()); },
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let token = token.clone();
                let loops = loops.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_connection(stream, token, loops).await {
                        eprintln!("[runtime-sidecar] provider bridge failed: {error}");
                    }
                });
            }
        }
    }
}

async fn handle_connection(
    mut stream: TcpStream,
    token: Arc<String>,
    loops: AgentLoopManager,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let request = read_request(&mut stream).await?;
    if request.authorization.as_deref() != Some(&format!("Bearer {token}")) {
        write_json_error(&mut stream, 401, "provider bridge authentication failed").await?;
        return Ok(());
    }
    if request.content_length > MAX_BODY_BYTES {
        write_json_error(&mut stream, 413, "provider request is too large").await?;
        return Ok(());
    }
    if request.method == "POST" && request.path == "/agent-loop/start" {
        let input: AgentLoopRequest = serde_json::from_slice(&request.body)?;
        match loops.start(input).await {
            Ok(loop_id) => write_json(&mut stream, 200, &json!({"loopId":loop_id})).await?,
            Err(error) => write_json_error(&mut stream, 400, &error.to_string()).await?,
        }
        return Ok(());
    }
    if request.method == "POST" && request.path == "/agent-loop/resume" {
        let input: ResumeLoopRequest = serde_json::from_slice(&request.body)?;
        match loops.resume(input).await {
            Ok(()) => write_json(&mut stream, 200, &json!({"ok":true})).await?,
            Err(error) => write_json_error(&mut stream, 409, &error.to_string()).await?,
        }
        return Ok(());
    }
    if request.method == "POST" && request.path == "/agent-loop/context" {
        let input: StepContextRequest = serde_json::from_slice(&request.body)?;
        match loops.set_context(input).await {
            Ok(()) => write_json(&mut stream, 200, &json!({"ok":true})).await?,
            Err(error) => write_json_error(&mut stream, 409, &error.to_string()).await?,
        }
        return Ok(());
    }
    if request.method == "POST" && request.path == "/agent-loop/tool-result" {
        let input: ToolResultRequest = serde_json::from_slice(&request.body)?;
        match loops.send_tool_result(input).await {
            Ok(()) => write_json(&mut stream, 200, &json!({"ok":true})).await?,
            Err(error) => write_json(&mut stream, 409, &json!({"error":error.to_string()})).await?,
        }
        return Ok(());
    }
    if request.method == "POST" && request.path == "/agent-loop/cancel" {
        let body: Value = serde_json::from_slice(&request.body)?;
        let loop_id = body
            .get("loopId")
            .and_then(Value::as_str)
            .ok_or("loopId is required")?;
        match loops.cancel(loop_id).await {
            Ok(()) => write_json(&mut stream, 200, &json!({"ok":true})).await?,
            Err(error) => write_json(&mut stream, 404, &json!({"error":error.to_string()})).await?,
        }
        return Ok(());
    }
    if request.method == "GET" && request.path.starts_with("/agent-loop/events?") {
        let query = request
            .path
            .split_once('?')
            .map(|(_, query)| query)
            .unwrap_or_default();
        let params: HashMap<_, _> = query
            .split('&')
            .filter_map(|part| part.split_once('='))
            .collect();
        let Some(loop_id) = params.get("loopId") else {
            write_json_error(&mut stream, 400, "loopId is required").await?;
            return Ok(());
        };
        let after = match params.get("after").unwrap_or(&"0").parse::<usize>() {
            Ok(after) => after,
            Err(_) => {
                write_json_error(&mut stream, 400, "invalid event cursor").await?;
                return Ok(());
            }
        };
        let mut events = match loops.subscribe_events(loop_id, after).await {
            Ok(events) => events,
            Err(error) => {
                write_json_error(&mut stream, 409, &error.to_string()).await?;
                return Ok(());
            }
        };
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n").await?;
        while let Some(event) = events.next().await? {
            write_chunk(&mut stream, &event).await?;
        }
        stream.write_all(b"0\r\n\r\n").await?;
        let _ = stream.shutdown().await;
        return Ok(());
    }
    if request.method != "POST" || request.path != "/provider/stream" {
        write_json_error(&mut stream, 404, "provider endpoint not found").await?;
        return Ok(());
    }
    if request.content_length > MAX_BODY_BYTES {
        write_json_error(&mut stream, 413, "provider request is too large").await?;
        return Ok(());
    }
    let input: ProviderRequest = match serde_json::from_slice(&request.body) {
        Ok(input) => input,
        Err(error) => {
            write_json_error(
                &mut stream,
                400,
                &format!("invalid provider request: {error}"),
            )
            .await?;
            return Ok(());
        }
    };
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n").await?;
    if let Err(error) = stream_provider(input, &mut stream).await {
        write_chunk(
            &mut stream,
            &json!({"type":"error","error":error.to_string()}),
        )
        .await?;
    }
    stream.write_all(b"0\r\n\r\n").await?;
    let _ = stream.shutdown().await;
    Ok(())
}

async fn read_request(
    stream: &mut TcpStream,
) -> Result<HttpRequest, Box<dyn std::error::Error + Send + Sync>> {
    let mut headers = Vec::with_capacity(4096);
    let header_end = loop {
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await?;
        headers.push(byte[0]);
        if headers.len() > MAX_HEADERS_BYTES {
            return Err("provider request headers are too large".into());
        }
        if headers.ends_with(b"\r\n\r\n") {
            break headers.len() - 4;
        }
    };
    let text = std::str::from_utf8(&headers[..header_end])?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or("missing HTTP request line")?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_owned();
    let path = request_parts.next().unwrap_or_default().to_owned();
    let mut authorization = None;
    let mut content_length = 0usize;
    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim().to_ascii_lowercase().as_str() {
            "authorization" => authorization = Some(value.trim().to_owned()),
            "content-length" => content_length = value.trim().parse().unwrap_or(usize::MAX),
            _ => {}
        }
    }
    if content_length > MAX_BODY_BYTES {
        return Ok(HttpRequest {
            method,
            path,
            authorization,
            content_length,
            body: Vec::new(),
        });
    }
    let mut body = vec![0u8; content_length];
    stream.read_exact(&mut body).await?;
    Ok(HttpRequest {
        method,
        path,
        authorization,
        content_length,
        body,
    })
}

async fn write_json_error(
    stream: &mut TcpStream,
    status: u16,
    message: &str,
) -> Result<(), std::io::Error> {
    let body = serde_json::to_vec(&json!({"error":message}))
        .unwrap_or_else(|_| b"{\"error\":\"provider error\"}".to_vec());
    let header = format!(
        "HTTP/1.1 {status} Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(&body).await
}

async fn write_json(
    stream: &mut TcpStream,
    status: u16,
    value: &Value,
) -> Result<(), std::io::Error> {
    let body = serde_json::to_vec(value)
        .unwrap_or_else(|_| b"{\"error\":\"serialization error\"}".to_vec());
    let header = format!(
        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(&body).await
}

async fn write_chunk(stream: &mut TcpStream, value: &Value) -> Result<(), std::io::Error> {
    let mut bytes = serde_json::to_vec(value)
        .unwrap_or_else(|_| b"{\"type\":\"error\",\"error\":\"serialization error\"}".to_vec());
    bytes.push(b'\n');
    stream
        .write_all(format!("{:X}\r\n", bytes.len()).as_bytes())
        .await?;
    stream.write_all(&bytes).await?;
    stream.write_all(b"\r\n").await
}

type ProviderError = Box<dyn std::error::Error + Send + Sync>;

async fn stream_provider(
    input: ProviderRequest,
    stream: &mut TcpStream,
) -> Result<(), ProviderError> {
    let mut events = provider_events(input);
    let mut disconnect = [0u8; 1];
    loop {
        let event = tokio::select! {
            // A provider call belongs to its consumer. Stop the upstream even
            // when it is idle and will not produce another writable chunk.
            _ = stream.read(&mut disconnect) => return Ok(()),
            event = events.next() => event,
        };
        let Some(event) = event else {
            break;
        };
        write_chunk(stream, &event?).await?;
    }
    Ok(())
}
