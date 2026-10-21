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

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn terminates_a_silent_upstream() {
        let error = next(std::future::pending::<()>(), 25).await.unwrap_err();
        assert!(error.is::<IdleTimeout>());
    }
}
