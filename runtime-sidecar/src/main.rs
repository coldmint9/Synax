use std::sync::Arc;
use std::time::Duration;

use synax_runtime_sidecar::actor::SessionShardRouter;
use synax_runtime_sidecar::{control, jsonl, protocol, provider, tickets, transport, workspace_index};

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
    let provider_port = std::env::var("SYNAX_RUNTIME_PROVIDER_PORT").ok()
        .and_then(|value| value.parse::<u16>().ok()).unwrap_or(0);
    let provider_listener = TcpListener::bind(("127.0.0.1", provider_port)).await?;
    let provider_port = provider_listener.local_addr()?.port();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let store_root = std::env::var_os("SYNAX_RUNTIME_STORE_PATH")
        .map(std::path::PathBuf::from)
        .ok_or("SYNAX_RUNTIME_STORE_PATH is required")?;
    let store = Arc::new(jsonl::store::JsonlStore::open(&store_root)?);
    let hot = Arc::new(jsonl::hot::HotOps::new(store.clone()));
    let history = Arc::new(jsonl::history::HistoryOps::new(store));
    let router = SessionShardRouter::with_store(16, 1024, hot.clone())?;
    let context = TransportContext {
        workspace_index: workspace_index::WorkspaceIndex::new(),
        token: Arc::from(token),
        control_budget: Arc::new(control::ControlBudget::new()),
        tickets: Arc::new(tickets::TicketStore::new()),
        shutdown: shutdown_tx.clone(),
        router: Arc::new(router),
        hot_store: Some(hot.clone()),
        history: Some(history),
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
        "providerPort": provider_port,
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
    let provider_task = tokio::spawn(provider::serve_http(
        provider_listener,
        context.token.to_string(),
        shutdown_rx.clone(),
        Some(hot.clone()),
        context.router.clone(),
    ));


    #[cfg(unix)]
    let unix_task = unix_listener.map(|listener| {
        tokio::spawn(transport::serve_unix(
            listener,
            context.clone(),
            shutdown_rx.clone(),
        ))
    });

    #[cfg(windows)]
    let named_pipe_task = socket_path_from_env().map(|path| {
        tokio::spawn(transport::serve_named_pipe(
            path,
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
    context.workspace_index.stop();
    let _ = shutdown_tx.send(true);
    let _ = websocket_task.await;
    let _ = provider_task.await;
    let _ = tokio::task::spawn_blocking(move || hot.flush()).await;
    #[cfg(unix)]
    if let Some(task) = unix_task {
        let _ = task.await;
    }
    #[cfg(windows)]
    if let Some(task) = named_pipe_task {
        let _ = task.await;
    }
    #[cfg(unix)]
    if let Some(path) = socket_path_from_env() {
        cleanup_socket(&path);
    }
    Ok(())
}
