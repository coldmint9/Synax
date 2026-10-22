//! Retry upstream HTTP failures before any response content is delivered.
use futures_util::{StreamExt, stream::BoxStream};
use rig_core::error::ProviderError;
use serde_json::{Value, json};
use std::time::Duration;

type Error = Box<dyn std::error::Error + Send + Sync>;
pub(crate) const MAX_RETRIES: usize = 10;

#[derive(Debug, thiserror::Error)]
#[error("{source} (retried {retries} times; 已重试 {retries} 次)")]
pub(crate) struct RetriesExhausted {
    retries: usize,
    #[source]
    source: Error,
}

pub(crate) fn http_status(error: &(dyn std::error::Error + 'static)) -> Option<u16> {
    if let Some(error) = error.downcast_ref::<ProviderError>() {
        return error.report().http_status;
    }
    error.source().and_then(http_status)
}

fn retryable_status(status: u16) -> bool {
    status == 429 || (500..600).contains(&status)
}

fn network_error(error: &(dyn std::error::Error + 'static)) -> bool {
    if error.is::<super::deadline::IdleTimeout>() {
        return true;
    }
    if let Some(error) = error.downcast_ref::<ProviderError>() {
        let report = error.report();
        return report.kind == rig_core::error::ErrorKind::Http && report.retryable;
    }
    if let Some(error) = error.downcast_ref::<reqwest::Error>() {
        return error.is_connect() || error.is_timeout() || error.is_body();
    }
    error.source().is_some_and(network_error)
}

/// Whether the same request may reasonably be attempted again.
///
/// A status decides every reply that carried one (429/5xx). A failure
/// with no status is classified by what it is: a transport fault, an idle
/// stream, or a reply the provider never finished. `ProviderError::is_retryable`
/// owns that judgement, so an `HttpError` / truncated `ResponseError` that
/// arrives without a status is retried instead of failing the session.
pub(crate) fn retryable_failure(error: &(dyn std::error::Error + 'static)) -> bool {
    if let Some(status) = http_status(error) {
        return retryable_status(status);
    }
    if error.is::<super::deadline::IdleTimeout>() {
        return true;
    }
    if let Some(error) = error.downcast_ref::<ProviderError>() {
        if error.is_retryable() {
            return true;
        }
        // Some compatible gateways report this SSE error without an HTTP
        // status or transport retry verdict, before producing any content.
        return error.provider_response().is_some_and(|response| {
            if response.refusal || response.transient == Some(false) {
                return false;
            }
            let code = response.machine_code().or_else(|| {
                serde_json::from_str::<Value>(&response.body)
                    .ok()?
                    .get("code")?
                    .as_str()
                    .map(str::to_owned)
            });
            code.as_deref() == Some("stream_first_token_timeout")
        });
    }
    if let Some(error) = error.downcast_ref::<reqwest::Error>() {
        return error.is_connect() || error.is_timeout() || error.is_body();
    }
    error.source().is_some_and(retryable_failure)
}

pub(crate) fn retry_delay(attempt: usize) -> Duration {
    Duration::from_secs((2_u64.saturating_mul(2_u64.saturating_pow(attempt as u32))).min(300))
}

/// The retry reason the host renders for a failure.
pub(crate) fn failure_reason(error: &(dyn std::error::Error + 'static)) -> &'static str {
    match http_status(error) {
        Some(429) => "rate_limit",
        Some(_) => "upstream",
        None => "network",
    }
}

/// Whether the host already received conversation content from this attempt.
///
/// Scheduling frames (`execution-status`), the protocol start, raw protocol
/// snapshots and usage are bookkeeping: replaying them costs nothing and must
/// not consume the retry budget. A provider that answers with an error body
/// yields such frames before it fails, so counting them as content used to
/// turn every real 429/5xx into a session failure on the first attempt.
fn delivers_content(event: &Value) -> bool {
    matches!(
        event["type"].as_str(),
        Some(
            "text-delta"
                | "reasoning-delta"
                | "tool-call"
                | "assistant-message"
                | "structured-output"
                | "media-partial"
                | "media-result"
        )
    )
}

pub(crate) fn with_retry(
    mut request: impl FnMut() -> BoxStream<'static, Result<Value, Error>> + Send + 'static,
    max_retries: usize,
) -> BoxStream<'static, Result<Value, Error>> {
    Box::pin(async_stream::try_stream! {
        let mut attempt = 0;
        let mut retry = Value::Null;
        loop {
            if attempt > 0 {
                tracing::info!(event = "provider.retrying", attempt, max_retries, "Retrying provider request");
                retry["phase"] = json!("retrying");
                retry["nextRetryAt"] = Value::Null;
                yield json!({"type":"retry_status","retry":retry});
            }
            let mut stream = request();
            let mut content_started = false;
            // Bookkeeping frames arrive before content, so the recovery is
            // announced once per attempt rather than once per frame.
            let mut recovery_announced = false;
            let mut failure = None;
            while let Some(event) = stream.next().await {
                match event {
                    Ok(event) => {
                        if event["type"] == "stream-start" {
                            if attempt == 0 { yield event; }
                            continue;
                        }
                        // Recovery is only true once the retried attempt
                        // actually produces content; a retry that fails again
                        // must not claim it recovered.
                        let content = delivers_content(&event);
                        if content && !content_started && attempt > 0 && !recovery_announced {
                            recovery_announced = true;
                            tracing::info!(event = "provider.recovered", attempt, "Provider request recovered");
                            retry["phase"] = json!("recovered");
                            yield json!({"type":"retry_status","retry":retry});
                        }
                        content_started = content_started || content;
                        yield event;
                    }
                    Err(error) => { failure = Some(error); break; }
                }
            }
            // Release the failed HTTP body before waiting. Dropping this
            // generator also cancels the sleep and any in-flight request.
            drop(stream);
            let Some(error) = failure else { break; };
            let status = http_status(error.as_ref());
            let network = status.is_none() && network_error(error.as_ref());
            if content_started || !retryable_failure(error.as_ref()) || max_retries == 0 {
                tracing::warn!(event = "provider.retry_skipped", attempt, content_started,
                    status_code = status, error_kind = crate::logging::error_kind(error.as_ref()),
                    "Provider failure will not be retried");
                Err(error)?;
                unreachable!();
            }
            retry = json!({
                "reason": if network { "network" } else if status == Some(429) { "rate_limit" } else { "upstream" },
                "phase":"waiting", "group":1, "attempt":attempt,
                "maxRetries":max_retries, "nextRetryAt":null,
                "error":error.to_string().chars().take(1000).collect::<String>()
            });
            if attempt >= max_retries {
                tracing::error!(event = "provider.retries_exhausted", attempt, max_retries, status_code = status,
                    "Provider retry budget exhausted");
                retry["phase"] = json!("exhausted");
                yield json!({"type":"retry_status","retry":retry});
                Err(RetriesExhausted { retries: attempt, source: error })?;
            }
            let delay = retry_delay(attempt);
            attempt += 1;
            tracing::warn!(event = "provider.retry_scheduled", attempt, max_retries,
                status_code = status, delay_ms = delay.as_millis() as u64, network,
                "Provider retry scheduled");
            retry["attempt"] = json!(attempt);
            retry["nextRetryAt"] = json!(chrono::Utc::now().timestamp_millis() + delay.as_millis() as i64);
            yield json!({"type":"retry_status","retry":retry});
            tokio::time::sleep(delay).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    fn failure(status: u16) -> Error {
        ProviderError::from_http_response(
            http::StatusCode::from_u16(status).unwrap(),
            "upstream failure",
        )
        .into()
    }

    #[test]
    fn retries_all_server_statuses_and_rate_limits_only() {
        for status in 100..=599 {
            assert_eq!(retryable_status(status), status == 429 || status >= 500);
            assert_eq!(http_status(failure(status).as_ref()), Some(status));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn exhausts_ten_retries_with_exponential_delays_capped_at_five_minutes() {
        for status in [429, 500, 501, 503, 529, 599] {
            let calls = Arc::new(AtomicUsize::new(0));
            let count = calls.clone();
            let started = tokio::time::Instant::now();
            let mut stream = with_retry(
                move || {
                    count.fetch_add(1, Ordering::SeqCst);
                    Box::pin(futures_util::stream::iter(vec![Err(failure(status))]))
                },
                MAX_RETRIES,
            );
            let mut waits = Vec::new();
            let mut final_error = None;
            while let Some(event) = stream.next().await {
                match event {
                    Ok(event) if event["retry"]["phase"] == "waiting" => {
                        waits.push(
                            tokio::time::Instant::now()
                                .duration_since(started)
                                .as_secs(),
                        );
                        assert_eq!(event["retry"]["attempt"], waits.len());
                        assert_eq!(event["retry"]["maxRetries"], 10);
                        assert_eq!(
                            event["retry"]["reason"],
                            if status == 429 {
                                "rate_limit"
                            } else {
                                "upstream"
                            }
                        );
                    }
                    Err(error) => final_error = Some(error),
                    _ => {}
                }
            }
            assert_eq!(calls.load(Ordering::SeqCst), 11);
            assert_eq!(waits, [0, 2, 6, 14, 30, 62, 126, 254, 510, 810]);
            assert_eq!(started.elapsed(), Duration::from_secs(1110));
            let error = final_error.unwrap();
            assert!(error.is::<RetriesExhausted>());
            assert_eq!(http_status(error.as_ref()), Some(status));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn recovers_and_shares_budget_between_rate_limits_and_server_errors() {
        let mut calls = 0;
        let mut stream = with_retry(
            move || {
                calls += 1;
                Box::pin(futures_util::stream::iter(match calls {
                    1 => vec![Err(failure(503))],
                    2 => vec![Err(failure(429))],
                    _ => vec![
                        Ok(json!({"type":"text-delta","delta":"ok"})),
                        Ok(json!({"type":"finish"})),
                    ],
                }))
            },
            MAX_RETRIES,
        );
        let mut phases = Vec::new();
        let mut text = String::new();
        while let Some(event) = stream.next().await {
            let event = event.unwrap();
            if let Some(phase) = event["retry"]["phase"].as_str() {
                phases.push(phase.to_owned());
            }
            if let Some(delta) = event["delta"].as_str() {
                text.push_str(delta);
            }
        }
        assert_eq!(
            phases,
            ["waiting", "retrying", "waiting", "retrying", "recovered"]
        );
        assert_eq!(text, "ok");
    }

    #[tokio::test(start_paused = true)]
    async fn does_not_retry_other_statuses_disabled_retries_or_partial_output() {
        for (status, retries, partial) in [
            (400, 10, false),
            (401, 10, false),
            (403, 10, false),
            (422, 10, false),
            (503, 0, false),
            (503, 10, true),
        ] {
            let calls = Arc::new(AtomicUsize::new(0));
            let count = calls.clone();
            let mut stream = with_retry(
                move || {
                    count.fetch_add(1, Ordering::SeqCst);
                    let mut events = Vec::new();
                    if partial {
                        events.push(Ok(json!({"type":"text-delta","delta":"partial"})));
                    }
                    events.push(Err(failure(status)));
                    Box::pin(futures_util::stream::iter(events))
                },
                retries,
            );
            while let Some(event) = stream.next().await {
                if let Ok(event) = event {
                    assert_ne!(event["type"], "retry_status");
                }
            }
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn dropping_a_waiting_request_cancels_further_retries() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let mut stream = with_retry(
            move || {
                count.fetch_add(1, Ordering::SeqCst);
                Box::pin(futures_util::stream::iter(vec![Err(failure(503))]))
            },
            MAX_RETRIES,
        );
        assert_eq!(
            stream.next().await.unwrap().unwrap()["retry"]["phase"],
            "waiting"
        );
        // Poll into the sleep before cancelling, rather than dropping at yield.
        assert!(futures_util::poll!(stream.next()).is_pending());
        drop(stream);
        tokio::time::advance(Duration::from_secs(300)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn retries_a_transport_fault_that_reported_no_status() {
        // `HttpError: ...` and a reply the provider never finished carry no
        // status; retrying them is what keeps a session alive.
        let truncated: Error = ProviderError::Truncated.into();
        assert_eq!(http_status(truncated.as_ref()), None);
        assert!(retryable_failure(truncated.as_ref()));
        assert_eq!(failure_reason(truncated.as_ref()), "network");
    }

    #[tokio::test(start_paused = true)]
    async fn retries_first_token_timeout_without_an_http_status() {
        for body in [
            json!({"type":"error","code":"stream_first_token_timeout","message":"上游流式响应异常","sequence_number":0}),
            json!({"error":{"code":"stream_first_token_timeout"}}),
        ] {
            let mut calls = 0;
            let mut stream = with_retry(
                move || {
                    calls += 1;
                    Box::pin(futures_util::stream::iter(if calls == 1 {
                        vec![Err(
                            ProviderError::from_provider_body(body.to_string()).into()
                        )]
                    } else {
                        vec![Ok(json!({"type":"text-delta","delta":"recovered reply"}))]
                    }))
                },
                1,
            );
            let mut phases = Vec::new();
            let mut text = String::new();
            while let Some(event) = stream.next().await {
                let event = event.unwrap();
                if let Some(phase) = event["retry"]["phase"].as_str() {
                    phases.push(phase.to_owned());
                }
                if let Some(delta) = event["delta"].as_str() {
                    text.push_str(delta);
                }
            }
            assert_eq!(phases, ["waiting", "retrying", "recovered"]);
            assert_eq!(text, "recovered reply");
        }
    }

    #[test]
    fn first_token_timeout_does_not_override_a_permanent_verdict() {
        let body = r#"{"type":"error","code":"stream_first_token_timeout"}"#;
        let unauthorized = ProviderError::from_http_response(http::StatusCode::UNAUTHORIZED, body);
        assert!(!retryable_failure(&unauthorized));
        for response in [
            rig_core::ProviderResponseError::without_status(body).with_refusal(true),
            rig_core::ProviderResponseError::without_status(body).with_transient(Some(false)),
            rig_core::ProviderResponseError::without_status(r#"{"code":"invalid_api_key"}"#),
        ] {
            assert!(!retryable_failure(&ProviderError::ProviderResponse(
                response
            )));
        }
    }

    #[test]
    fn a_reported_status_decides_retryability() {
        for status in [400u16, 401, 403, 404, 408, 422, 425, 429, 500, 503, 529] {
            assert_eq!(
                retryable_failure(failure(status).as_ref()),
                retryable_status(status)
            );
        }
        assert_eq!(failure_reason(failure(429).as_ref()), "rate_limit");
        assert_eq!(failure_reason(failure(503).as_ref()), "upstream");
    }

    #[test]
    fn a_spent_provider_budget_stays_a_transient_failure() {
        // The loop's own retry must see the underlying cause, not the wrapper:
        // a 503 that ended a provider budget is still worth another step.
        let exhausted: Error = Box::new(RetriesExhausted {
            retries: MAX_RETRIES,
            source: failure(503),
        });
        assert!(retryable_failure(exhausted.as_ref()));
        assert_eq!(http_status(exhausted.as_ref()), Some(503));
    }

    #[test]
    fn step_backoff_starts_at_two_seconds_and_doubles() {
        assert_eq!(
            (0..3).map(retry_delay).collect::<Vec<_>>(),
            [
                Duration::from_secs(2),
                Duration::from_secs(4),
                Duration::from_secs(8),
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn bookkeeping_frames_do_not_spend_the_retry_budget() {
        // A provider that rejects a request answers after scheduling frames and
        // raw protocol snapshots; only conversation content may block a retry.
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let mut stream = with_retry(
            move || {
                let call = count.fetch_add(1, Ordering::SeqCst);
                Box::pin(futures_util::stream::iter(if call == 0 {
                    vec![
                        Ok(json!({"type":"execution-status","phase":"waiting_model"})),
                        Ok(json!({"type":"stream-start"})),
                        Ok(json!({"type":"raw","rawValue":{"error":"too many requests"}})),
                        Err(failure(429)),
                    ]
                } else {
                    vec![
                        Ok(json!({"type":"text-delta","delta":"ok"})),
                        Ok(json!({"type":"finish"})),
                    ]
                }))
            },
            MAX_RETRIES,
        );
        let mut text = String::new();
        let mut recovered = false;
        while let Some(event) = stream.next().await {
            let event = event.unwrap();
            if event["retry"]["phase"] == "recovered" {
                recovered = true;
            }
            if let Some(delta) = event["delta"].as_str() {
                text.push_str(delta);
            }
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(text, "ok");
        assert!(recovered);
    }
}
