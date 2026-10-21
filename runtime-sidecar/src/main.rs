use std::sync::Arc;

use synax_runtime_sidecar::runtime::actor::SessionShardRouter;
use synax_runtime_sidecar::storage::jsonl;
use synax_runtime_sidecar::transport::{control, protocol, http, tickets, socket as transport};
use synax_runtime_sidecar::workspace::index as workspace_index;

use tokio::net::TcpListener;
use tokio::sync::watch;
use tracing::Instrument;
use synax_runtime_sidecar::logging;
use transport::{TransportContext, cleanup_socket, serve_websocket, socket_path_from_env};

#[cfg(unix)]
use tokio::net::UnixListener;

fn main() -> std::process::ExitCode {
    let mut logs = match logging::init() {
        Ok(logs) => logs,
        Err(_) => {
            eprintln!(r#"{{"level":"ERROR","fields":{{"event":"logging.init_failed","message":"Cannot initialize runtime logging"}}}}"#);
            return std::process::ExitCode::FAILURE;
        }
    };
    // Correlation spans remain enabled at warn/error-only event levels.
    let span = tracing::error_span!("runtime", pid = std::process::id(), version = env!("CARGO_PKG_VERSION"), stage = "initializing");
    let result = run_main(&mut logs, span.clone());
    if let Err(error) = &result {
        span.in_scope(|| tracing::error!(event = "runtime.failed", error_kind = logging::error_kind(error.as_ref()), "Runtime failed"));
    }
    logs.report_dropped();
    // Flush queued diagnostics before returning an exit code, including startup failures.
    drop(logs);
    if result.is_ok() { std::process::ExitCode::SUCCESS } else { std::process::ExitCode::FAILURE }
}

fn run_main(logs: &mut logging::LoggingGuard, span: tracing::Span) -> Result<(), Box<dyn std::error::Error>> {
    span.in_scope(|| tracing::info!(event = "runtime.starting", "Runtime starting"));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(run(logs).instrument(span));
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



async fn run(logs: &mut logging::LoggingGuard) -> Result<(), Box<dyn std::error::Error>> {
    tracing::Span::current().record("stage", "listeners");
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
    tracing::Span::current().record("stage", "storage");
    let store_root = std::env::var_os("SYNAX_RUNTIME_STORE_PATH")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| {
            tracing::error!(event = "runtime.config_invalid", variable = "SYNAX_RUNTIME_STORE_PATH", "Required runtime configuration is missing");
            "SYNAX_RUNTIME_STORE_PATH is required"
        })?;
    let store = Arc::new(jsonl::store::JsonlStore::open(&store_root)?);
    let hot = Arc::new(jsonl::hot::HotOps::new(store.clone()));
    let history = Arc::new(jsonl::history::HistoryOps::new(store));
    let history_for_sweep = history.clone();
    let hot_for_sweep = hot.clone();
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
        test_reset_gate: (std::env::var("SYNAX_RUNTIME_TEST_MODE").as_deref() == Ok("1"))
            .then(|| Arc::new(tokio::sync::RwLock::new(()))),
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
    tracing::Span::current().record("stage", "running");
    println!("SYNAX_RUNTIME_READY:{ready}");
    tracing::info!(event = "runtime.ready", websocket_port, provider_port,
        protocol = protocol::PROTOCOL_VERSION, "Runtime ready");

    let websocket_task = spawn_service("websocket", serve_websocket(
        websocket_listener,
        context.clone(),
        shutdown_rx.clone(),
    ));
    let provider_task = spawn_service("http", http::serve_http(
        provider_listener,
        context.token.to_string(),
        shutdown_rx.clone(),
        Some(hot.clone()),
        context.router.clone(),
    ));


    #[cfg(unix)]
    let unix_task = unix_listener.map(|listener| {
        spawn_service("unix", transport::serve_unix(
            listener,
            context.clone(),
            shutdown_rx.clone(),
        ))
    });

    #[cfg(windows)]
    let named_pipe_task = socket_path_from_env().map(|path| {
        spawn_service("named_pipe", transport::serve_named_pipe(
            path,
            context.clone(),
            shutdown_rx.clone(),
        ))
    });

    let mut shutdown_signal = shutdown_rx.clone();
    let mut health_tick = tokio::time::interval(std::time::Duration::from_secs(5));
    // Keep signal/watch futures alive across logging ticks.
    let ctrl_c = tokio::signal::ctrl_c();
    let terminate = terminate_signal();
    let parent = parent_closed();
    tokio::pin!(ctrl_c, terminate, parent);
    let reason = loop {
        tokio::select! {
            result = &mut ctrl_c => { result?; break "sigint"; },
            result = &mut terminate => { result?; break "sigterm"; },
            _ = &mut parent => break "parent_closed",
            result = shutdown_signal.changed() => { result?; break "control"; },
            _ = health_tick.tick() => {
                logs.report_dropped();
                let hot_evicted = hot_for_sweep.store().evict_idle();
                let history_evicted = history_for_sweep.evict_idle();
                if hot_evicted != 0 || history_evicted != 0 {
                    tracing::debug!(event = "storage.idle_evicted", hot = hot_evicted, history = history_evicted, "Released idle session caches");
                }
            },
        }
    };
    tracing::Span::current().record("stage", "shutdown");
    tracing::info!(event = "runtime.stopping", reason, "Runtime stopping");
    context.workspace_index.stop();
    let _ = shutdown_tx.send(true);
    log_task_result("websocket", websocket_task.await);
    log_task_result("http", provider_task.await);
    let flush_span = tracing::Span::current();
    log_task_result("storage_flush", tokio::task::spawn_blocking(move || flush_span.in_scope(|| hot.flush())).await);
    #[cfg(unix)]
    if let Some(task) = unix_task {
        log_task_result("unix", task.await);
    }
    #[cfg(windows)]
    if let Some(task) = named_pipe_task {
        log_task_result("named_pipe", task.await);
    }
    #[cfg(unix)]
    if let Some(path) = socket_path_from_env() {
        cleanup_socket(&path);
    }
    tracing::info!(event = "runtime.stopped", "Runtime stopped");
    Ok(())
}

fn log_task_result<E: std::error::Error + 'static>(task: &str, result: Result<Result<(), E>, tokio::task::JoinError>) {
    match result {
        Ok(Ok(())) => {},
        Ok(Err(error)) => tracing::error!(event = "runtime.task_failed", task, error_kind = logging::error_kind(&error), "Runtime task failed"),
        Err(error) => tracing::error!(event = "runtime.task_failed", task, panicked = error.is_panic(), "Runtime task did not complete"),
    }
}

fn spawn_service<E, F>(service: &'static str, future: F) -> tokio::task::JoinHandle<Result<(), E>>
where
    E: std::error::Error + Send + 'static,
    F: std::future::Future<Output = Result<(), E>> + Send + 'static,
{
    tokio::spawn(async move {
        let result = future.await;
        if let Err(error) = &result {
            tracing::error!(event = "runtime.service_failed", service, error_kind = logging::error_kind(error),
                "Runtime listener failed");
        }
        result
    }.in_current_span())
}
