use crate::actor::{Durability, PendingEvent, RuntimeError, SessionShardRouter};
use crate::flow::CreditWindow;
use crate::protocol::{
    ClientMessage, PROTOCOL_VERSION, ServerMessage, WireAck, WireAdmitRun, WireAppendStream,
    WireEnvelope, WireError, WireEventBatch, WireHealthResponse, WirePong, WireReady,
    WireRunAdmission, WireSnapshotResponse, WireStreamEvent, WireTicket, decode_client_message,
    decode_wire, encode_server_message, encode_wire, wire_envelope,
};
use crate::tickets::{TicketStore, UiScope};
use futures_util::{SinkExt, StreamExt};
use prost::Message as ProstMessage;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, watch};
use tokio::time::timeout;
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const HANDSHAKE_CAPABILITIES: &[&str] = &[
    "health",
    "shutdown",
    "admit_run",
    "finish_run",
    "append_stream",
    "snapshot",
    "replay",
    "subscribe",
    "ui_ticket",
    "credit_window",
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
    pub tickets: Arc<TicketStore>,
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
    let slots = Arc::new(Semaphore::new(256));
    loop {
        tokio::select! {
            _ = shutdown.changed() => return Ok(()),
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let Ok(permit) = slots.clone().try_acquire_owned() else { continue; };
                let child_context = context.clone();
                tokio::spawn(async move {
                    let _permit = permit;
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
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME_BYTES))
        .max_frame_size(Some(MAX_FRAME_BYTES));
    let mut socket = timeout(
        Duration::from_secs(5),
        accept_hdr_async_with_config(
            stream,
            |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                if request.uri().path() != "/runtime" {
                    return Err(tokio_tungstenite::tungstenite::http::Response::builder()
                        .status(404)
                        .body(Some("not found".into()))
                        .unwrap());
                }
                Ok(response)
            },
            Some(config),
        ),
    )
    .await
    .map_err(|_| TransportError::Protocol("websocket upgrade timed out".into()))??;
    let first = match timeout(Duration::from_secs(5), socket.next())
        .await
        .map_err(|_| TransportError::Protocol("hello timed out".into()))?
    {
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
            let scope = if authenticate_wire(&hello, &context) {
                None
            } else {
                let ticket = match &hello.body {
                    Some(wire_envelope::Body::Hello(hello)) => {
                        context
                            .tickets
                            .consume(&hello.token, &hello.client_id)
                            .await
                    }
                    _ => None,
                };
                match ticket {
                    Some(scope) => Some(scope),
                    None => {
                        send_wire(
                            &mut socket,
                            &wire_error_envelope("UNAUTHENTICATED", "hello authentication failed"),
                        )
                        .await?;
                        let _ = socket.close(None).await;
                        return Ok(());
                    }
                }
            };
            let mut ready = context.wire_ready("websocket");
            if scope.is_some() {
                if let Some(wire_envelope::Body::Ready(ref mut body)) = ready.body {
                    body.capabilities =
                        ["health", "snapshot", "replay", "subscribe", "credit_window"]
                            .iter()
                            .map(|value| (*value).into())
                            .collect();
                }
            }
            send_wire(&mut socket, &ready).await?;
            handle_wire_websocket(socket, context, scope).await
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
    scope: Option<UiScope>,
) -> Result<(), TransportError> {
    while let Some(message) = socket.next().await {
        match message? {
            Message::Binary(bytes) => {
                let request = decode_wire(&bytes)
                    .map_err(|error| TransportError::Protocol(error.to_string()))?;
                if scope
                    .as_ref()
                    .is_some_and(|scope| !ui_command_allowed(&request, scope))
                {
                    let mut error = wire_error_envelope(
                        "FORBIDDEN",
                        "ticket does not authorize this operation or session",
                    );
                    error.request_id = request.request_id;
                    send_wire(&mut socket, &error).await?;
                    continue;
                }
                if matches!(request.body, Some(wire_envelope::Body::Subscribe(_))) {
                    return handle_wire_subscription(socket, context, request).await;
                }
                let (response, should_shutdown) = execute_wire(request, &context, false).await;
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

fn ui_command_allowed(request: &WireEnvelope, scope: &UiScope) -> bool {
    match request.body {
        Some(wire_envelope::Body::Health(_)) | Some(wire_envelope::Body::Ping(_)) => true,
        Some(wire_envelope::Body::Snapshot(_))
        | Some(wire_envelope::Body::Replay(_))
        | Some(wire_envelope::Body::Subscribe(_)) => request.session_id == scope.session_id,
        _ => false,
    }
}

async fn close_websocket(socket: &mut WebSocket, reason: &'static str) {
    use tokio_tungstenite::tungstenite::protocol::{CloseFrame, frame::coding::CloseCode};
    // Drain the peer's outstanding ACKs and close reply. Dropping a socket with unread
    // data can cause a TCP reset that discards the final RESYNC_REQUIRED frame.
    let _ = timeout(Duration::from_secs(1), async {
        socket
            .close(Some(CloseFrame {
                code: CloseCode::Policy,
                reason: reason.into(),
            }))
            .await?;
        while let Some(message) = socket.next().await {
            if matches!(message?, Message::Close(_)) {
                break;
            }
        }
        Ok::<(), tokio_tungstenite::tungstenite::Error>(())
    })
    .await;
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
    let (snapshot, backlog, mut receiver) =
        match context.router.subscribe(session_id.clone(), after).await {
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
                close_websocket(&mut socket, "RESYNC_REQUIRED").await;
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

    let mut backlog: VecDeque<_> = backlog.into_iter().map(Arc::new).collect();
    let mut pending = backlog.pop_front();
    let mut credits = CreditWindow::new(after, 64, 2 * 1024 * 1024);
    let mut shutdown = context.shutdown.subscribe();
    loop {
        if let Some(event) = pending.as_ref() {
            let envelope = WireEnvelope {
                request_id: request_id.clone(),
                session_id: session_id.clone(),
                epoch: snapshot.epoch,
                revision: snapshot.revision,
                body: Some(wire_envelope::Body::EventBatch(WireEventBatch {
                    events: vec![WireStreamEvent {
                        sequence: event.sequence,
                        run_id: event.run_id.clone(),
                        kind: event.kind.clone(),
                        payload: event.payload.clone(),
                    }],
                })),
            };
            let encoded = encode_wire(&envelope);
            if encoded.len() > MAX_FRAME_BYTES {
                send_wire(
                    &mut socket,
                    &wire_error_envelope("RESYNC_REQUIRED", "event exceeds transport limit"),
                )
                .await?;
                close_websocket(&mut socket, "RESYNC_REQUIRED").await;
                return Ok(());
            }
            if credits.available(encoded.len()) {
                credits
                    .sent(event.sequence, encoded.len())
                    .map_err(|error| TransportError::Protocol(error.into()))?;
                send_binary(&mut socket, encoded).await?;
                pending = backlog.pop_front();
                continue;
            }
        }
        tokio::select! {
            _ = shutdown.changed() => return Ok(()),
            message = timeout(Duration::from_secs(45), socket.next()) => {
                match message.map_err(|_| TransportError::Protocol("subscriber heartbeat timed out".into()))? {
                    None | Some(Ok(Message::Close(_))) => return Ok(()),
                    Some(Ok(Message::Ping(payload))) => socket.send(Message::Pong(payload)).await?,
                    Some(Ok(Message::Binary(bytes))) => {
                        let request = decode_wire(&bytes).map_err(|error| TransportError::Protocol(error.to_string()))?;
                        match request.body {
                            Some(wire_envelope::Body::Credit(credit)) if request.session_id == session_id && request.request_id == request_id => {
                                if let Err(error) = credits.ack(credit.through_sequence) {
                                    send_wire(&mut socket, &wire_error_envelope("INVALID_CREDIT", error)).await?;
                                    close_websocket(&mut socket, "INVALID_CREDIT").await;
                                    return Ok(());
                                }
                            }
                            Some(wire_envelope::Body::Ping(_)) => send_wire(&mut socket, &WireEnvelope {
                                request_id: request.request_id, body: Some(wire_envelope::Body::Pong(WirePong {})), ..Default::default()
                            }).await?,
                            _ => send_wire(&mut socket, &wire_error_envelope("SUBSCRIPTION_READ_ONLY", "only credit, ping and close are accepted")).await?,
                        }
                    }
                    Some(Ok(Message::Text(_))) => send_wire(&mut socket, &wire_error_envelope("BINARY_REQUIRED", "protobuf required")).await?,
                    Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {},
                    Some(Err(error)) => return Err(error.into()),
                }
            }
            event = receiver.recv(), if pending.is_none() => {
                match event {
                    Some(event) => pending = Some(event),
                    None => {
                        send_wire(&mut socket, &wire_error_envelope("RESYNC_REQUIRED", "live mailbox overflowed or actor stopped")).await?;
                        close_websocket(&mut socket, "RESYNC_REQUIRED").await;
                        return Ok(());
                    }
                }
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

async fn execute_wire(
    request: WireEnvelope,
    context: &TransportContext,
    local_control: bool,
) -> (WireEnvelope, bool) {
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
        Some(wire_envelope::Body::IssueTicket(issue)) => {
            if !local_control {
                return (
                    envelope(wire_error(
                        "FORBIDDEN",
                        "tickets are issued only over the private control socket",
                    )),
                    false,
                );
            }
            match context
                .tickets
                .issue(UiScope {
                    session_id: session_id.clone(),
                    client_id: issue.client_id,
                })
                .await
            {
                Ok((token, expires_at_ms)) => (
                    envelope(wire_envelope::Body::Ticket(WireTicket {
                        token,
                        expires_at_ms,
                    })),
                    false,
                ),
                Err(message) => (envelope(wire_error("TICKET_UNAVAILABLE", message)), false),
            }
        }
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
                Ok(events) => {
                    // Bound the serialized response as well as its event count. Callers advance
                    // from the last returned sequence; one large batch cannot break IPC framing.
                    let mut page = Vec::new();
                    let empty = envelope(wire_envelope::Body::EventBatch(WireEventBatch {
                        events: vec![],
                    }));
                    let mut remaining = MAX_FRAME_BYTES.saturating_sub(empty.encoded_len() + 16);
                    for event in events.into_iter().take(256) {
                        let wire = WireStreamEvent {
                            sequence: event.sequence,
                            run_id: event.run_id,
                            kind: event.kind,
                            payload: event.payload,
                        };
                        let cost = wire.encoded_len() + 11;
                        if cost > remaining {
                            if page.is_empty() {
                                return (
                                    envelope(wire_error(
                                        "EVENT_TOO_LARGE",
                                        "event exceeds replay frame budget",
                                    )),
                                    false,
                                );
                            }
                            break;
                        }
                        remaining -= cost;
                        page.push(wire);
                    }
                    (
                        envelope(wire_envelope::Body::EventBatch(WireEventBatch {
                            events: page,
                        })),
                        false,
                    )
                }
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
        | Some(wire_envelope::Body::Ticket(_))
        | Some(wire_envelope::Body::Credit(_))
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

async fn send_binary(socket: &mut WebSocket, bytes: Vec<u8>) -> Result<(), TransportError> {
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(TransportError::Protocol(
            "response exceeds frame limit".into(),
        ));
    }
    timeout(
        Duration::from_secs(5),
        socket.send(Message::Binary(bytes.into())),
    )
    .await
    .map_err(|_| TransportError::Protocol("websocket write timed out".into()))??;
    Ok(())
}
async fn send_json(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), TransportError> {
    let bytes = encode_server_message(message)
        .map_err(|error| TransportError::Protocol(error.to_string()))?;
    send_binary(socket, bytes).await
}
async fn send_wire(socket: &mut WebSocket, envelope: &WireEnvelope) -> Result<(), TransportError> {
    send_binary(socket, encode_wire(envelope)).await
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
            let (response, should_shutdown) = execute_wire(envelope, &context, true).await;
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
