use crate::actor::{Durability, PendingEvent, RuntimeError, SessionShardRouter};
use crate::protocol::{
    ClientMessage, PROTOCOL_VERSION, ServerMessage, WireAck, WireAdmitRun, WireAppendStream,
    WireEnvelope, WireError, WireEventBatch, WireHealthResponse, WirePong, WireReady,
    WireRunAdmission, WireSnapshotResponse, WireStreamEvent, decode_client_message, decode_wire,
    encode_server_message, encode_wire, wire_envelope,
};
use futures_util::{SinkExt, StreamExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message};

const MAX_FRAME_BYTES: usize = 1024 * 1024;
const HANDSHAKE_CAPABILITIES: &[&str] = &[
    "health",
    "shutdown",
    "admit_run",
    "finish_run",
    "append_stream",
    "snapshot",
    "replay",
];

type WebSocket = WebSocketStream<TcpStream>;

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("websocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("protocol error: {0}")]
    Protocol(String),
}

#[derive(Clone)]
pub struct TransportContext {
    pub token: Arc<str>,
    pub shutdown: watch::Sender<bool>,
    pub router: Arc<SessionShardRouter>,
}

impl TransportContext {
    fn ready(&self, transport: &str) -> ServerMessage {
        ServerMessage::Ready {
            protocol: PROTOCOL_VERSION.to_owned(),
            transport: transport.to_owned(),
            capabilities: HANDSHAKE_CAPABILITIES
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
        }
    }

    fn wire_ready(&self, transport: &str) -> WireEnvelope {
        WireEnvelope {
            request_id: String::new(),
            session_id: String::new(),
            epoch: 0,
            revision: 0,
            body: Some(wire_envelope::Body::Ready(WireReady {
                protocol: PROTOCOL_VERSION.to_owned(),
                transport: transport.to_owned(),
                capabilities: HANDSHAKE_CAPABILITIES
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect(),
            })),
        }
    }
}

pub async fn serve_websocket(
    listener: TcpListener,
    context: TransportContext,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), TransportError> {
    loop {
        tokio::select! {
            _ = shutdown.changed() => return Ok(()),
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let child_context = context.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_websocket(stream, child_context).await {
                        eprintln!("[runtime-sidecar] websocket connection failed: {error}");
                    }
                });
            }
        }
    }
}

async fn handle_websocket(
    stream: TcpStream,
    context: TransportContext,
) -> Result<(), TransportError> {
    let mut socket = accept_async(stream).await?;
    let first = match socket.next().await {
        Some(Ok(message)) => message,
        Some(Err(error)) => return Err(error.into()),
        None => return Ok(()),
    };

    match first {
        Message::Text(text) => {
            if !authenticate_json(text.as_bytes(), &context)? {
                send_json(
                    &mut socket,
                    &ServerMessage::Error {
                        code: "UNAUTHENTICATED".to_owned(),
                        message: "hello authentication failed".to_owned(),
                    },
                )
                .await?;
                let _ = socket.close(None).await;
                return Ok(());
            }
            send_json(&mut socket, &context.ready("websocket")).await?;
            handle_json_websocket(socket, context).await
        }
        Message::Binary(bytes) => {
            let hello =
                decode_wire(&bytes).map_err(|error| TransportError::Protocol(error.to_string()))?;
            if !authenticate_wire(&hello, &context) {
                send_wire(
                    &mut socket,
                    &wire_error_envelope("UNAUTHENTICATED", "hello authentication failed"),
                )
                .await?;
                let _ = socket.close(None).await;
                return Ok(());
            }
            send_wire(&mut socket, &context.wire_ready("websocket")).await?;
            handle_wire_websocket(socket, context).await
        }
        Message::Ping(payload) => {
            let _ = socket.send(Message::Pong(payload)).await?;
            Ok(())
        }
        other => Err(TransportError::Protocol(format!(
            "expected hello frame, got {other:?}"
        ))),
    }
}

async fn handle_json_websocket(
    mut socket: WebSocket,
    context: TransportContext,
) -> Result<(), TransportError> {
    while let Some(message) = socket.next().await {
        match message? {
            Message::Text(text) => {
                if handle_json_message(text.as_bytes(), &context, &mut socket).await? {
                    return Ok(());
                }
            }
            Message::Binary(bytes) => {
                if handle_json_message(&bytes, &context, &mut socket).await? {
                    return Ok(());
                }
            }
            Message::Ping(payload) => socket.send(Message::Pong(payload)).await?,
            Message::Close(_) => return Ok(()),
            Message::Pong(_) | Message::Frame(_) => {}
        }
    }
    Ok(())
}

async fn handle_wire_websocket(
    mut socket: WebSocket,
    context: TransportContext,
) -> Result<(), TransportError> {
    while let Some(message) = socket.next().await {
        match message? {
            Message::Binary(bytes) => {
                let request = decode_wire(&bytes)
                    .map_err(|error| TransportError::Protocol(error.to_string()))?;
                if matches!(request.body, Some(wire_envelope::Body::Subscribe(_))) {
                    return handle_wire_subscription(socket, context, request).await;
                }
                let (response, should_shutdown) = execute_wire(request, &context).await;
                send_wire(&mut socket, &response).await?;
                if should_shutdown {
                    return Ok(());
                }
            }
            Message::Ping(payload) => socket.send(Message::Pong(payload)).await?,
            Message::Close(_) => return Ok(()),
            Message::Text(_) => {
                send_wire(
                    &mut socket,
                    &wire_error_envelope(
                        "BINARY_REQUIRED",
                        "authenticated binary connection requires protobuf frames",
                    ),
                )
                .await?;
            }
            Message::Pong(_) | Message::Frame(_) => {}
        }
    }
    Ok(())
}

async fn handle_wire_subscription(
    mut socket: WebSocket,
    context: TransportContext,
    request: WireEnvelope,
) -> Result<(), TransportError> {
    let session_id = request.session_id.clone();
    let request_id = request.request_id.clone();
    let after = match request.body {
        Some(wire_envelope::Body::Subscribe(subscribe)) => subscribe.after,
        _ => return Ok(()),
    };
    let (snapshot, mut receiver) = match context.router.subscribe(session_id.clone(), after).await {
        Ok(value) => value,
        Err(error) => {
            send_wire(
                &mut socket,
                &WireEnvelope {
                    request_id,
                    session_id,
                    epoch: 0,
                    revision: 0,
                    body: Some(error_to_wire(error)),
                },
            )
            .await?;
            return Ok(());
        }
    };
    send_wire(
        &mut socket,
        &WireEnvelope {
            request_id: request_id.clone(),
            session_id: session_id.clone(),
            epoch: snapshot.epoch,
            revision: snapshot.revision,
            body: Some(wire_envelope::Body::SnapshotResponse(
                WireSnapshotResponse {
                    epoch: snapshot.epoch,
                    revision: snapshot.revision,
                    active_run_id: snapshot.active_run_id,
                    cursor: snapshot.cursor,
                    retained_from: snapshot.retained_from,
                },
            )),
        },
    )
    .await?;

    loop {
        tokio::select! {
            message = socket.next() => {
                match message {
                    None | Some(Ok(Message::Close(_))) => return Ok(()),
                    Some(Ok(Message::Ping(payload))) => socket.send(Message::Pong(payload)).await?,
                    Some(Ok(Message::Text(_))) | Some(Ok(Message::Binary(_))) => {
                        send_wire(&mut socket, &wire_error_envelope("SUBSCRIPTION_READ_ONLY", "subscription connections only accept ping/close")).await?;
                    }
                    Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
                    Some(Err(error)) => return Err(error.into()),
                }
            }
            event = receiver.recv() => {
                let Some(event) = event else { return Ok(()); };
                send_wire(
                    &mut socket,
                    &WireEnvelope {
                        request_id: request_id.clone(),
                        session_id: session_id.clone(),
                        epoch: snapshot.epoch,
                        revision: snapshot.revision,
                        body: Some(wire_envelope::Body::EventBatch(WireEventBatch {
                            events: vec![WireStreamEvent {
                                sequence: event.sequence,
                                run_id: event.run_id,
                                kind: event.kind,
                                payload: event.payload,
                            }],
                        })),
                    },
                ).await?;
            }
        }
    }
}

async fn handle_json_message(
    bytes: &[u8],
    context: &TransportContext,
    socket: &mut WebSocket,
) -> Result<bool, TransportError> {
    match decode_client_message(bytes) {
        Ok(ClientMessage::Health) => {
            send_json(
                socket,
                &ServerMessage::Health {
                    ok: true,
                    protocol: PROTOCOL_VERSION.to_owned(),
                },
            )
            .await?;
        }
        Ok(ClientMessage::Ping) => send_json(socket, &ServerMessage::Pong).await?,
        Ok(ClientMessage::Shutdown) => {
            let _ = context.shutdown.send(true);
            send_json(
                socket,
                &ServerMessage::Ack {
                    request: "shutdown".to_owned(),
                },
            )
            .await?;
            return Ok(true);
        }
        Ok(ClientMessage::Hello { .. }) => {
            send_json(
                socket,
                &ServerMessage::Error {
                    code: "ALREADY_AUTHENTICATED".to_owned(),
                    message: "hello was already completed".to_owned(),
                },
            )
            .await?;
        }
        Err(error) => {
            send_json(
                socket,
                &ServerMessage::Error {
                    code: "INVALID_MESSAGE".to_owned(),
                    message: error.to_string(),
                },
            )
            .await?;
        }
    }
    Ok(false)
}

async fn execute_wire(request: WireEnvelope, context: &TransportContext) -> (WireEnvelope, bool) {
    let request_id = request.request_id.clone();
    let session_id = request.session_id.clone();
    let envelope = |body| WireEnvelope {
        request_id: request_id.clone(),
        session_id: session_id.clone(),
        epoch: request.epoch,
        revision: request.revision,
        body: Some(body),
    };

    match request.body {
        Some(wire_envelope::Body::Health(_)) => (
            envelope(wire_envelope::Body::HealthResponse(WireHealthResponse {
                ok: true,
                protocol: PROTOCOL_VERSION.to_owned(),
            })),
            false,
        ),
        Some(wire_envelope::Body::Ping(_)) => {
            (envelope(wire_envelope::Body::Pong(WirePong {})), false)
        }
        Some(wire_envelope::Body::Shutdown(_)) => {
            let _ = context.shutdown.send(true);
            (
                envelope(wire_envelope::Body::Ack(WireAck {
                    request: "shutdown".to_owned(),
                })),
                true,
            )
        }
        Some(wire_envelope::Body::AdmitRun(WireAdmitRun { body_hash, run_id })) => match context
            .router
            .admit_run(
                session_id.clone(),
                request_id.clone(),
                body_hash,
                run_id,
                request.epoch,
                request.revision,
            )
            .await
        {
            Ok(admission) => (
                WireEnvelope {
                    request_id,
                    session_id,
                    epoch: admission.epoch,
                    revision: admission.revision,
                    body: Some(wire_envelope::Body::RunAdmission(WireRunAdmission {
                        run_id: admission.run_id,
                        epoch: admission.epoch,
                        revision: admission.revision,
                        reused: admission.reused,
                    })),
                },
                false,
            ),
            Err(error) => (envelope(error_to_wire(error)), false),
        },
        Some(wire_envelope::Body::FinishRun(finish)) => {
            match context
                .router
                .finish_run(
                    session_id.clone(),
                    request_id.clone(),
                    finish.run_id,
                    finish.status,
                    request.epoch,
                    request.revision,
                )
                .await
            {
                Ok(snapshot) => (
                    WireEnvelope {
                        request_id,
                        session_id,
                        epoch: snapshot.epoch,
                        revision: snapshot.revision,
                        body: Some(wire_envelope::Body::SnapshotResponse(
                            WireSnapshotResponse {
                                epoch: snapshot.epoch,
                                revision: snapshot.revision,
                                active_run_id: snapshot.active_run_id,
                                cursor: snapshot.cursor,
                                retained_from: snapshot.retained_from,
                            },
                        )),
                    },
                    false,
                ),
                Err(error) => (envelope(error_to_wire(error)), false),
            }
        }
        Some(wire_envelope::Body::AppendStream(WireAppendStream {
            run_id,
            producer_id,
            producer_sequence,
            events,
            durability,
        })) => match context
            .router
            .append_stream_with_durability(
                session_id.clone(),
                run_id,
                producer_id,
                producer_sequence,
                request.epoch,
                decode_durability(durability),
                events
                    .into_iter()
                    .map(|event| PendingEvent {
                        kind: event.kind,
                        payload: event.payload,
                    })
                    .collect(),
            )
            .await
        {
            Ok(receipt) => (
                WireEnvelope {
                    request_id,
                    session_id,
                    epoch: receipt.epoch,
                    revision: request.revision,
                    body: Some(wire_envelope::Body::Ack(WireAck {
                        request: format!(
                            "stream:{}-{}",
                            receipt.first_sequence, receipt.last_sequence
                        ),
                    })),
                },
                false,
            ),
            Err(error) => (envelope(error_to_wire(error)), false),
        },
        Some(wire_envelope::Body::Snapshot(_)) => {
            match context.router.snapshot(session_id.clone()).await {
                Ok(snapshot) => (
                    WireEnvelope {
                        request_id,
                        session_id,
                        epoch: snapshot.epoch,
                        revision: snapshot.revision,
                        body: Some(wire_envelope::Body::SnapshotResponse(
                            WireSnapshotResponse {
                                epoch: snapshot.epoch,
                                revision: snapshot.revision,
                                active_run_id: snapshot.active_run_id,
                                cursor: snapshot.cursor,
                                retained_from: snapshot.retained_from,
                            },
                        )),
                    },
                    false,
                ),
                Err(error) => (envelope(error_to_wire(error)), false),
            }
        }
        Some(wire_envelope::Body::Replay(replay)) => {
            match context
                .router
                .replay(session_id.clone(), replay.after)
                .await
            {
                Ok(events) => (
                    envelope(wire_envelope::Body::EventBatch(WireEventBatch {
                        events: events
                            .into_iter()
                            .map(|event| WireStreamEvent {
                                sequence: event.sequence,
                                run_id: event.run_id,
                                kind: event.kind,
                                payload: event.payload,
                            })
                            .collect(),
                    })),
                    false,
                ),
                Err(error) => (envelope(error_to_wire(error)), false),
            }
        }
        Some(wire_envelope::Body::Subscribe(_)) => (
            envelope(wire_error(
                "SUBSCRIBE_REQUIRES_LIVE_PUMP",
                "subscribe is available in the actor API; transport live pump is the next step",
            )),
            false,
        ),
        Some(wire_envelope::Body::Hello(_))
        | Some(wire_envelope::Body::Ready(_))
        | Some(wire_envelope::Body::HealthResponse(_))
        | Some(wire_envelope::Body::Pong(_))
        | Some(wire_envelope::Body::Ack(_))
        | Some(wire_envelope::Body::Error(_))
        | Some(wire_envelope::Body::RunAdmission(_))
        | Some(wire_envelope::Body::SnapshotResponse(_))
        | Some(wire_envelope::Body::EventBatch(_))
        | None => (
            envelope(wire_error(
                "INVALID_COMMAND",
                "message body is not a client command",
            )),
            false,
        ),
    }
}

fn decode_durability(value: u32) -> Durability {
    match value {
        1 => Durability::GroupCommit,
        2 => Durability::Ephemeral,
        _ => Durability::Sync,
    }
}

fn error_to_wire(error: RuntimeError) -> wire_envelope::Body {
    let (code, message, expected, actual) = match error {
        RuntimeError::DiskFull => ("DISK_FULL", "storage disk full".into(), None, None),
        RuntimeError::DurabilityUnknown(message) => ("DURABILITY_UNKNOWN", message, None, None),
        RuntimeError::StorageUnavailable(message) => ("STORAGE_UNAVAILABLE", message, None, None),
        RuntimeError::Backpressure => (
            "BACKPRESSURE",
            "actor mailbox or subscriber is full".to_owned(),
            None,
            None,
        ),
        RuntimeError::SessionClosed => (
            "SESSION_CLOSED",
            "session actor is unavailable".to_owned(),
            None,
            None,
        ),
        RuntimeError::RequestConflict => (
            "REQUEST_CONFLICT",
            "request id was reused with different input".to_owned(),
            None,
            None,
        ),
        RuntimeError::StaleEpoch { expected, actual } => (
            "STALE_EPOCH",
            "session epoch is stale".to_owned(),
            Some(expected),
            Some(actual),
        ),
        RuntimeError::RevisionConflict { expected, actual } => (
            "REVISION_CONFLICT",
            "session revision is stale".to_owned(),
            Some(expected),
            Some(actual),
        ),
        RuntimeError::SessionBusy => (
            "SESSION_BUSY",
            "session already has an active run".to_owned(),
            None,
            None,
        ),
        RuntimeError::ProducerSequenceReplay { expected, actual } => (
            "PRODUCER_SEQUENCE_REPLAY",
            "producer sequence was already seen".to_owned(),
            Some(expected),
            Some(actual),
        ),
        RuntimeError::ProducerSequenceGap { expected, actual } => (
            "PRODUCER_SEQUENCE_GAP",
            "producer sequence has a gap".to_owned(),
            Some(expected),
            Some(actual),
        ),
        RuntimeError::CursorExpired {
            after,
            retained_from,
        } => (
            "CURSOR_EXPIRED",
            "replay cursor is older than retained events".to_owned(),
            Some(retained_from),
            Some(after),
        ),
        RuntimeError::InvalidCommand(message) => ("INVALID_COMMAND", message, None, None),
    };
    wire_envelope::Body::Error(WireError {
        code: code.to_owned(),
        message,
        expected,
        actual,
    })
}

fn wire_error(code: &str, message: &str) -> wire_envelope::Body {
    wire_envelope::Body::Error(WireError {
        code: code.to_owned(),
        message: message.to_owned(),
        expected: None,
        actual: None,
    })
}

fn wire_error_envelope(code: &str, message: &str) -> WireEnvelope {
    WireEnvelope {
        request_id: String::new(),
        session_id: String::new(),
        epoch: 0,
        revision: 0,
        body: Some(wire_error(code, message)),
    }
}

async fn send_json(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), TransportError> {
    let bytes = encode_server_message(message)
        .map_err(|error| TransportError::Protocol(error.to_string()))?;
    socket.send(Message::Binary(bytes.into())).await?;
    Ok(())
}

async fn send_wire(socket: &mut WebSocket, envelope: &WireEnvelope) -> Result<(), TransportError> {
    socket
        .send(Message::Binary(encode_wire(envelope).into()))
        .await?;
    Ok(())
}

fn authenticate_json(bytes: &[u8], context: &TransportContext) -> Result<bool, TransportError> {
    let message = decode_client_message(bytes)
        .map_err(|error| TransportError::Protocol(error.to_string()))?;
    Ok(matches!(message, ClientMessage::Hello { token } if token == context.token.as_ref()))
}

fn authenticate_wire(envelope: &WireEnvelope, context: &TransportContext) -> bool {
    matches!(
        &envelope.body,
        Some(wire_envelope::Body::Hello(hello)) if hello.token == context.token.as_ref()
    )
}

#[cfg(unix)]
pub async fn serve_unix(
    listener: tokio::net::UnixListener,
    context: TransportContext,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), TransportError> {
    loop {
        tokio::select! {
            _ = shutdown.changed() => return Ok(()),
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let child_context = context.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_unix(stream, child_context).await {
                        eprintln!("[runtime-sidecar] unix connection failed: {error}");
                    }
                });
            }
        }
    }
}

#[cfg(unix)]
async fn handle_unix(
    mut stream: tokio::net::UnixStream,
    context: TransportContext,
) -> Result<(), TransportError> {
    let request = read_frame(&mut stream).await?;
    if let Ok(envelope) = decode_wire(&request) {
        if !authenticate_wire(&envelope, &context) {
            write_frame(
                &mut stream,
                &encode_wire(&WireEnvelope {
                    request_id: envelope.request_id,
                    session_id: envelope.session_id,
                    epoch: 0,
                    revision: 0,
                    body: Some(wire_error("UNAUTHENTICATED", "hello authentication failed")),
                }),
            )
            .await?;
            return Ok(());
        }
        write_frame(&mut stream, &encode_wire(&context.wire_ready("unix"))).await?;
        loop {
            let request = match read_frame(&mut stream).await {
                Ok(request) => request,
                Err(TransportError::Io(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    return Ok(());
                }
                Err(error) => return Err(error),
            };
            let envelope = decode_wire(&request)
                .map_err(|error| TransportError::Protocol(error.to_string()))?;
            let (response, should_shutdown) = execute_wire(envelope, &context).await;
            write_frame(&mut stream, &encode_wire(&response)).await?;
            if should_shutdown {
                return Ok(());
            }
        }
    }

    if !authenticate_json(&request, &context)? {
        write_frame(
            &mut stream,
            &encode_server_message(&ServerMessage::Error {
                code: "UNAUTHENTICATED".to_owned(),
                message: "hello authentication failed".to_owned(),
            })
            .map_err(|error| TransportError::Protocol(error.to_string()))?,
        )
        .await?;
        return Ok(());
    }
    write_frame(
        &mut stream,
        &encode_server_message(&context.ready("unix"))
            .map_err(|error| TransportError::Protocol(error.to_string()))?,
    )
    .await?;
    loop {
        let request = match read_frame(&mut stream).await {
            Ok(request) => request,
            Err(TransportError::Io(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        let message = decode_client_message(&request)
            .map_err(|error| TransportError::Protocol(error.to_string()))?;
        let response = match message {
            ClientMessage::Health => ServerMessage::Health {
                ok: true,
                protocol: PROTOCOL_VERSION.to_owned(),
            },
            ClientMessage::Ping => ServerMessage::Pong,
            ClientMessage::Shutdown => {
                let _ = context.shutdown.send(true);
                ServerMessage::Ack {
                    request: "shutdown".to_owned(),
                }
            }
            ClientMessage::Hello { .. } => ServerMessage::Error {
                code: "ALREADY_AUTHENTICATED".to_owned(),
                message: "hello was already completed".to_owned(),
            },
        };
        let shutdown = matches!(response, ServerMessage::Ack { .. });
        write_frame(
            &mut stream,
            &encode_server_message(&response)
                .map_err(|error| TransportError::Protocol(error.to_string()))?,
        )
        .await?;
        if shutdown {
            return Ok(());
        }
    }
}

#[cfg(unix)]
async fn read_frame(stream: &mut tokio::net::UnixStream) -> Result<Vec<u8>, TransportError> {
    let size = stream.read_u32().await? as usize;
    if size == 0 || size > MAX_FRAME_BYTES {
        return Err(TransportError::Protocol("invalid frame size".to_owned()));
    }
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}

#[cfg(unix)]
async fn write_frame(
    stream: &mut tokio::net::UnixStream,
    bytes: &[u8],
) -> Result<(), TransportError> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err(TransportError::Protocol("invalid frame size".to_owned()));
    }
    stream.write_u32(bytes.len() as u32).await?;
    stream.write_all(bytes).await?;
    stream.flush().await?;
    Ok(())
}

#[cfg(unix)]
pub fn cleanup_socket(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(not(unix))]
pub fn cleanup_socket(_path: &Path) {}

pub fn socket_path_from_env() -> Option<PathBuf> {
    std::env::var_os("SYNAX_RUNTIME_SIDECAR_SOCKET").map(PathBuf::from)
}
