//! Exercise the real binary, READY protocol, filtering, rotation and shutdown flush.
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

struct Runtime {
    child: Child,
    root: PathBuf,
    ready: Value,
    stderr: Option<std::thread::JoinHandle<String>>,
}
impl Runtime {
    fn start(filter: Option<&str>, file_unavailable: bool) -> Self {
        Self::with_io(filter, file_unavailable, None, false)
    }

    fn with_io(
        filter: Option<&str>,
        file_unavailable: bool,
        timezone: Option<&str>,
        closed_stderr: bool,
    ) -> Self {
        let root = std::env::temp_dir().join(format!("synax-logging-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("logs")).unwrap();
        for day in 1..=10 {
            std::fs::write(
                root.join("logs")
                    .join(format!("runtime.2000-01-{day:02}.jsonl")),
                "old\n",
            )
            .unwrap();
        }
        std::fs::write(root.join("logs/events-keep.jsonl"), "keep").unwrap();
        let log_dir = if file_unavailable {
            std::fs::write(root.join("blocked"), "file").unwrap();
            root.join("blocked/logs")
        } else {
            root.join("logs")
        };
        let mut command = Command::new(env!("CARGO_BIN_EXE_synax-runtime-sidecar"));
        command
            .env(
                "SYNAX_RUNTIME_STORE_PATH",
                root.join("runtime-sidecar/jsonl"),
            )
            .env("SYNAX_RUNTIME_LOG_DIR", log_dir)
            .env("SYNAX_RUNTIME_SIDECAR_PORT", "0")
            .env("SYNAX_RUNTIME_PROVIDER_PORT", "0")
            .env("SYNAX_RUNTIME_SIDECAR_TOKEN", "secret-runtime-token")
            .env("SYNAX_RUNTIME_PARENT_WATCH", "1")
            .env("LOG_LEVEL", "info")
            .env_remove("SYNAX_RUNTIME_SIDECAR_SOCKET")
            .env_remove("RUST_LOG")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(filter) = filter {
            command.env("RUST_LOG", filter);
        }
        if let Some(timezone) = timezone {
            command.env("TZ", timezone);
        }
        let mut child = command.spawn().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let stderr = if closed_stderr {
            drop(stderr);
            None
        } else {
            Some(std::thread::spawn(move || {
                let mut text = String::new();
                stderr.read_to_string(&mut text).unwrap();
                text
            }))
        };
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if tx.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        let mut runtime = Self {
            child,
            root,
            ready: Value::Null,
            stderr,
        };
        let line = rx
            .recv_timeout(Duration::from_secs(15))
            .expect("runtime READY timeout");
        runtime.ready = serde_json::from_str(
            line.strip_prefix("SYNAX_RUNTIME_READY:")
                .expect("stdout must remain the READY protocol"),
        )
        .unwrap();
        runtime
    }

    fn request(&self, route: &str, body: Value, token: &str) -> String {
        let port = self.ready["providerPort"].as_u64().unwrap() as u16;
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let body = body.to_string();
        write!(stream, "POST {route} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn stop(&mut self) -> String {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline, "runtime shutdown timeout");
            std::thread::sleep(Duration::from_millis(10));
        }
        self.stderr
            .take()
            .map(|thread| thread.join().unwrap())
            .unwrap_or_default()
    }
}

#[test]
fn timestamps_and_file_dates_follow_the_configured_local_timezone() {
    // Opposite offsets ensure at least one local date differs from UTC at any hour.
    for timezone in ["Asia/Shanghai", "Pacific/Kiritimati", "Etc/GMT+12"] {
        let mut runtime = Runtime::with_io(None, false, Some(timezone), false);
        let text = runtime.stop();
        let rows: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let timestamp = rows[0]["timestamp"].as_str().unwrap();
        let (expected_offset, suffix) = match timezone {
            "Asia/Shanghai" => (8 * 3600, "+08:00"),
            "Pacific/Kiritimati" => (14 * 3600, "+14:00"),
            _ => (-12 * 3600, "-12:00"),
        };
        let parsed = chrono::DateTime::parse_from_rfc3339(timestamp).unwrap();
        assert_eq!(parsed.offset().local_minus_utc(), expected_offset);
        assert!(
            runtime
                .root
                .join("logs")
                .join(format!("runtime.{}.jsonl", parsed.date_naive()))
                .exists()
        );
        assert!(
            rows.iter()
                .all(|row| row["timestamp"].as_str().unwrap().ends_with(suffix))
        );
    }
}

#[test]
fn disconnected_parent_log_pipe_keeps_native_logs_without_sink_errors() {
    let mut runtime = Runtime::with_io(None, false, Some("Asia/Shanghai"), true);
    runtime.request("/missing", json!({}), "secret-runtime-token");
    runtime.stop();
    let text = std::fs::read_dir(runtime.root.join("logs"))
        .unwrap()
        .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
        .find(|text| text.contains("runtime.stopped"))
        .unwrap();
    let rows: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(
        rows.iter()
            .any(|row| row["fields"]["event"] == "runtime.ready")
    );
    assert!(
        !rows
            .iter()
            .any(|row| row["fields"]["event"] == "logging.write_failed")
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row["fields"]["event"] == "logging.stderr_closed")
            .count(),
        1
    );
}
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.join();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn real_runtime_persists_correlated_json_and_flushes_on_parent_exit() {
    let mut runtime = Runtime::start(None, false);
    assert!(
        runtime
            .request(
                "/provider/stream?secret-query",
                json!({"prompt":"secret-prompt"}),
                "secret-wrong-token"
            )
            .contains("401")
    );
    let response = runtime.request(
        "/provider/stream",
        json!({
            "apiFormat":"unsupported", "model":"test-model", "apiKey":"secret-api-key",
            "headers":{"authorization":"secret-header"},
            "prompt":[{"role":"user","content":[{"type":"text","text":"secret-prompt"}]}],
        }),
        "secret-runtime-token",
    );
    assert!(response.contains("\"type\":\"error\""));
    let text = runtime.stop();
    let rows: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).expect("stderr NDJSON"))
        .collect();
    assert!(rows.iter().any(|r| r["fields"]["event"] == "runtime.ready"));
    assert!(
        rows.iter()
            .any(|r| r["fields"]["event"] == "runtime.stopped")
    );
    assert!(
        rows.iter()
            .any(|r| r["fields"]["event"] == "http.rejected" && r["level"] == "WARN")
    );
    let failure = rows
        .iter()
        .find(|r| r["fields"]["event"] == "provider.failed")
        .unwrap();
    assert_eq!(failure["level"], "ERROR");
    assert!(
        failure["spans"]
            .as_array()
            .unwrap()
            .iter()
            .any(|span| span["request_id"].is_string())
    );
    assert!(
        failure["spans"]
            .as_array()
            .unwrap()
            .iter()
            .any(|span| span["provider_request_id"].is_string())
    );
    assert!(!text.contains("secret-"));
    assert!(!rows.iter().any(|row| row["level"] == "DEBUG"));
    let files: Vec<_> = std::fs::read_dir(runtime.root.join("logs"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("runtime.")
        })
        .collect();
    assert_eq!(files.len(), 7);
    assert_eq!(
        std::fs::read_to_string(runtime.root.join("logs/events-keep.jsonl")).unwrap(),
        "keep"
    );
    let native = files
        .iter()
        .map(|p| std::fs::read_to_string(p).unwrap())
        .find(|text| text.contains("runtime.stopped"))
        .unwrap();
    let disk: Vec<Value> = native
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows, disk);
}

#[test]
fn module_filter_overrides_node_level_and_file_failure_keeps_stderr_alive() {
    let mut runtime = Runtime::start(Some("off,synax_runtime_sidecar=debug"), true);
    runtime.request("/missing", json!({}), "secret-runtime-token");
    let text = runtime.stop();
    let rows: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(
        rows.iter()
            .any(|row| row["fields"]["event"] == "logging.file_unavailable")
    );
    assert!(
        rows.iter()
            .any(|row| row["fields"]["event"] == "http.received" && row["level"] == "DEBUG")
    );
    assert!(
        rows.iter()
            .any(|row| row["fields"]["event"] == "runtime.stopped")
    );
}

#[test]
fn error_only_filter_keeps_request_and_process_correlation() {
    let mut runtime = Runtime::start(Some("off,synax_runtime_sidecar=error"), false);
    runtime.request(
        "/provider/stream",
        json!({"apiFormat":"unsupported", "model":"test-model", "prompt":[]}),
        "secret-runtime-token",
    );
    let text = runtime.stop();
    let rows: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let failure = rows
        .iter()
        .find(|row| row["fields"]["event"] == "provider.failed")
        .unwrap();
    assert!(rows.iter().all(|row| row["level"] == "ERROR"));
    assert!(
        failure["spans"]
            .as_array()
            .unwrap()
            .iter()
            .any(|span| span["pid"].is_number())
    );
    assert!(
        failure["spans"]
            .as_array()
            .unwrap()
            .iter()
            .any(|span| span["request_id"].is_string())
    );
    assert!(
        failure["spans"]
            .as_array()
            .unwrap()
            .iter()
            .any(|span| span["provider_request_id"].is_string())
    );
}

#[test]
fn startup_failures_are_structured_and_flushed_before_nonzero_exit() {
    let output = Command::new(env!("CARGO_BIN_EXE_synax-runtime-sidecar"))
        .env_remove("SYNAX_RUNTIME_STORE_PATH")
        .env_remove("SYNAX_RUNTIME_LOG_DIR")
        .env_remove("DATA_ROOT")
        .env_remove("RUST_LOG")
        .env("LOG_LEVEL", "info")
        .env("SYNAX_RUNTIME_SIDECAR_PORT", "0")
        .env("SYNAX_RUNTIME_PROVIDER_PORT", "0")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let rows: Vec<Value> = String::from_utf8(output.stderr)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(
        rows.iter()
            .any(|row| row["fields"]["event"] == "runtime.failed" && row["level"] == "ERROR")
    );
}
