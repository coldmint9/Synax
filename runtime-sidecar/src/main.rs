mod actor;
mod commit;
mod completion;
mod control;
mod flow;
mod history;
mod input_queue;
mod projection;
mod protocol;
mod storage;
mod tickets;
mod transport;

use std::sync::Arc;

use crate::actor::SessionShardRouter;
use crate::storage::HotStore;
use tokio::net::TcpListener;
use tokio::sync::watch;
use transport::{TransportContext, cleanup_socket, serve_websocket, socket_path_from_env};

#[cfg(unix)]
use tokio::net::UnixListener;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(run());
    // A managed stdin watch uses a blocking OS read. Never let it keep a stopped
    // runtime alive after an administrative shutdown while the parent is alive.
    runtime.shutdown_timeout(std::time::Duration::from_secs(1));
    result
}

async fn parent_closed() {
    if std::env::var("SYNAX_RUNTIME_PARENT_WATCH") != Ok("1".into()) {
        return std::future::pending().await;
    }
    use tokio::io::AsyncReadExt;
    let mut stdin = tokio::io::stdin();
    let mut byte = [0u8; 1];
    while matches!(stdin.read(&mut byte).await, Ok(1)) {}
}

async fn terminate_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?
            .recv()
            .await;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::future::pending().await
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let token = std::env::var("SYNAX_RUNTIME_SIDECAR_TOKEN")
        .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
    let port = std::env::var("SYNAX_RUNTIME_SIDECAR_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    let websocket_listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let websocket_port = websocket_listener.local_addr()?.port();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let hot_store = std::env::var_os("SYNAX_RUNTIME_HOT_PATH")
        .map(HotStore::open)
        .transpose()?;
    let history_store = std::env::var_os("SYNAX_RUNTIME_HISTORY_PATH")
        .map(history::HistoryStore::open)
        .transpose()?;
    let router = match hot_store {
        Some(store) => SessionShardRouter::with_store(16, 1024, Arc::new(store))?,
        None => SessionShardRouter::new(16, 1024)?,
    };
    let context = TransportContext {
        token: Arc::from(token),
        control_budget: Arc::new(control::ControlBudget::new()),
        tickets: Arc::new(tickets::TicketStore::new()),
        shutdown: shutdown_tx.clone(),
        router: Arc::new(router),
        history: history_store.map(Arc::new),
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
        "capabilities": transport::HANDSHAKE_CAPABILITIES,
        "pid": std::process::id(),
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
        result = terminate_signal() => result?,
        _ = parent_closed() => {},
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
