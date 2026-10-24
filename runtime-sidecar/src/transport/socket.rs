use crate::runtime::actor::{Durability, PendingEvent, RuntimeError, SessionShardRouter};
use crate::transport::flow::CreditWindow;
use crate::transport::protocol::{
    ClientMessage, PROTOCOL_VERSION, ServerMessage, WireAck, WireAdmitRun, WireAppendStream,
    WireControlState, WireEnvelope, WireError, WireEventBatch, WireHealthResponse, WireHistoryState,
    WirePong, WireQueueState, WireReady, WireRunAdmission, WireSessionListResponse,
    WireSnapshotResponse, WireStreamEvent, WireTicket, WireUiSnapshotResponse, decode_client_message,
    decode_wire, encode_server_message, encode_wire, wire_envelope,
};
use crate::transport::tickets::{TicketStore, UiScope};
use futures_util::{SinkExt, StreamExt};
use prost::Message as ProstMessage;
use serde_json::Value;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, watch};
use tokio::time::timeout;
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use tracing::Instrument;

pub(crate) const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const HANDSHAKE_CAPABILITIES: &[&str] = &[
    "workspace_index",
    "health",
    "shutdown",
    "admit_run",
    "finish_run",
    "activate_run",
    "queue_mutation",
    "queue_read",
    "control_command",
    "control_state",
    "execution_lease",
    "history_command",
    "session_list",
    "import_projection",
    "append_stream",
    "append_receipts",
    "control_multiplex",
    "snapshot",
    "replay",
    "subscribe",
    "ui_ticket",
    "ui_projection",
    "credit_window",
    "history_outbox_maintenance",
    "provider_bridge",
    "agent_loop",
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
    pub workspace_index: Arc<crate::workspace::index::WorkspaceIndex>,
    pub token: Arc<str>,
    pub control_budget: Arc<crate::transport::control::ControlBudget>,
    pub tickets: Arc<TicketStore>,
    pub shutdown: watch::Sender<bool>,
    pub router: Arc<SessionShardRouter>,
    pub hot_store: Option<Arc<crate::storage::jsonl::hot::HotOps>>,
    pub history: Option<Arc<crate::storage::jsonl::history::HistoryOps>>,
    /// Test teardown deletes the store; production requests never use this gate.
    pub test_reset_gate: Option<Arc<tokio::sync::RwLock<()>>>,
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
                        tracing::warn!(event = "transport.failed", transport = "websocket",
                            error_kind = crate::logging::error_kind(&error), "WebSocket connection failed");
                    }
                }.instrument(tracing::error_span!("connection", transport = "websocket", connection_id = %uuid::Uuid::new_v4())));
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
                    body.capabilities = [
                        "health",
                        "snapshot",
                        "replay",
                        "subscribe",
                        "credit_window",
                        "ui_projection",
                        "queue_read",
                        "control_state",
                        "history_command",
                        "history_state",
                        "session_list",
                    ]
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
                    let _ = context.shutdown.send(true);
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
        Some(wire_envelope::Body::QueueRead(_))
        | Some(wire_envelope::Body::UiSnapshot(_))
        | Some(wire_envelope::Body::Snapshot(_))
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
                        ephemeral: event.ephemeral,
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
                if !event.ephemeral {
                    credits
                        .sent(event.sequence, encoded.len())
                        .map_err(|error| TransportError::Protocol(error.into()))?;
                }
                send_binary(&mut socket, encoded).await?;
                pending = backlog.pop_front();
                continue;
            }
            if event.ephemeral {
                // Ephemeral events have no replay cursor. Drop them when the durable
                // credit window is full instead of allowing them to block canonical data.
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
    let operation = wire_operation(request.body.as_ref());
    let span = tracing::error_span!("runtime_command", request_id = %request.request_id,
        session_id = %request.session_id, operation);
    async {
        let started = std::time::Instant::now();
        let reset = matches!(&request.body, Some(wire_envelope::Body::HistoryCommand(command)) if command.operation == "test_reset_runtime");
        let mut read_guard = None;
        let mut reset_guard = None;
        if let Some(gate) = &context.test_reset_gate {
            if reset { reset_guard = Some(gate.write().await); }
            else { read_guard = Some(gate.read().await); }
        }
        let result = execute_wire_inner(request, context, local_control).await;
        drop(read_guard);
        drop(reset_guard);
        if let Some(wire_envelope::Body::Error(error)) = &result.0.body {
            tracing::warn!(event = "runtime.command_failed", code = %error.code,
                duration_ms = started.elapsed().as_millis() as u64, "Runtime command failed");
        } else {
            tracing::debug!(event = "runtime.command_completed", duration_ms = started.elapsed().as_millis() as u64,
                "Runtime command completed");
        }
        result
    }.instrument(span).await
}

fn wire_operation(body: Option<&wire_envelope::Body>) -> &'static str {
    use wire_envelope::Body;
    match body {
        Some(Body::WorkspaceIndexCommand(_)) => "workspace_index",
        Some(Body::QueueRead(_)) => "queue_read",
        Some(Body::QueueMutation(_)) => "queue_mutation",
        Some(Body::ControlCommand(_)) => "control",
        Some(Body::HistoryCommand(_)) => "history",
        Some(Body::SessionList(_)) => "session_list",
        Some(Body::ImportProjection(_)) => "import_projection",
        Some(Body::ImportStream(_)) => "import_stream",
        Some(Body::ActivateRun(_)) => "activate_run",
        Some(Body::SeedUi(_)) => "seed_ui",
        Some(Body::UiSnapshot(_)) => "ui_snapshot",
        Some(Body::IssueTicket(_)) => "issue_ticket",
        Some(Body::FinishRun(_)) => "finish_run",
        Some(Body::Health(_)) => "health",
        Some(Body::Shutdown(_)) => "shutdown",
        Some(Body::Ping(_)) => "ping",
        Some(Body::AdmitRun(_)) => "admit_run",
        Some(Body::AppendStream(_)) => "append_stream",
        Some(Body::Snapshot(_)) => "snapshot",
        Some(Body::Replay(_)) => "replay",
        Some(Body::Subscribe(_)) => "subscribe",
        _ => "other",
    }
}

async fn execute_wire_inner(
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
        Some(wire_envelope::Body::WorkspaceIndexCommand(command)) => {
            if !local_control {
                return (
                    envelope(wire_error(
                        "FORBIDDEN",
                        "workspace indexing requires private control transport",
                    )),
                    false,
                );
            }
            match context
                .workspace_index
                .command(command.operation, command.payload)
                .await
            {
                Ok(state_json) => (
                    envelope(wire_envelope::Body::WorkspaceIndexState(
                        crate::transport::protocol::WireWorkspaceIndexState { state_json },
                    )),
                    false,
                ),
                Err(error) => (
                    envelope(wire_error(error.code(), &error.to_string())),
                    false,
                ),
            }
        }
        Some(wire_envelope::Body::WorkspaceIndexState(_)) => (
            envelope(wire_error(
                "INVALID_COMMAND",
                "workspace_index_state is a response-only message",
            )),
            false,
        ),
        Some(wire_envelope::Body::SeedUi(seed)) => {
            if !local_control {
                return (
                    envelope(wire_error(
                        "FORBIDDEN",
                        "UI initialization requires private control transport",
                    )),
                    false,
                );
            }
            match context
                .router
                .ui_snapshot(session_id.clone(), Some(seed.session_json))
                .await
            {
                Ok(snapshot_json) => (
                    envelope(wire_envelope::Body::UiSnapshotResponse(
                        WireUiSnapshotResponse { snapshot_json },
                    )),
                    false,
                ),
                Err(error) => (envelope(error_to_wire(error)), false),
            }
        }
        Some(wire_envelope::Body::UiSnapshot(_)) => {
            match context.router.ui_snapshot(session_id.clone(), None).await {
                Ok(snapshot_json) => (
                    envelope(wire_envelope::Body::UiSnapshotResponse(
                        WireUiSnapshotResponse { snapshot_json },
                    )),
                    false,
                ),
                Err(error) => (envelope(error_to_wire(error)), false),
            }
        }
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
        Some(wire_envelope::Body::Shutdown(_)) => (
            envelope(wire_envelope::Body::Ack(WireAck {
                request: "shutdown".to_owned(),
            })),
            true,
        ),
        Some(wire_envelope::Body::AdmitRun(WireAdmitRun {
            body_hash,
            run_id,
            queue_item_json,
            run_json,
        })) => match context
            .router
            .admit_run_with_document(
                session_id.clone(),
                request_id.clone(),
                body_hash,
                run_id,
                request.epoch,
                request.revision,
                queue_item_json,
                run_json,
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
        Some(wire_envelope::Body::ActivateRun(activate)) => {
            if !local_control {
                return (
                    envelope(wire_error(
                        "FORBIDDEN",
                        "activation requires private control transport",
                    )),
                    false,
                );
            }
            match context
                .router
                .activate_run(
                    session_id.clone(),
                    request_id.clone(),
                    activate.run_json,
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
        Some(wire_envelope::Body::QueueRead(_)) => {
            match context.router.queue_read(session_id.clone()).await {
                Ok(queue_json) => (
                    envelope(wire_envelope::Body::QueueState(WireQueueState {
                        queue_json,
                    })),
                    false,
                ),
                Err(error) => (envelope(error_to_wire(error)), false),
            }
        }
        Some(wire_envelope::Body::QueueMutation(queue)) => {
            if !local_control {
                return (
                    envelope(wire_error(
                        "FORBIDDEN",
                        "queue mutations require private control transport",
                    )),
                    false,
                );
            }
            match context
                .router
                .queue_mutation(
                    session_id.clone(),
                    request_id.clone(),
                    request.epoch,
                    request.revision,
                    queue.operation,
                    queue.payload,
                )
                .await
            {
                Ok(queue_json) => (
                    envelope(wire_envelope::Body::QueueState(WireQueueState {
                        queue_json,
                    })),
                    false,
                ),
                Err(error) => (envelope(error_to_wire(error)), false),
            }
        }
        Some(wire_envelope::Body::ControlCommand(command)) => {
            if !local_control {
                return (
                    envelope(wire_error(
                        "FORBIDDEN",
                        "runtime control commands require private control transport",
                    )),
                    false,
                );
            }
            match context
                .router
                .control_command(
                    session_id.clone(),
                    request_id.clone(),
                    request.epoch,
                    request.revision,
                    command.operation,
                    command.payload,
                )
                .await
            {
                Ok(receipt) => {
                    if let (Some(history), Some(event)) =
                        (context.history.clone(), receipt.event.as_ref())
                    {
                        if let Ok(payload) =
                            serde_json::from_slice::<serde_json::Value>(&event.payload)
                        {
                            let mut objects = Vec::new();
                            for (field, kind) in [
                                ("permission", "runtime.permission"),
                                ("interaction", "runtime.interaction"),
                            ] {
                                if let Some(value) = payload["chunk"][field].as_object() {
                                    if value
                                        .get("id")
                                        .and_then(serde_json::Value::as_str)
                                        .is_some()
                                    {
                                        objects.push(
                                            serde_json::json!({"kind": kind, "value": value}),
                                        );
                                    }
                                }
                            }
                            if !objects.is_empty() {
                                let body =
                                    serde_json::to_vec(&serde_json::json!({"objects": objects}))
                                        .unwrap_or_default();
                                if let Err(error) = history
                                    .command_async(
                                        session_id.clone(),
                                        format!("control-history:{request_id}"),
                                        "append_entities".to_owned(),
                                        body,
                                    )
                                    .await
                                {
                                    return (envelope(history_error_to_wire(error)), false);
                                }
                            }
                        }
                    }
                    (
                        WireEnvelope {
                            request_id,
                            session_id,
                            epoch: receipt.snapshot.epoch,
                            revision: receipt.snapshot.revision,
                            body: Some(wire_envelope::Body::ControlState(WireControlState {
                                state_json: receipt.state_json,
                            })),
                        },
                        false,
                    )
                }
                Err(error) => (envelope(error_to_wire(error)), false),
            }
        }
        Some(wire_envelope::Body::HistoryCommand(command)) => {
            if !local_control {
                return (
                    envelope(wire_error(
                        "FORBIDDEN",
                        "history commands require private control transport",
                    )),
                    false,
                );
            }
            if command.operation == "reconcile_stream" {
                if let (Some(_), Some(history)) =
                    (context.hot_store.as_ref(), context.history.clone())
                {
                    // Reconciliation fills gaps; it must never overwrite newer
                    // authoritative entities with old lifecycle events.
                    let mut latest = std::collections::BTreeMap::new();
                    let through = match context.router.snapshot(session_id.clone()).await {
                        Ok(state) => state.cursor,
                        Err(error) => return (envelope(error_to_wire(error)), false),
                    };
                    let mut after = 0;
                    while after < through {
                        let events = match context.router.replay(session_id.clone(), after).await {
                            Ok(events) => events,
                            Err(error) => return (envelope(error_to_wire(error)), false),
                        };
                        if events.is_empty() {
                            break;
                        }
                        for event in events
                            .into_iter()
                            .take_while(|event| event.sequence <= through)
                        {
                            after = event.sequence;
                            let Ok(payload) = serde_json::from_slice::<Value>(&event.payload)
                            else {
                                continue;
                            };
                            let chunk = &payload["chunk"];
                            if matches!(
                                chunk["type"].as_str(),
                                Some("history_restore_started" | "history_restored")
                            ) {
                                // History was reconciled before the restore fence.
                                // Earlier stream entities may now be intentionally
                                // absent, including while recovery finishes a restore.
                                latest.clear();
                                continue;
                            }
                            for (field, kind) in [
                                ("run", "runtime.run"),
                                ("step", "runtime.step"),
                                ("message", "runtime.message"),
                                ("toolCall", "runtime.tool_call"),
                                ("event", "runtime.event"),
                            ] {
                                if let Some(value) = chunk[field].as_object() {
                                    if let Some(id) = value.get("id").and_then(Value::as_str) {
                                        latest.insert(
                                            (kind, id.to_owned()),
                                            serde_json::json!({"kind":kind,"value":value}),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    let mut batches = Vec::new();
                    let mut batch = Vec::new();
                    let mut bytes = 32;
                    for object in latest.into_values() {
                        let size = serde_json::to_vec(&object).unwrap().len() + 1;
                        if !batch.is_empty() && (batch.len() == 256 || bytes + size > 768 * 1024) {
                            batches.push(std::mem::take(&mut batch));
                            bytes = 32;
                        }
                        bytes += size;
                        batch.push(object);
                    }
                    if !batch.is_empty() {
                        batches.push(batch);
                    }
                    for (index, objects) in batches.into_iter().enumerate() {
                        let body = serde_json::to_vec(
                            &serde_json::json!({"objects":objects,"ifAbsent":true}),
                        )
                        .unwrap();
                        if let Err(error) = history
                            .command_async(
                                session_id.clone(),
                                format!("reconcile-append:{request_id}:{index}"),
                                "append_entities".to_owned(),
                                body,
                            )
                            .await
                        {
                            return (envelope(history_error_to_wire(error)), false);
                        }
                    }
                }
                let state = serde_json::json!({"reconciled": 0});
                return (
                    WireEnvelope {
                        request_id,
                        session_id,
                        epoch: request.epoch,
                        revision: request.revision,
                        body: Some(wire_envelope::Body::HistoryState(WireHistoryState {
                            state_json: serde_json::to_vec(&state).unwrap_or_default(),
                        })),
                    },
                    false,
                );
            }
            if matches!(
                command.operation.as_str(),
                "history_outbox_status" | "maintain_history_outbox" | "ack_history_outbox"
            ) {
                let through = serde_json::from_slice::<Value>(&command.payload)
                    .ok()
                    .and_then(|value| value.get("through").and_then(Value::as_u64));
                let state = match command.operation.as_str() {
                    "history_outbox_status" => serde_json::json!({"pending": 0}),
                    "maintain_history_outbox" => {
                        serde_json::json!({"ackedThrough": Value::Null, "removed": 0, "hasMoreAcked": false})
                    }
                    "ack_history_outbox" => serde_json::json!({"ackedThrough": through}),
                    _ => serde_json::json!({"reconciled": 0}),
                };
                return (
                    WireEnvelope {
                        request_id,
                        session_id,
                        epoch: request.epoch,
                        revision: request.revision,
                        body: Some(wire_envelope::Body::HistoryState(WireHistoryState {
                            state_json: serde_json::to_vec(&state).unwrap_or_default(),
                        })),
                    },
                    false,
                );
            }
            if command.operation == "test_reset_runtime" {
                if std::env::var("SYNAX_RUNTIME_TEST_MODE") != Ok("1".to_owned()) {
                    return (
                        envelope(wire_error(
                            "FORBIDDEN",
                            "test reset is only available in test mode",
                        )),
                        false,
                    );
                }
                let Some(hot) = context.hot_store.clone() else {
                    return (
                        envelope(wire_error(
                            "STORAGE_UNAVAILABLE",
                            "runtime hot store is not configured",
                        )),
                        false,
                    );
                };
                hot.store().wait_for_index_scan().await;
                if let Some(history) = &context.history {
                    history.clear_cache_for_tests();
                }
                return match tokio::task::spawn_blocking(move || hot.reset_for_tests()).await {
                    Ok(Ok(())) => (
                        envelope(wire_envelope::Body::HistoryState(WireHistoryState {
                            state_json: serde_json::to_vec(&serde_json::json!({"ok": true}))
                                .unwrap_or_default(),
                        })),
                        false,
                    ),
                    Ok(Err(error)) => (envelope(storage_error_to_wire(error)), false),
                    Err(error) => (
                        envelope(wire_error("STORAGE_UNAVAILABLE", &error.to_string())),
                        false,
                    ),
                };
            }
            let Some(history) = context.history.clone() else {
                return (
                    envelope(wire_error(
                        "HISTORY_UNAVAILABLE",
                        "runtime history is not configured",
                    )),
                    false,
                );
            };
            let reply = history
                .command_async(
                    session_id.clone(),
                    request_id.clone(),
                    command.operation,
                    command.payload,
                )
                .await;
            return match reply {
                Ok(state_json) => (
                    WireEnvelope {
                        request_id,
                        session_id,
                        epoch: request.epoch,
                        revision: request.revision,
                        body: Some(wire_envelope::Body::HistoryState(WireHistoryState {
                            state_json,
                        })),
                    },
                    false,
                ),
                Err(error) => (envelope(history_error_to_wire(error)), false),
            };
        }
        Some(wire_envelope::Body::SessionList(request)) => {
            if !local_control {
                return (
                    envelope(wire_error(
                        "FORBIDDEN",
                        "session listing requires private control transport",
                    )),
                    false,
                );
            }
            let Some(store) = context.hot_store.as_ref() else {
                return (
                    envelope(wire_error(
                        "STORAGE_UNAVAILABLE",
                        "runtime hot store is not configured",
                    )),
                    false,
                );
            };
            if !request.id.is_empty() {
                let store = store.store().clone();
                return match tokio::task::spawn_blocking(move || store.session_summary(&request.id))
                    .await
                {
                    Ok(Ok(row)) => {
                        let sessions_json = serde_json::to_vec(&serde_json::json!({
                            "items": row.into_iter().collect::<Vec<_>>(), "single": true, "loading": false,
                        })).unwrap_or_default();
                        (
                            WireEnvelope {
                                request_id,
                                session_id,
                                epoch: 0,
                                revision: 0,
                                body: Some(wire_envelope::Body::SessionListResponse(
                                    WireSessionListResponse { sessions_json },
                                )),
                            },
                            false,
                        )
                    }
                    Ok(Err(error)) => (envelope(storage_error_to_wire(error)), false),
                    Err(error) => (
                        envelope(wire_error("STORAGE_UNAVAILABLE", &error.to_string())),
                        false,
                    ),
                };
            }
            let ready = match store.store().index_ready() {
                Ok(ready) => ready,
                Err(error) => return (envelope(wire_error("STORAGE_UNAVAILABLE", &error)), false),
            };
            let cursor = crate::storage::jsonl::store::ListIndex::decode_cursor(&request.after);
            // Do not expose a partial list as a completed empty result.
            let (items, next) = if ready {
                store.store().list().read().page(cursor.as_ref(), 64)
            } else {
                (Vec::new(), None)
            };
            let sessions_json = serde_json::to_vec(&serde_json::json!({
                "items": items,
                "next": next.map(|key| crate::storage::jsonl::store::ListIndex::encode_cursor(&key)),
                "loading": !ready,
            })).unwrap_or_default();
            (
                WireEnvelope {
                    request_id,
                    session_id,
                    epoch: 0,
                    revision: 0,
                    body: Some(wire_envelope::Body::SessionListResponse(
                        WireSessionListResponse { sessions_json },
                    )),
                },
                false,
            )
        }
        // Legacy migration commands. Sessions now seed through `seed_ui`, so
        // there is no separate import step; answer explicitly instead of
        // silently dropping the frame.
        Some(wire_envelope::Body::ImportProjection(_))
        | Some(wire_envelope::Body::ImportStream(_)) => (
            envelope(wire_error(
                "INVALID_COMMAND",
                "projection import is not supported; sessions seed through seed_ui",
            )),
            false,
        ),
        Some(wire_envelope::Body::FinishRun(finish)) => {
            match context
                .router
                .finish_run_with_document(
                    session_id.clone(),
                    request_id.clone(),
                    finish.run_id,
                    finish.status,
                    request.epoch,
                    request.revision,
                    finish.run_json,
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
        })) => {
            match context
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
            }
        }
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
                            ephemeral: event.ephemeral,
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
        | Some(wire_envelope::Body::QueueState(_))
        | Some(wire_envelope::Body::ControlState(_))
        | Some(wire_envelope::Body::HistoryState(_))
        | Some(wire_envelope::Body::SessionListResponse(_))
        | Some(wire_envelope::Body::ImportProjectionResponse(_))
        | Some(wire_envelope::Body::ImportStreamResponse(_))
        | Some(wire_envelope::Body::UiSnapshotResponse(_))
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

fn history_error_to_wire(
    error: crate::storage::jsonl::history::HistoryError,
) -> wire_envelope::Body {
    use crate::storage::jsonl::history::HistoryError;
    match error {
        HistoryError::ReadOnlyHistory => wire_error("READ_ONLY_HISTORY", &error.to_string()),
        HistoryError::StaleCursor => {
            wire_error("HISTORY_STALE", "Conversation changed. Refresh history.")
        }
        HistoryError::RevisionConflict { expected, actual } => {
            error_to_wire(RuntimeError::RevisionConflict { expected, actual })
        }
        HistoryError::RequestConflict => error_to_wire(RuntimeError::RequestConflict),
        HistoryError::FileBusy(message) => wire_error("FILE_WRITE_BUSY", &message),
        HistoryError::FileIo(error) => wire_error("FILE_IO_ERROR", &error.to_string()),
        HistoryError::InvalidCommand(message) => wire_error("INVALID_COMMAND", &message),
        HistoryError::ObjectMissing(message) => wire_error("HISTORY_NOT_FOUND", &message),
    }
}

fn storage_error_to_wire(error: crate::storage::jsonl::hot::StorageError) -> wire_envelope::Body {
    match error {
        crate::storage::jsonl::hot::StorageError::Runtime(error) => error_to_wire(error),
        crate::storage::jsonl::hot::StorageError::DiskFull => {
            wire_error("DISK_FULL", "storage disk full")
        }
        other => wire_error("STORAGE_UNAVAILABLE", &other.to_string()),
    }
}

fn error_to_wire(error: RuntimeError) -> wire_envelope::Body {
    let (code, message, expected, actual) = match error {
        RuntimeError::ProjectionMissing => (
            "PROJECTION_MISSING",
            "session UI projection requires initialization".into(),
            None,
            None,
        ),
        RuntimeError::ProjectionTooLarge => (
            "PROJECTION_TOO_LARGE",
            "session UI projection requires content externalization".into(),
            None,
            None,
        ),
        RuntimeError::ProjectionMigrationRequired => (
            "PROJECTION_MIGRATION_REQUIRED",
            "existing run or stream requires offline projection migration".into(),
            None,
            None,
        ),
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
        RuntimeError::ExecutionSuperseded(message) => ("EXECUTION_SUPERSEDED", message, None, None),
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
    let authenticated =
        matches!(message, ClientMessage::Hello { token } if token == context.token.as_ref());
    if !authenticated {
        tracing::warn!(
            event = "transport.auth_rejected",
            "Runtime authentication rejected"
        );
    }
    Ok(authenticated)
}

fn authenticate_wire(envelope: &WireEnvelope, context: &TransportContext) -> bool {
    let authenticated = matches!(
        &envelope.body,
        Some(wire_envelope::Body::Hello(hello)) if hello.token == context.token.as_ref()
    );
    if !authenticated {
        tracing::warn!(
            event = "transport.auth_rejected",
            "Runtime authentication rejected"
        );
    }
    authenticated
}

#[cfg(unix)]
pub async fn serve_unix(
    listener: tokio::net::UnixListener,
    context: TransportContext,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), TransportError> {
    let slots = Arc::new(Semaphore::new(64));
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = connections.join_next(), if !connections.is_empty() => {},
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let Ok(permit) = slots.clone().try_acquire_owned() else { continue; };
                let child_context = context.clone();
                connections.spawn(async move {
                    let _permit = permit;
                    if let Err(error) = handle_unix(stream, child_context).await {
                        tracing::warn!(event = "transport.failed", transport = "unix",
                            error_kind = crate::logging::error_kind(&error), "Local socket connection failed");
                    }
                }.instrument(tracing::error_span!("connection", transport = "unix", connection_id = %uuid::Uuid::new_v4())));
            }
        }
    }
    if timeout(Duration::from_secs(3), async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.abort_all();
    }
    Ok(())
}

#[cfg(unix)]
async fn handle_unix(
    stream: tokio::net::UnixStream,
    context: TransportContext,
) -> Result<(), TransportError> {
    handle_control_stream(stream, context).await
}

async fn handle_control_stream<S>(
    mut stream: S,
    context: TransportContext,
) -> Result<(), TransportError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let request = timeout(Duration::from_secs(5), read_frame(&mut stream))
        .await
        .map_err(|_| TransportError::Protocol("control hello timed out".into()))??;
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
        let shutdown = context.shutdown.clone();
        let budget = context.control_budget.clone();
        return crate::transport::control::run(stream, shutdown, budget, move |envelope| {
            let context = context.clone();
            async move { execute_wire(envelope, &context, true).await }
        })
        .await;
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

#[cfg(windows)]
pub async fn serve_named_pipe(
    path: PathBuf,
    context: TransportContext,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(), TransportError> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let slots = Arc::new(Semaphore::new(64));
    let mut connections = tokio::task::JoinSet::new();
    loop {
        let server = ServerOptions::new().create(&path)?;
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = connections.join_next(), if !connections.is_empty() => {},
            connected = server.connect() => {
                connected?;
                let Ok(permit) = slots.clone().try_acquire_owned() else { continue; };
                let child_context = context.clone();
                connections.spawn(async move {
                    let _permit = permit;
                    if let Err(error) = handle_control_stream(server, child_context).await {
                        tracing::warn!(event = "transport.failed", transport = "named_pipe",
                            error_kind = crate::logging::error_kind(&error), "Named pipe connection failed");
                    }
                }.instrument(tracing::error_span!("connection", transport = "named_pipe", connection_id = %uuid::Uuid::new_v4())));
            }
        }
    }
    if timeout(Duration::from_secs(3), async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.abort_all();
    }
    Ok(())
}

pub(crate) async fn read_frame<R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<Vec<u8>, TransportError> {
    let size = stream.read_u32().await? as usize;
    if size == 0 || size > MAX_FRAME_BYTES {
        return Err(TransportError::Protocol("invalid frame size".to_owned()));
    }
    let mut bytes = vec![0; size];
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}

pub(crate) async fn write_frame<W: AsyncWrite + Unpin>(
    stream: &mut W,
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
