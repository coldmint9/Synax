//! Rust-owned LLM provider bridge.
//!
//! The Rust loop owns model/tool iteration; the host executes local tools. This module
//! owns provider SDKs, HTTP connections, protocol serialization and streaming.
//! It intentionally exposes a tiny loopback HTTP endpoint so the existing Node
//! LanguageModel abstraction can remain the compatibility boundary while all
//! provider network I/O happens in Rust.

use crate::agent::runner::{
    AgentLoopManager, AgentLoopRequest, ResumeLoopRequest, StepContextRequest, ToolResultRequest,
};
pub(crate) use crate::llm::completion::provider_events;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tracing::Instrument;

const MAX_BODY_BYTES: usize = 160 * 1024 * 1024;
const MAX_HEADERS_BYTES: usize = 64 * 1024;

use crate::llm::contract::ProviderRequest;

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
    store: Option<Arc<crate::storage::jsonl::hot::HotOps>>,
    router: Arc<crate::runtime::actor::SessionShardRouter>,
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
                let span = tracing::error_span!("http_request", request_id = %uuid::Uuid::new_v4(),
                    method = tracing::field::Empty, route = tracing::field::Empty, status = tracing::field::Empty);
                tokio::spawn(async move {
                    let started = std::time::Instant::now();
                    if let Err(error) = handle_connection(stream, token, loops).await {
                        tracing::warn!(event = "http.failed", error_kind = crate::logging::error_kind(error.as_ref()),
                            duration_ms = started.elapsed().as_millis() as u64, "HTTP connection failed");
                    } else {
                        tracing::debug!(event = "http.completed", duration_ms = started.elapsed().as_millis() as u64,
                            "HTTP request completed");
                    }
                }.instrument(span));
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
    // Only log known routes, never a query string (which may carry credentials).
    let route = match request.path.split('?').next().unwrap_or("") {
        value @ ("/agent-loop/start" | "/agent-loop/resume" | "/agent-loop/check" | "/agent-loop/context" |
            "/agent-loop/tool-result" | "/agent-loop/cancel" | "/agent-loop/events" |
            "/provider/prepare" | "/provider/stream" | "/media/stream") => value,
        _ => "unknown",
    };
    tracing::Span::current().record("method", match request.method.as_str() { "GET" => "GET", "POST" => "POST", _ => "other" });
    tracing::Span::current().record("route", route);
    tracing::debug!(event = "http.received", body_bytes = request.content_length, "HTTP request received");
    if request.authorization.as_deref() != Some(&format!("Bearer {token}")) {
        write_json_error(&mut stream, 401, "provider bridge authentication failed").await?;
        return Ok(());
    }
    if request.content_length > MAX_BODY_BYTES {
        write_json_error(&mut stream, 413, "provider request is too large").await?;
        return Ok(());
    }
    if request.method == "POST" && request.path == "/agent-loop/check" {
        let input: Value = serde_json::from_slice(&request.body)?;
        let id = input["loopId"].as_str().ok_or("loopId required")?;
        let context: Option<crate::runtime::execution::ExecutionLease> = serde_json::from_value(input["executionContext"].clone())?;
        match loops.check(id, context.as_ref()).await {
            Ok(()) => write_json(&mut stream, 200, &json!({"ok":true})).await?,
            Err(error) => write_json_error(&mut stream, 409, &error.to_string()).await?,
        }
        return Ok(());
    }
    if request.method == "POST" && request.path == "/agent-loop/start" {
        let input: AgentLoopRequest = serde_json::from_slice(&request.body)?;
        match loops.start(input).await {
            Ok(loop_id) => write_json(&mut stream, 200, &json!({"loopId":loop_id})).await?,
            Err(error) => write_json_error(&mut stream, if error.to_string().starts_with("RUN_INTERRUPTED:") { 409 } else { 400 }, &error.to_string()).await?,
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
        record_status(200);
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n").await?;
        while let Some(event) = events.next().await? {
            write_chunk(&mut stream, &event).await?;
        }
        stream.write_all(b"0\r\n\r\n").await?;
        let _ = stream.shutdown().await;
        return Ok(());
    }
    if request.method == "POST" && request.path == "/provider/prepare" {
        let input: ProviderRequest = serde_json::from_slice(&request.body)?;
        record_status(200);
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await?;
        write_chunk(&mut stream, &json!({"type":"prepared","request":crate::llm::prepare(input)})).await?;
        stream.write_all(b"0\r\n\r\n").await?;
        return Ok(());
    }
    if request.method != "POST" || !matches!(request.path.as_str(), "/provider/stream" | "/media/stream") {
        write_json_error(&mut stream, 404, "provider endpoint not found").await?;
        return Ok(());
    }
    if request.content_length > MAX_BODY_BYTES {
        write_json_error(&mut stream, 413, "provider request is too large").await?;
        return Ok(());
    }
    let events = if request.path == "/media/stream" {
        match serde_json::from_slice::<crate::llm::media::MediaRequest>(&request.body) {
            Ok(input) => crate::llm::media::events(input),
            Err(error) => { write_json_error(&mut stream, 400, &format!("invalid media request: {error}")).await?; return Ok(()); }
        }
    } else {
        match serde_json::from_slice::<ProviderRequest>(&request.body) {
            Ok(input) => provider_events(input),
            Err(error) => { write_json_error(&mut stream, 400, &format!("invalid provider request: {error}")).await?; return Ok(()); }
        }
    };
    record_status(200);
    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n").await?;
    if let Err(error) = stream_events(events, &mut stream).await {
        write_chunk(
            &mut stream,
            &json!({"type":"error","error":error.to_string(),
                "statusCode":crate::llm::retry::http_status(error.as_ref()),
                "isRetryable":if error.is::<crate::llm::retry::RetriesExhausted>() { Some(false) } else { None }}),
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
    record_status(status);
    let body = serde_json::to_vec(&if message.starts_with("RUN_INTERRUPTED:") { json!({"code":"RUN_INTERRUPTED","error":message}) } else { json!({"error":message}) })
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
    record_status(status);
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

fn record_status(status: u16) {
    tracing::Span::current().record("status", status);
    if status >= 400 {
        tracing::warn!(event = "http.rejected", status, "HTTP request rejected");
    }
}

async fn stream_events(
    mut events: futures_util::stream::BoxStream<'static, Result<Value, ProviderError>>,
    stream: &mut TcpStream,
) -> Result<(), ProviderError> {
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
