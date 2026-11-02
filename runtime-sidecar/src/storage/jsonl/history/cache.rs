//! Business metadata and conversation transcripts have independent working sets.
//! Reading the host's metadata scopes must not evict/replay conversation history.
use super::{HistorySession, wire::HistoryError};
use crate::storage::session_cache::SessionCache;
use std::{sync::Arc, time::Duration};

#[derive(Default)]
pub(super) struct HistoryCache {
    conversations: SessionCache<Arc<HistorySession>>,
    metadata: SessionCache<Arc<HistorySession>>,
}

impl HistoryCache {
    fn partition(&self, id: &str) -> &SessionCache<Arc<HistorySession>> {
        if id.starts_with("metadata:") { &self.metadata } else { &self.conversations }
    }

    pub fn get_or_try_init(&self, id: &str, open: impl FnOnce() -> Result<Arc<HistorySession>, HistoryError>) -> Result<Arc<HistorySession>, HistoryError> {
        self.partition(id).get_or_try_init(id, open)
    }

    pub fn peek(&self, id: &str) -> Option<Arc<HistorySession>> {
        self.partition(id).peek(id)
    }

    pub fn remove(&self, id: &str) { self.partition(id).remove(id); }

    pub fn clear(&self) {
        self.conversations.clear();
        self.metadata.clear();
    }

    pub fn evict(&self, capacity: usize, idle: Duration, mut release: impl FnMut(&Arc<HistorySession>) -> bool) -> usize {
        // Metadata has many small persistent scopes; transcript capacity remains
        // bounded separately. Explicit zero-capacity sweeps still release all.
        self.conversations.evict(capacity, idle, &mut release)
            + self.metadata.evict(if capacity == 0 { 0 } else { 32 }, idle, release)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_reads_do_not_evict_recent_conversations() {
        let root = std::env::temp_dir().join(format!("history-cache-{}", uuid::Uuid::new_v4()));
        let cache = HistoryCache::default();
        let conversation = cache.get_or_try_init("s", || HistorySession::open(&root, "s").map(Arc::new)).unwrap();
        let identity = Arc::downgrade(&conversation);
        drop(conversation);
        for i in 0..20 {
            let id = format!("metadata:scope-{i}");
            cache.get_or_try_init(&id, || HistorySession::open(&root, &id).map(Arc::new)).unwrap();
            cache.evict(4, Duration::from_secs(300), |session| Arc::strong_count(session) == 1);
        }
        assert!(identity.upgrade().is_some());
        assert_eq!(cache.evict(0, Duration::ZERO, |session| Arc::strong_count(session) == 1), 21);
        assert!(identity.upgrade().is_none());
        drop(cache);
        std::fs::remove_dir_all(root).unwrap();
    }
}
