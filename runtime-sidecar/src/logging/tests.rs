use super::*;
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::sync::Mutex;
use tracing::Instrument;

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);
impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn capture() -> (Capture, tracing::Dispatch) {
    let output = Capture::default();
    let writer = output.clone();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_ansi(false)
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || writer.clone())
        .finish();
    (output, tracing::Dispatch::new(subscriber))
}
fn rows(output: &Capture) -> Vec<Value> {
    String::from_utf8(output.0.lock().unwrap().clone())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn native_filter_defaults_are_scoped_and_invalid_directives_fall_back() {
    for (env, level) in [
        (None, "info"),
        (Some("debug"), "debug"),
        (Some("fatal"), "error"),
        (Some("silent"), "off"),
    ] {
        let (filter, invalid) = filter(None, env);
        assert!(!invalid);
        assert!(
            filter
                .to_string()
                .contains(&format!("synax_runtime_sidecar={level}"))
        );
    }
    assert!(filter(Some("[broken"), None).1);
    let (filter, invalid) = filter(Some("off,synax_runtime_sidecar::llm=trace"), None);
    assert!(!invalid);
    assert!(
        filter
            .to_string()
            .contains("synax_runtime_sidecar::llm=trace")
    );
}

#[tokio::test]
async fn provider_logs_correlate_without_payloads_or_upstream_error_text() {
    let (output, dispatch) = capture();
    let _subscriber = tracing::dispatcher::set_default(&dispatch);
    let root = tracing::info_span!(
        "agent_loop",
        session_id = "s1",
        run_id = "r1",
        loop_id = "l1"
    );
    async {
        let span = tracing::info_span!("provider", provider_request_id = "p1");
        let upstream: crate::llm::Error = rig_core::error::ProviderError::from_http_response(
            http::StatusCode::UNAUTHORIZED,
            "secret-upstream-body",
        )
        .into();
        let input = futures_util::stream::iter(vec![
            Ok(json!({"type":"text-delta", "delta":"secret-user-output"})),
            Err(upstream),
        ]);
        let mut stream = observe_stream(Box::pin(input), span);
        while stream.next().await.is_some() {}
    }
    .instrument(root)
    .await;
    let rows = rows(&output);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["fields"]["event"], "provider.started");
    assert_eq!(rows[1]["level"], "ERROR");
    assert_eq!(rows[1]["fields"]["status_code"], 401);
    assert_eq!(rows[1]["spans"][0]["session_id"], "s1");
    assert_eq!(rows[1]["spans"][1]["provider_request_id"], "p1");
    assert!(!serde_json::to_string(&rows).unwrap().contains("secret-"));
}

#[tokio::test]
async fn completed_and_cancelled_streams_have_distinct_terminal_events() {
    let (output, dispatch) = capture();
    let _subscriber = tracing::dispatcher::set_default(&dispatch);
    let mut stream = observe_stream(
        Box::pin(futures_util::stream::empty()),
        tracing::info_span!("provider"),
    );
    assert!(stream.next().await.is_none());
    drop(stream);
    let mut stream = observe_stream(
        Box::pin(futures_util::stream::pending()),
        tracing::info_span!("provider"),
    );
    assert!(futures_util::poll!(stream.next()).is_pending());
    drop(stream);
    let events: Vec<_> = rows(&output)
        .iter()
        .map(|row| row["fields"]["event"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        events,
        [
            "provider.started",
            "provider.completed",
            "provider.started",
            "provider.cancelled"
        ]
    );
}

#[test]
fn nonblocking_queue_is_bounded_and_drains_on_shutdown() {
    // Gate the writer so queue saturation is deterministic, independent of disk speed.
    struct Gated {
        capture: Capture,
        gate: Arc<(Mutex<bool>, std::sync::Condvar)>,
    }
    impl Write for Gated {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let (lock, ready) = &*self.gate;
            let _guard = ready
                .wait_while(lock.lock().unwrap(), |released| !*released)
                .unwrap();
            self.capture.write(bytes)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let capture = Capture::default();
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let (mut writer, guard) = NonBlockingBuilder::default()
        .buffered_lines_limit(2)
        .lossy(true)
        .finish(Gated {
            capture: capture.clone(),
            gate: gate.clone(),
        });
    let counter = writer.error_counter();
    for _ in 0..100 {
        writer.write_all(b"event\n").unwrap();
    }
    assert!(counter.dropped_lines() >= 97);
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
    drop(guard);
    let written = capture
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|byte| **byte == b'\n')
        .count();
    assert_eq!(written + counter.dropped_lines(), 100);
}

#[test]
fn sink_errors_are_counted_without_recursive_logging() {
    struct Failed;
    impl Write for Failed {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::StorageFull.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::ErrorKind::StorageFull.into())
        }
    }
    let errors = Arc::new(AtomicUsize::new(0));
    let mut writer = CountingWriter(Failed, errors.clone());
    assert!(writer.write_all(b"test").is_err());
    assert!(writer.flush().is_err());
    assert_eq!(errors.load(Ordering::Relaxed), 2);
    assert_eq!(
        error_kind(&crate::storage::jsonl::JsonlError::DiskFull),
        "disk_full"
    );
}

#[test]
fn optional_stderr_disconnects_once_but_unexpected_errors_remain_visible() {
    struct Broken(Arc<AtomicUsize>, std::io::ErrorKind);
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Err(self.1.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(self.1.into())
        }
    }
    for kind in [
        std::io::ErrorKind::BrokenPipe,
        std::io::ErrorKind::ConnectionReset,
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicBool::new(false));
        let errors = Arc::new(AtomicUsize::new(0));
        let mut writer = CountingWriter(
            DisconnectAwareWriter {
                inner: Broken(calls.clone(), kind),
                closed: closed.clone(),
            },
            errors.clone(),
        );
        for _ in 0..5 {
            writer.write_all(b"line\n").unwrap();
            writer.flush().unwrap();
        }
        assert!(closed.load(Ordering::Relaxed));
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert_eq!(errors.load(Ordering::Relaxed), 0);
    }
    let errors = Arc::new(AtomicUsize::new(0));
    let mut writer = CountingWriter(
        DisconnectAwareWriter {
            inner: Broken(
                Arc::new(AtomicUsize::new(0)),
                std::io::ErrorKind::PermissionDenied,
            ),
            closed: Arc::new(AtomicBool::new(false)),
        },
        errors.clone(),
    );
    assert!(writer.write_all(b"line\n").is_err());
    assert_eq!(errors.load(Ordering::Relaxed), 1);
}
