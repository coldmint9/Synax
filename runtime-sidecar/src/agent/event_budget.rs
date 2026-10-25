//! Payload permits live with retained events, and are released only by ACK or loop teardown.
use std::sync::{Arc, OnceLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};

pub(super) const TERMINAL_RESERVE: usize = 64 * 1024;
pub(super) struct EventBudget {
    normal: Arc<Semaphore>,
    terminal: Arc<Semaphore>,
    pub changed: watch::Sender<u64>,
}
pub(super) struct EventPermit {
    permit: Option<OwnedSemaphorePermit>,
    changed: watch::Sender<u64>,
}
impl Drop for EventPermit {
    fn drop(&mut self) {
        drop(self.permit.take());
        self.changed.send_modify(|value| *value += 1);
    }
}
impl EventBudget {
    pub fn new(normal: usize, terminal: usize) -> Self {
        let (changed, _) = watch::channel(0);
        Self {
            normal: Arc::new(Semaphore::new(normal)),
            terminal: Arc::new(Semaphore::new(terminal)),
            changed,
        }
    }
    pub fn try_reserve(&self, bytes: usize, terminal: bool) -> Option<Arc<EventPermit>> {
        if bytes == 0 {
            return None;
        }
        let pool = if terminal {
            &self.terminal
        } else {
            &self.normal
        };
        let permit = pool
            .clone()
            .try_acquire_many_owned(u32::try_from(bytes).ok()?)
            .ok()?;
        Some(Arc::new(EventPermit {
            permit: Some(permit),
            changed: self.changed.clone(),
        }))
    }
}
pub(super) fn shared() -> Arc<EventBudget> {
    static BUDGET: OnceLock<Arc<EventBudget>> = OnceLock::new();
    BUDGET
        .get_or_init(|| Arc::new(EventBudget::new(120 * 1024 * 1024, 8 * 1024 * 1024)))
        .clone()
}
