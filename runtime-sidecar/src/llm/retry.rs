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

fn retry_delay(attempt: usize) -> Duration {
    Duration::from_secs((2_u64.saturating_mul(2_u64.saturating_pow(attempt as u32))).min(300))
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
            let mut failure = None;
            while let Some(event) = stream.next().await {
                match event {
                    Ok(event) => {
                        if event["type"] == "stream-start" {
                            if attempt == 0 { yield event; }
                            continue;
                        }
                        if attempt > 0 && !content_started {
                            tracing::info!(event = "provider.recovered", attempt, "Provider request recovered");
                            retry["phase"] = json!("recovered");
                            yield json!({"type":"retry_status","retry":retry});
                        }
                        content_started = true;
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
            if content_started || !(status.is_some_and(retryable_status) || network) || max_retries == 0 {
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
}
