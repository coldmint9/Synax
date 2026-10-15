mod actor;
mod protocol;
mod transport;

use std::sync::Arc;

use crate::actor::SessionShardRouter;
use tokio::net::TcpListener;
use tokio::sync::watch;
use transport::{TransportContext, cleanup_socket, serve_websocket, socket_path_from_env};

#[cfg(unix)]
use tokio::net::UnixListener;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token = std::env::var("SYNAX_RUNTIME_SIDECAR_TOKEN")
        .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
    let port = std::env::var("SYNAX_RUNTIME_SIDECAR_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    let websocket_listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let websocket_port = websocket_listener.local_addr()?.port();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let context = TransportContext {
        token: Arc::from(token),
        shutdown: shutdown_tx.clone(),
        router: Arc::new(SessionShardRouter::new(16, 1024)?),
    };

    #[cfg(unix)]
    let unix_path = socket_path_from_env();
    #[cfg(unix)]
    let unix_listener = if let Some(path) = &unix_path {
        cleanup_socket(path);
        Some(UnixListener::bind(path)?)
    } else {
        None
    };

    let ready = serde_json::json!({
        "type": "runtime_ready",
        "protocol": protocol::PROTOCOL_VERSION,
        "port": websocket_port,
        "socket": socket_path_from_env().map(|path| path.display().to_string()),
        "capabilities": ["health", "shutdown"],
    });
    println!("SYNAX_RUNTIME_READY:{ready}");

    let websocket_task = tokio::spawn(serve_websocket(
        websocket_listener,
        context.clone(),
        shutdown_rx.clone(),
    ));

    #[cfg(unix)]
    let unix_task = unix_listener.map(|listener| {
        tokio::spawn(transport::serve_unix(
            listener,
            context.clone(),
            shutdown_rx.clone(),
        ))
    });

    let mut shutdown_signal = shutdown_rx.clone();
    tokio::select! {
        result = tokio::signal::ctrl_c() => result?,
        result = shutdown_signal.changed() => result?,
    }
    let _ = shutdown_tx.send(true);
    let _ = websocket_task.await;
    #[cfg(unix)]
    if let Some(task) = unix_task {
        let _ = task.await;
    }
    #[cfg(unix)]
    if let Some(path) = socket_path_from_env() {
        cleanup_socket(&path);
    }
    Ok(())
}
