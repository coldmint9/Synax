//! Diagnostic logs are separate from the durable session/event journal.
//! Formatting stays on the caller; bounded, lossy queues move I/O off Tokio.
mod local_file;
#[cfg(test)]
mod tests;
use std::{
    error::Error,
    io::Write,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Instant,
};
use tracing_appender::non_blocking::{ErrorCounter, NonBlockingBuilder, WorkerGuard};
use tracing_subscriber::{
    EnvFilter,
    fmt::writer::{BoxMakeWriter, MakeWriterExt},
};

const QUEUE_LINES: usize = 8192;

struct LocalTime;
impl tracing_subscriber::fmt::time::FormatTime for LocalTime {
    fn format_time(
        &self,
        writer: &mut tracing_subscriber::fmt::format::Writer<'_>,
    ) -> std::fmt::Result {
        write!(
            writer,
            "{}",
            chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, false)
        )
    }
}

pub struct LoggingGuard {
    // Guards outlive the runtime; dropping them drains the worker queues.
    _workers: Vec<WorkerGuard>,
    counters: Vec<(&'static str, ErrorCounter)>,
    last_dropped: Vec<usize>,
    failures: Vec<(&'static str, Arc<AtomicUsize>, usize)>,
    stderr_closed: Arc<AtomicBool>,
    stderr_closed_reported: bool,
}

impl LoggingGuard {
    pub fn report_dropped(&mut self) {
        if self.stderr_closed.load(Ordering::Relaxed) && !self.stderr_closed_reported {
            self.stderr_closed_reported = true;
            tracing::info!(
                event = "logging.stderr_closed",
                sink = "stderr",
                "Log reader disconnected; stderr disabled, file logging remains independent"
            );
        }
        for ((sink, counter), previous) in self.counters.iter().zip(&mut self.last_dropped) {
            let total = counter.dropped_lines();
            if total > *previous {
                tracing::warn!(
                    event = "logging.dropped",
                    sink,
                    dropped = total - *previous,
                    dropped_total = total,
                    "Diagnostic log queue overflowed"
                );
                *previous = total;
            }
        }
        for (sink, counter, previous) in &mut self.failures {
            let total = counter.load(Ordering::Relaxed);
            if total > *previous {
                tracing::error!(
                    event = "logging.write_failed",
                    sink = *sink,
                    failures = total - *previous,
                    failures_total = total,
                    "Diagnostic log sink write failed"
                );
                *previous = total;
            }
        }
    }
}

fn filter(rust_log: Option<&str>, log_level: Option<&str>) -> (EnvFilter, bool) {
    // Do not enable verbose dependency logs by default: SDK internals may log bodies.
    let level = match log_level.unwrap_or("info").to_ascii_lowercase().as_str() {
        "trace" => "trace",
        "debug" => "debug",
        "warn" => "warn",
        "error" | "fatal" => "error",
        "silent" | "off" => "off",
        _ => "info",
    };
    let fallback = format!("off,synax_runtime_sidecar={level}");
    match rust_log.filter(|value| !value.trim().is_empty()) {
        Some(value) => match EnvFilter::try_new(value) {
            Ok(filter) => (filter, false),
            Err(_) => (EnvFilter::new(fallback), true),
        },
        None => (EnvFilter::new(fallback), false),
    }
}

fn log_directory() -> Option<PathBuf> {
    std::env::var_os("SYNAX_RUNTIME_LOG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("DATA_ROOT").map(|root| PathBuf::from(root).join("logs")))
        .or_else(|| {
            std::env::var_os("SYNAX_RUNTIME_STORE_PATH").and_then(|root| {
                let root = PathBuf::from(root);
                root.parent()?.parent().map(|root| root.join("logs"))
            })
        })
}

pub fn init() -> Result<LoggingGuard, Box<dyn Error>> {
    let stderr_errors = Arc::new(AtomicUsize::new(0));
    let stderr_closed = Arc::new(AtomicBool::new(false));
    let (stderr, stderr_guard) = NonBlockingBuilder::default()
        .buffered_lines_limit(QUEUE_LINES)
        .lossy(true)
        .thread_name("runtime-log-stderr")
        .finish(CountingWriter(
            DisconnectAwareWriter {
                inner: std::io::stderr(),
                closed: stderr_closed.clone(),
            },
            stderr_errors.clone(),
        ));
    let mut failures = vec![("stderr", stderr_errors, 0)];
    let mut counters = vec![("stderr", stderr.error_counter())];
    let mut workers = vec![stderr_guard];
    let mut writer = BoxMakeWriter::new(stderr.clone());
    let mut file_error = false;
    if let Some(directory) = log_directory() {
        let appender = local_file::LocalDailyWriter::new(directory);
        match appender {
            Ok(appender) => {
                let errors = Arc::new(AtomicUsize::new(0));
                let (file, guard) = NonBlockingBuilder::default()
                    .buffered_lines_limit(QUEUE_LINES)
                    .lossy(true)
                    .thread_name("runtime-log-file")
                    .finish(CountingWriter(appender, errors.clone()));
                failures.push(("file", errors, 0));
                counters.push(("file", file.error_counter()));
                workers.push(guard);
                writer = BoxMakeWriter::new(file.and(stderr));
            }
            Err(_) => file_error = true,
        }
    }
    let (filter, invalid_filter) = filter(
        std::env::var("RUST_LOG").ok().as_deref(),
        std::env::var("LOG_LEVEL").ok().as_deref(),
    );
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .with_timer(LocalTime)
        .with_current_span(true)
        .with_span_list(true)
        .with_ansi(false)
        .with_writer(writer)
        .try_init()
        .map_err(|error| error as Box<dyn Error>)?;
    // Panic payloads can contain provider responses and credentials. Keep location only.
    std::panic::set_hook(Box::new(|info| {
        let location = info.location();
        tracing::error!(
            event = "runtime.panic",
            pid = std::process::id(),
            file = location.map(|l| l.file()),
            line = location.map(|l| l.line()),
            "Runtime thread panicked"
        );
    }));
    if invalid_filter {
        tracing::warn!(
            event = "logging.invalid_filter",
            "Invalid RUST_LOG; using LOG_LEVEL"
        );
    }
    if file_error {
        tracing::error!(
            event = "logging.file_unavailable",
            "Native log file unavailable; using stderr"
        );
    }
    Ok(LoggingGuard {
        last_dropped: vec![0; counters.len()],
        counters,
        _workers: workers,
        failures,
        stderr_closed,
        stderr_closed_reported: false,
    })
}

/// A parent can close its read end before the runtime finishes shutting down.
/// EPIPE is a detached optional sink, not a failed runtime or failed file sink.
struct DisconnectAwareWriter<W> {
    inner: W,
    closed: Arc<AtomicBool>,
}
fn disconnected(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::NotConnected
    )
}
impl<W: Write> Write for DisconnectAwareWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.closed.load(Ordering::Relaxed) {
            return Ok(bytes.len());
        }
        match self.inner.write(bytes) {
            Err(error) if disconnected(&error) => {
                self.closed.store(true, Ordering::Relaxed);
                Ok(bytes.len())
            }
            result => result,
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if self.closed.load(Ordering::Relaxed) {
            return Ok(());
        }
        match self.inner.flush() {
            Err(error) if disconnected(&error) => {
                self.closed.store(true, Ordering::Relaxed);
                Ok(())
            }
            result => result,
        }
    }
}

struct CountingWriter<W>(W, Arc<AtomicUsize>);
impl<W: Write> Write for CountingWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.write(bytes).inspect_err(|_| {
            self.1.fetch_add(1, Ordering::Relaxed);
        })
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush().inspect_err(|_| {
            self.1.fetch_add(1, Ordering::Relaxed);
        })
    }
}

/// Only classify errors. Display/Debug of upstream errors can include bodies,
/// headers, signed URLs, tool arguments, or user text.
pub fn error_kind(error: &(dyn Error + 'static)) -> &'static str {
    if let Some(error) = error.downcast_ref::<crate::transport::socket::TransportError>() {
        use crate::transport::socket::TransportError;
        return match error {
            TransportError::Protocol(_) => "protocol",
            TransportError::WebSocket(_) => "websocket",
            TransportError::Io(error) => error_kind(error),
        };
    }
    if let Some(error) = error.downcast_ref::<crate::storage::jsonl::error::JsonlError>() {
        use crate::storage::jsonl::error::JsonlError;
        return match error {
            JsonlError::DiskFull => "disk_full",
            JsonlError::Busy(_) => "storage_busy",
            JsonlError::Corrupt { .. } => "storage_corrupt",
            JsonlError::BadId(_) => "invalid_id",
            JsonlError::Serialization(_) => "serialization",
            JsonlError::Io(error) => error_kind(error),
            JsonlError::Runtime(error) => error_kind(error),
        };
    }
    if error.is::<crate::llm::deadline::IdleTimeout>() {
        return "idle_timeout";
    }
    if error.is::<crate::llm::retry::RetriesExhausted>() {
        return "retries_exhausted";
    }
    if error.is::<crate::llm::errors::InvalidToolArguments>() {
        return "invalid_tool_arguments";
    }
    if let Some(error) = error.downcast_ref::<reqwest::Error>() {
        return if error.is_timeout() {
            "timeout"
        } else if error.is_connect() {
            "connect"
        } else if error.is_decode() {
            "decode"
        } else {
            "http"
        };
    }
    if let Some(error) = error.downcast_ref::<std::io::Error>() {
        return match error.kind() {
            std::io::ErrorKind::StorageFull => "disk_full",
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            std::io::ErrorKind::UnexpectedEof => "unexpected_eof",
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe => {
                "connection_closed"
            }
            _ => "io",
        };
    }
    if error.is::<serde_json::Error>() {
        return "serialization";
    }
    if error.is::<rig_core::error::ProviderError>() {
        return "provider";
    }
    error.source().map(error_kind).unwrap_or("runtime")
}

/// Span entry is scoped to each poll; never hold an entered span across await/yield.
pub(crate) fn observe_stream(
    stream: futures_util::stream::BoxStream<'static, Result<serde_json::Value, crate::llm::Error>>,
    span: tracing::Span,
) -> futures_util::stream::BoxStream<'static, Result<serde_json::Value, crate::llm::Error>> {
    Box::pin(ObservedStream {
        stream,
        span,
        started: None,
        events: 0,
        finished: false,
    })
}

struct ObservedStream {
    stream: futures_util::stream::BoxStream<'static, Result<serde_json::Value, crate::llm::Error>>,
    span: tracing::Span,
    started: Option<Instant>,
    events: u64,
    finished: bool,
}

impl futures_util::Stream for ObservedStream {
    type Item = Result<serde_json::Value, crate::llm::Error>;
    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let _entered = this.span.enter();
        let started = *this.started.get_or_insert_with(|| {
            tracing::info!(target: "synax_runtime_sidecar::llm",event = "provider.started", "Provider operation started");
            Instant::now()
        });
        let result = this.stream.as_mut().poll_next(cx);
        if let std::task::Poll::Ready(item) = &result {
            match item {
                Some(Ok(event)) => {
                    this.events += 1;
                    if event["type"] == "usage" {
                        let usage = &event["usage"];
                        tracing::info!(target: "synax_runtime_sidecar::llm",
                            event = "provider.usage",
                            input_tokens = usage["inputTokens"].as_u64(),
                            output_tokens = usage["outputTokens"].as_u64(),
                            cached_input_tokens = usage["cachedInputTokens"].as_u64(),
                            reasoning_tokens = usage["reasoningTokens"].as_u64(),
                            "Provider usage received"
                        );
                    }
                }
                Some(Err(error)) => {
                    this.finished = true;
                    tracing::error!(target: "synax_runtime_sidecar::llm",
                        event = "provider.failed",
                        error_kind = error_kind(error.as_ref()),
                        status_code = crate::llm::retry::http_status(error.as_ref()),
                        duration_ms = started.elapsed().as_millis() as u64,
                        "Provider operation failed"
                    );
                }
                None if !this.finished => {
                    this.finished = true;
                    tracing::info!(target: "synax_runtime_sidecar::llm",
                        event = "provider.completed",
                        duration_ms = started.elapsed().as_millis() as u64,
                        event_count = this.events,
                        "Provider operation completed"
                    );
                }
                _ => {}
            }
        }
        result
    }
}

impl Drop for ObservedStream {
    fn drop(&mut self) {
        if let Some(started) = self.started.filter(|_| !self.finished) {
            let _entered = self.span.enter();
            tracing::info!(target: "synax_runtime_sidecar::llm",
                event = "provider.cancelled",
                duration_ms = started.elapsed().as_millis() as u64,
                event_count = self.events,
                "Provider stream dropped before completion"
            );
        }
    }
}
