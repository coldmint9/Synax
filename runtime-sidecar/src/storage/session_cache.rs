//! Only registration holds the map lock. Disk replay is serialized per key.
use parking_lot::{Mutex, RwLock};
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
};

struct Slot<T> {
    value: OnceLock<T>,
    opening: Mutex<()>,
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
                    })
                })
                .clone()
        });
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
        self.slots.write().clear();
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
            std::thread::spawn(move || cache.get_or_try_init("slow", || {
                opened.fetch_add(1, Ordering::SeqCst);
                Ok::<_, ()>(Arc::new(3))
            }).unwrap())
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
