//! Only registration holds the map lock. Disk replay is serialized per key.
use parking_lot::{Mutex, RwLock};
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

struct Slot<T> {
    value: OnceLock<T>,
    opening: Mutex<()>,
    touched: Mutex<Instant>,
}

pub(crate) struct SessionCache<T> {
    slots: RwLock<HashMap<String, Arc<Slot<T>>>>,
}
impl<T> Default for SessionCache<T> {
    fn default() -> Self {
        Self {
            slots: RwLock::new(HashMap::new()),
        }
    }
}
impl<T: Clone> SessionCache<T> {
    pub(crate) fn get_or_try_init<E>(
        &self,
        key: &str,
        open: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        let existing = { self.slots.read().get(key).cloned() };
        let slot = existing.unwrap_or_else(|| {
            self.slots
                .write()
                .entry(key.to_owned())
                .or_insert_with(|| {
                    Arc::new(Slot {
                        value: OnceLock::new(),
                        opening: Mutex::new(()),
                        touched: Mutex::new(Instant::now()),
                    })
                })
                .clone()
        });
        *slot.touched.lock() = Instant::now();
        if let Some(value) = slot.value.get() {
            return Ok(value.clone());
        }
        let _opening = slot.opening.lock();
        if let Some(value) = slot.value.get() {
            return Ok(value.clone());
        }
        let value = open()?;
        let _ = slot.value.set(value.clone());
        Ok(value)
    }
    pub(crate) fn get(&self, key: &str) -> Option<T> {
        self.slots.read().get(key).and_then(|slot| {
            *slot.touched.lock() = Instant::now();
            slot.value.get().cloned()
        })
    }
    pub(crate) fn peek(&self, key: &str) -> Option<T> {
        self.slots
            .read()
            .get(key)
            .and_then(|slot| slot.value.get().cloned())
    }
    pub(crate) fn values(&self) -> Vec<T> {
        self.slots
            .read()
            .values()
            .filter_map(|slot| slot.value.get().cloned())
            .collect()
    }
    pub(crate) fn clear(&self) {
        let previous = std::mem::take(&mut *self.slots.write());
        drop(previous);
    }

    /// Keep recently used entries warm, evicting the least recently used idle
    /// entries when the capacity is exceeded. Busy entries are never removed.
    pub(crate) fn evict(
        &self,
        capacity: usize,
        idle: Duration,
        mut release: impl FnMut(&T) -> bool,
    ) -> usize {
        self.evict_prepared(capacity, idle, &mut release, |_| true)
    }

    /// Expensive checkpoint I/O runs outside the map lock. Recheck ownership
    /// and last access before removal so a concurrent reader cannot be evicted.
    pub(crate) fn evict_prepared(
        &self,
        capacity: usize,
        idle: Duration,
        mut release: impl FnMut(&T) -> bool,
        mut prepare: impl FnMut(&T) -> bool,
    ) -> usize {
        let now = Instant::now();
        let mut candidates: Vec<_> = self
            .slots
            .read()
            .iter()
            .map(|(id, slot)| (id.clone(), *slot.touched.lock()))
            .collect();
        candidates.sort_by_key(|(_, touched)| *touched);
        let mut removed = 0;
        for (id, touched) in candidates {
            let slot = {
                let slots = self.slots.read();
                if slots.len() <= capacity && now.saturating_duration_since(touched) < idle {
                    continue;
                }
                let Some(slot) = slots.get(&id) else {
                    continue;
                };
                if Arc::strong_count(slot) != 1 {
                    continue;
                }
                slot.clone()
            };
            if slot
                .value
                .get()
                .is_some_and(|value| !release(value) || !prepare(value))
            {
                continue;
            }
            let detached = {
                let mut slots = self.slots.write();
                if !slots
                    .get(&id)
                    .is_some_and(|current| Arc::ptr_eq(current, &slot))
                    || Arc::strong_count(&slot) != 2
                    || *slot.touched.lock() != touched
                    || slot.value.get().is_some_and(|value| !release(value))
                {
                    continue;
                }
                slots.remove(&id)
            };
            // In particular, a HistorySession destructor persists its index.
            // Neither destructor nor preparation holds the global map lock.
            drop(detached);
            removed += 1;
        }
        removed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        time::Duration,
    };

    #[test]
    fn idle_retention_and_capacity_evict_only_the_least_recently_used_releasable_entries() {
        let cache = SessionCache::<usize>::default();
        for (id, value) in [("old", 1), ("recent", 2), ("busy", 3)] {
            cache.get_or_try_init(id, || Ok::<_, ()>(value)).unwrap();
        }
        *cache.slots.read()["old"].touched.lock() = Instant::now() - Duration::from_secs(60);
        assert_eq!(cache.evict(3, Duration::from_secs(300), |_| true), 0);
        assert_eq!(
            cache.evict(2, Duration::from_secs(300), |value| *value != 3),
            1
        );
        assert!(cache.peek("old").is_none());
        assert!(cache.peek("recent").is_some());
        *cache.slots.read()["recent"].touched.lock() = Instant::now() - Duration::from_secs(301);
        assert_eq!(
            cache.evict(2, Duration::from_secs(300), |value| *value != 3),
            1
        );
        assert_eq!(cache.evict(0, Duration::ZERO, |value| *value != 3), 0);
        assert!(cache.peek("busy").is_some());
    }

    #[test]
    fn checkpoint_preparation_does_not_block_other_keys_or_evict_a_new_reader() {
        let cache = Arc::new(SessionCache::<usize>::default());
        cache.get_or_try_init("old", || Ok::<_, ()>(1)).unwrap();
        let (entered, waiting) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let worker = {
            let cache = cache.clone();
            std::thread::spawn(move || {
                cache.evict_prepared(
                    0,
                    Duration::ZERO,
                    |_| true,
                    |_| {
                        entered.send(()).unwrap();
                        gate.recv().unwrap();
                        true
                    },
                )
            })
        };
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        let (done, result) = mpsc::channel();
        let reader = {
            let cache = cache.clone();
            std::thread::spawn(move || {
                cache.get_or_try_init("other", || Ok::<_, ()>(2)).unwrap();
                done.send(cache.get("old")).unwrap();
            })
        };
        let read = result.recv_timeout(Duration::from_secs(2));
        release.send(()).unwrap();
        reader.join().unwrap();
        assert_eq!(read.unwrap(), Some(1));
        assert_eq!(worker.join().unwrap(), 0);
        assert!(cache.peek("old").is_some());
    }

    #[test]
    fn cold_session_does_not_block_other_sessions_and_shared_load_runs_once() {
        let cache = Arc::new(SessionCache::<Arc<usize>>::default());
        let opened = Arc::new(AtomicUsize::new(0));
        let (entered, waiting) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let first = {
            let cache = cache.clone();
            let opened = opened.clone();
            std::thread::spawn(move || {
                cache
                    .get_or_try_init("slow", || {
                        opened.fetch_add(1, Ordering::SeqCst);
                        entered.send(()).unwrap();
                        gate.recv().unwrap();
                        Ok::<_, ()>(Arc::new(1))
                    })
                    .unwrap()
            })
        };
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        let duplicate = {
            let cache = cache.clone();
            let opened = opened.clone();
            std::thread::spawn(move || {
                cache
                    .get_or_try_init("slow", || {
                        opened.fetch_add(1, Ordering::SeqCst);
                        Ok::<_, ()>(Arc::new(3))
                    })
                    .unwrap()
            })
        };
        let (ready, other) = mpsc::channel();
        let second = {
            let cache = cache.clone();
            std::thread::spawn(move || {
                ready
                    .send(
                        cache
                            .get_or_try_init("fast", || Ok::<_, ()>(Arc::new(2)))
                            .unwrap(),
                    )
                    .unwrap();
            })
        };
        let independent = other.recv_timeout(Duration::from_secs(2));
        // Release even on assertion failure so a regression cannot hang the test process.
        release.send(()).unwrap();
        assert_eq!(**independent.as_ref().unwrap(), 2);
        second.join().unwrap();
        let original = first.join().unwrap();
        assert!(Arc::ptr_eq(&original, &duplicate.join().unwrap()));
        let mut callers = Vec::new();
        for _ in 0..8 {
            let cache = cache.clone();
            let opened = opened.clone();
            callers.push(std::thread::spawn(move || {
                cache
                    .get_or_try_init("slow", || {
                        opened.fetch_add(1, Ordering::SeqCst);
                        Ok::<_, ()>(Arc::new(3))
                    })
                    .unwrap()
            }));
        }
        for caller in callers {
            assert!(Arc::ptr_eq(&original, &caller.join().unwrap()));
        }
        assert_eq!(opened.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn failed_load_is_retryable_without_publishing_partial_state() {
        let cache = SessionCache::<usize>::default();
        assert_eq!(
            cache.get_or_try_init("failed", || Err::<usize, _>("disk")),
            Err("disk")
        );
        assert!(cache.get("failed").is_none());
        assert_eq!(cache.get_or_try_init("failed", || Ok::<_, &str>(5)), Ok(5));
    }
}
