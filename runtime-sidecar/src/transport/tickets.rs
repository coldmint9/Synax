use moka::future::Cache;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const TTL: Duration = Duration::from_secs(30);
const MAX_TICKETS: usize = 1024;

#[derive(Clone, Debug)]
pub struct UiScope {
    pub session_id: String,
    pub client_id: String,
}

struct Ticket {
    scope: UiScope,
    expires: Instant,
    used: AtomicBool,
    _slot: OwnedSemaphorePermit,
}

pub struct TicketStore {
    cache: Cache<String, Arc<Ticket>>,
    slots: Arc<Semaphore>,
}
impl TicketStore {
    pub fn new() -> Self {
        Self {
            cache: Cache::builder()
                .max_capacity(MAX_TICKETS as u64)
                .time_to_live(TTL)
                .build(),
            slots: Arc::new(Semaphore::new(MAX_TICKETS)),
        }
    }

    pub async fn issue(&self, scope: UiScope) -> Result<(String, u64), &'static str> {
        if scope.session_id.is_empty()
            || scope.session_id.len() > 256
            || scope.client_id.is_empty()
            || scope.client_id.len() > 256
        {
            return Err("invalid ticket scope");
        }
        self.cache.run_pending_tasks().await;
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "ticket capacity exhausted")?;
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.cache
            .insert(
                token.clone(),
                Arc::new(Ticket {
                    scope,
                    expires: Instant::now() + TTL,
                    used: AtomicBool::new(false),
                    _slot: slot,
                }),
            )
            .await;
        let expires = (SystemTime::now() + TTL)
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "invalid system time")?
            .as_millis() as u64;
        Ok((token, expires))
    }

    pub async fn consume(&self, token: &str, client_id: &str) -> Option<UiScope> {
        let ticket = self.cache.get(token).await?;
        if ticket.expires <= Instant::now() || ticket.scope.client_id != client_id {
            return None;
        }
        if ticket
            .used
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return None;
        }
        self.cache.invalidate(token).await;
        Some(ticket.scope.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn ticket_is_scoped_and_can_only_be_consumed_once_concurrently() {
        let store = TicketStore::new();
        let (token, expires) = store
            .issue(UiScope {
                session_id: "s".into(),
                client_id: "window1".into(),
            })
            .await
            .unwrap();
        assert!(
            expires
                > SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64
        );
        assert!(store.consume(&token, "window2").await.is_none());
        let (first, second) = tokio::join!(
            store.consume(&token, "window1"),
            store.consume(&token, "window1")
        );
        assert_eq!(first.is_some() as u8 + second.is_some() as u8, 1);
        assert_eq!(first.or(second).unwrap().session_id, "s");
        assert!(store.consume(&token, "window1").await.is_none());
    }
    #[tokio::test]
    async fn expired_ticket_is_rejected_even_before_cache_maintenance() {
        let store = TicketStore::new();
        store
            .cache
            .insert(
                "expired".into(),
                Arc::new(Ticket {
                    scope: UiScope {
                        session_id: "s".into(),
                        client_id: "c".into(),
                    },
                    expires: Instant::now() - Duration::from_secs(1),
                    used: AtomicBool::new(false),
                    _slot: store.slots.clone().try_acquire_owned().unwrap(),
                }),
            )
            .await;
        assert!(store.consume("expired", "c").await.is_none());
    }
}
