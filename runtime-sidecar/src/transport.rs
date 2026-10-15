use crate::protocol::{
    ClientMessage, PROTOCOL_VERSION, ServerMessage, decode_client_message, encode_server_message,
};
use futures_util::{SinkExt, StreamExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_tungstenite::{accept_async, tungstenite::Message};

const MAX_FRAME_BYTES: usize = 1024 * 1024;
const HANDSHAKE_CAPABILITIES: &[&str] = &["health", "shutdown"];

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
    let authenticated = match socket.next().await {
        Some(Ok(Message::Text(text))) => authenticate(text.as_bytes(), &context)?,
        Some(Ok(Message::Binary(bytes))) => authenticate(&bytes, &context)?,
        Some(Ok(Message::Ping(_))) => false,
        Some(Ok(other)) => {
            return Err(TransportError::Protocol(format!(
                "expected hello frame, got {other:?}"
            )));
        }
        Some(Err(error)) => return Err(error.into()),
        None => return Ok(()),
    };
    if !authenticated {
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
    while let Some(message) = socket.next().await {
        match message? {
            Message::Text(text) => {
                if handle_client_message(text.as_bytes(), &context, "websocket", &mut socket)
                    .await?
                {
                    return Ok(());
                }
            }
            Message::Binary(bytes) => {
                if handle_client_message(&bytes, &context, "websocket", &mut socket).await? {
                    return Ok(());
                }
            }
            Message::Ping(payload) => socket.send(Message::Pong(payload)).await?,
            Message::Close(_) => return Ok(()),
            Message::Pong(_) => {}
            Message::Frame(_) => {}
        }
    }
    Ok(())
}

async fn handle_client_message<S>(
    bytes: &[u8],
    context: &TransportContext,
    _transport: &str,
    socket: &mut S,
) -> Result<bool, TransportError>
where
    S: SinkExt<Message> + Unpin,
    S::Error: Into<tokio_tungstenite::tungstenite::Error>,
{
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

async fn send_json<S>(socket: &mut S, message: &ServerMessage) -> Result<(), TransportError>
where
    S: SinkExt<Message> + Unpin,
    S::Error: Into<tokio_tungstenite::tungstenite::Error>,
{
    let bytes = encode_server_message(message)
        .map_err(|error| TransportError::Protocol(error.to_string()))?;
    socket
        .send(Message::Binary(bytes.into()))
        .await
        .map_err(|error| TransportError::WebSocket(error.into()))
}

fn authenticate(bytes: &[u8], context: &TransportContext) -> Result<bool, TransportError> {
    let message = decode_client_message(bytes)
        .map_err(|error| TransportError::Protocol(error.to_string()))?;
    Ok(matches!(message, ClientMessage::Hello { token } if token == context.token.as_ref()))
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
    if !authenticate(&request, &context)? {
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
        let bytes = encode_server_message(&response)
            .map_err(|error| TransportError::Protocol(error.to_string()))?;
        write_frame(&mut stream, &bytes).await?;
        if matches!(response, ServerMessage::Ack { .. }) {
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
