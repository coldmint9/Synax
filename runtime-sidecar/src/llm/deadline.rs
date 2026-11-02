use super::Error;
use std::{future::Future, time::Duration};

#[derive(Debug, thiserror::Error)]
#[error("LLM stream idle timeout: no events for {0}ms")]
pub(crate) struct IdleTimeout(pub u64);

pub(super) async fn next<T>(pending: impl Future<Output = T>, timeout_ms: u64) -> Result<T, Error> {
    if timeout_ms == 0 {
        return Ok(pending.await);
    }
    tokio::time::timeout(Duration::from_millis(timeout_ms), pending)
        .await
        .map_err(|_| Box::new(IdleTimeout(timeout_ms)) as Error)
}

pub(super) fn configured_timeout() -> u64 {
    std::env::var("AGENT_LLM_STREAM_IDLE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(300_000)
}

/// How long one attempt may stay silent before its first event.
///
/// A request that hangs while connecting (or before the provider sends its
/// first byte) never fails on its own: the pending socket survives the outage
/// that created it, so a recovered network does not revive it. Without this
/// bound the session waits for the much longer stream idle watchdog and looks
/// stuck on the same retry. Failing the attempt earlier is what lets the next
/// retry run over the restored connection.
pub(super) fn configured_first_event_timeout() -> u64 {
    std::env::var("AGENT_LLM_FIRST_EVENT_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(70_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn terminates_a_silent_upstream() {
        let error = next(std::future::pending::<()>(), 25).await.unwrap_err();
        assert!(error.is::<IdleTimeout>());
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_attempt_before_its_first_event_ends_early() {
        // 70s by default, well inside the 300s stream idle watchdog, so the
        // retry loop gets a chance to run again on a restored network.
        let timeout_ms = configured_first_event_timeout();
        assert!(timeout_ms > 0 && timeout_ms < configured_timeout());
        let started = tokio::time::Instant::now();
        let error = next(std::future::pending::<()>(), timeout_ms)
            .await
            .unwrap_err();
        assert!(error.is::<IdleTimeout>());
        assert_eq!(started.elapsed(), Duration::from_millis(timeout_ms));
    }
}
