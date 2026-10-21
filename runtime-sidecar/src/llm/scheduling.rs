use super::{contract::ProviderRequest, Error};
use crate::runtime::resources::{self, ResourceGuard, ResourceRequest};
use futures_util::{StreamExt, stream::BoxStream};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;

/// The permit covers one provider attempt, not retries, tool work, or user input.
pub(super) fn schedule(input: ProviderRequest,
    create: impl FnOnce(ProviderRequest) -> BoxStream<'static, Result<Value, Error>> + Send + 'static,
) -> BoxStream<'static, Result<Value, Error>> {
    Box::pin(async_stream::try_stream! {
        let scheduler = resources::shared();
        let id = uuid::Uuid::new_v4().to_string();
        let session = input.cache_policy["sessionId"].as_str().unwrap_or("background").to_owned();
        let root = input.cache_policy["rootSessionId"].as_str().unwrap_or(&session).to_owned();
        let mut credentials: Vec<_> = input.headers.iter().collect(); credentials.sort();
        let key_bytes = serde_json::to_vec(&(&input.provider_id, &input.base_url, &input.api_key, credentials))?;
        let key = format!("{:x}", Sha256::digest(key_bytes));
        let timeout_ms = std::env::var("SYNAX_PROVIDER_REQUEST_TIMEOUT_MS").ok().and_then(|v| v.parse::<u64>().ok())
            .filter(|v| (1_000..=86_400_000).contains(v)).unwrap_or(1_800_000);
        let request = ResourceRequest { id: id.clone(), resource: format!("provider:{key}"), session_id: session,
            root_session_id: root, owner_id: format!("rust:{id}"), run_id: id.clone(), epoch: "rust".into(),
            expires_at: resources::now_ms() + 300_000, timeout_ms };
        let _guard = ResourceGuard { scheduler: scheduler.clone(), request: request.clone() };
        let mut status = scheduler.request(request.clone()).map_err(|e| -> Error { e.into() })?;
        if status.state == "queued" { yield json!({"type":"execution-status","phase":"queued_resources","resource":"provider","queuedAt":status.queued_at}); }
        while status.state == "queued" {
            tokio::time::sleep(Duration::from_millis(100)).await;
            status = scheduler.request(request.clone()).map_err(|e| -> Error { e.into() })?;
        }
        if status.state != "running" { Err::<(), Error>(format!("provider resource admission: {}", status.state).into())?; }
        yield json!({"type":"execution-status","phase":"waiting_model","resource":"provider","queuedAt":status.queued_at,"startedAt":status.started_at,"deadline":status.deadline});
        let mut events = create(input);
        let deadline = tokio::time::sleep(Duration::from_millis(timeout_ms)); tokio::pin!(deadline);
        let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
        loop {
            let event = tokio::select! {
                _ = &mut deadline => Some(Err::<Option<Value>, Error>("provider request total deadline exceeded".into())),
                _ = heartbeat.tick() => Some(scheduler.request(request.clone()).map(|_| None).map_err(|e| -> Error { e.into() })),
                event = events.next() => event.map(|e| e.map(Some)),
            };
            let Some(event) = event else { break };
            if let Some(value) = event? { yield value; }
        }
    })
}
