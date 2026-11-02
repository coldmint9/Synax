//! One bounded worker for disposable list-summary refreshes. Dirty entries carry
//! only an actor identity, a commit number and scheduling state, never snapshots.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Weak},
    thread,
    time::{Duration, Instant},
};

use parking_lot::{Condvar, Mutex, RwLock, RwLockWriteGuard};

use crate::storage::jsonl::{
    error::JsonlResult,
    lock::StoreLock,
    session::{SessionActor, SessionHandleCell},
};

use super::summary_cache;

const REFRESH_WINDOW: Duration = Duration::from_millis(1000);
const FINAL_WAIT: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(30);

struct Pending {
    cell: Weak<SessionHandleCell>,
    commit: u64,
    deadline: Instant,
    attempted: u64,
    failures: u32,
    in_flight: bool,
    followup_deadline: Option<Instant>,
    waiting_for_sync: bool,
}

#[derive(Default)]
struct State {
    pending: HashMap<String, Pending>,
    stopping: bool,
    stopped: bool,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    /// Publication and deletion/reset take this gate before an actor lock.
    lifecycle: RwLock<()>,
    /// Both cold-cache repair and the hot worker serialize final replacements.
    publication: Mutex<()>,
    #[cfg(test)]
    before_stage: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

enum Refresh {
    Saved(u64),
    WaitingForSync,
    Superseded,
}

pub(super) struct Coordinator {
    shared: Arc<Shared>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Coordinator {
    pub(super) fn new(root: PathBuf, store_lock: Arc<StoreLock>) -> JsonlResult<Self> {
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            lifecycle: RwLock::new(()),
            publication: Mutex::new(()),
            #[cfg(test)]
            before_stage: Mutex::new(None),
        });
        let worker_shared = shared.clone();
        let worker = thread::Builder::new()
            .name("runtime-summary-cache".into())
            .spawn(move || {
                // If filesystem I/O stalls past the bounded shutdown wait, its
                // store lock remains held until the worker can stop safely.
                let _store_lock = store_lock;
                worker_loop(&root, &worker_shared);
            })?;
        Ok(Self {
            shared,
            worker: Some(worker),
        })
    }

    /// Called only after the actor's durable sync succeeds. Repeated updates do
    /// not move the first deadline; each session has at most one dirty entry.
    pub(super) fn mark_dirty(&self, actor: &SessionActor, urgent: bool) {
        if !actor.header.is_object() || actor.summary_commit == actor.commit {
            return;
        }
        let Some(cell) = actor.cell.as_ref() else {
            return;
        };
        let now = Instant::now();
        let mut state = self.shared.state.lock();
        if state.stopping {
            return;
        }
        let entry = state
            .pending
            .entry(actor.id.clone())
            .or_insert_with(|| Pending {
                cell: cell.clone(),
                commit: actor.commit,
                deadline: now + REFRESH_WINDOW,
                attempted: 0,
                failures: 0,
                in_flight: false,
                followup_deadline: None,
                waiting_for_sync: false,
            });
        if !Weak::ptr_eq(&entry.cell, cell) {
            *entry = Pending {
                cell: cell.clone(),
                commit: actor.commit,
                deadline: now + REFRESH_WINDOW,
                attempted: 0,
                failures: 0,
                in_flight: false,
                followup_deadline: None,
                waiting_for_sync: false,
            };
        } else {
            if entry.in_flight && actor.commit > entry.commit {
                entry.followup_deadline.get_or_insert(now + REFRESH_WINDOW);
            }
            entry.commit = entry.commit.max(actor.commit);
        }
        entry.waiting_for_sync = false;
        if urgent {
            entry.deadline = now;
            entry.attempted = 0;
            if entry.in_flight {
                entry.followup_deadline = Some(now);
            }
        }
        self.shared.changed.notify_one();
    }

    /// Cache errors cannot fail durable work. Wait only for one final attempt,
    /// outside all actor locks, and never hold shutdown indefinitely on cache I/O.
    pub(super) fn wait_for(&self, targets: &[(String, Weak<SessionHandleCell>, u64)]) -> bool {
        let deadline = Instant::now() + FINAL_WAIT;
        let mut state = self.shared.state.lock();
        loop {
            let waiting = targets.iter().any(|(id, cell, commit)| {
                state.pending.get(id).is_some_and(|entry| {
                    Weak::ptr_eq(&entry.cell, cell) && entry.attempted < *commit
                })
            });
            if !waiting || state.stopped {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                tracing::warn!(
                    event = "storage.summary_cache_flush_timeout",
                    "Final summary refresh will be rebuilt on next startup"
                );
                return false;
            }
            self.shared.changed.wait_for(&mut state, remaining);
        }
    }

    pub(super) fn cancel(&self, id: &str) {
        self.shared.state.lock().pending.remove(id);
        self.shared.changed.notify_all();
    }

    /// Process leases do not dirty list data, but their completed sync may
    /// unblock a summary that was already waiting on this actor's source files.
    pub(super) fn wake_synced(&self, actor: &SessionActor) {
        let Some(cell) = actor.cell.as_ref() else {
            return;
        };
        let mut state = self.shared.state.lock();
        if let Some(entry) = state
            .pending
            .get_mut(&actor.id)
            .filter(|entry| Weak::ptr_eq(&entry.cell, cell))
        {
            entry.commit = entry.commit.max(actor.commit);
            entry.waiting_for_sync = false;
            self.shared.changed.notify_one();
        }
    }

    pub(super) fn reset(&self) {
        self.shared.state.lock().pending.clear();
        self.shared.changed.notify_all();
    }

    pub(super) fn lifecycle(&self) -> RwLockWriteGuard<'_, ()> {
        self.shared.lifecycle.write()
    }

    pub(super) fn read_lifecycle(&self) -> parking_lot::RwLockReadGuard<'_, ()> {
        self.shared.lifecycle.read()
    }

    pub(super) fn publish_rebuilt(&self, staged: summary_cache::Staged) -> JsonlResult<bool> {
        let _publication = self.shared.publication.lock();
        staged.publish()
    }

    #[cfg(test)]
    pub(super) fn before_stage(&self, hook: impl FnOnce() + Send + 'static) {
        *self.shared.before_stage.lock() = Some(Box::new(hook));
    }

    #[cfg(test)]
    pub(super) fn pending_deadline(&self, id: &str) -> Option<Instant> {
        self.shared
            .state
            .lock()
            .pending
            .get(id)
            .map(|entry| entry.deadline)
    }
}

impl Drop for Coordinator {
    fn drop(&mut self) {
        let deadline = Instant::now() + FINAL_WAIT;
        let mut state = self.shared.state.lock();
        state.stopping = true;
        state.pending.clear();
        self.shared.changed.notify_all();
        while !state.stopped {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                // Dropping JoinHandle detaches a stalled worker; it owns the
                // store lock and checks stopping before any future publication.
                return;
            }
            self.shared.changed.wait_for(&mut state, remaining);
        }
        drop(state);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn worker_loop(root: &std::path::Path, shared: &Shared) {
    loop {
        let (id, cell, commit) = {
            let mut state = shared.state.lock();
            loop {
                if state.stopping {
                    state.stopped = true;
                    shared.changed.notify_all();
                    return;
                }
                let next = state
                    .pending
                    .iter()
                    .filter(|(_, entry)| !entry.waiting_for_sync)
                    .min_by_key(|(_, entry)| entry.deadline);
                if let Some((id, entry)) = next {
                    let remaining = entry.deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        let selected = (id.clone(), entry.cell.clone(), entry.commit);
                        state
                            .pending
                            .get_mut(&selected.0)
                            .expect("selected pending entry")
                            .in_flight = true;
                        break selected;
                    }
                    shared.changed.wait_for(&mut state, remaining);
                } else {
                    shared.changed.wait(&mut state);
                }
            }
        };
        let result = match cell.upgrade() {
            Some(cell) => refresh(root, shared, &cell),
            None => Ok(Refresh::Saved(commit)),
        };
        let mut state = shared.state.lock();
        if let Some(entry) = state
            .pending
            .get_mut(&id)
            .filter(|entry| Weak::ptr_eq(&entry.cell, &cell))
        {
            entry.in_flight = false;
            match result {
                Ok(Refresh::Saved(saved)) => {
                    entry.attempted = entry.attempted.max(saved);
                    if entry.commit <= saved {
                        state.pending.remove(&id);
                    } else {
                        entry.deadline = entry
                            .followup_deadline
                            .take()
                            .unwrap_or_else(|| Instant::now() + REFRESH_WINDOW);
                        entry.failures = 0;
                    }
                }
                Ok(Refresh::WaitingForSync) => {
                    // A transaction has appended but its normal durability
                    // barrier has not completed yet. Never fsync on this path.
                    // A following successful ACK calls mark_dirty and wakes us.
                    // An append with no completed durability barrier cannot
                    // create a permanent idle polling loop.
                    entry.waiting_for_sync = entry.commit == commit;
                }
                Ok(Refresh::Superseded) => {
                    entry.deadline = entry
                        .followup_deadline
                        .take()
                        .unwrap_or_else(|| Instant::now() + REFRESH_WINDOW);
                }
                Err(error) => {
                    entry.attempted = entry.attempted.max(commit);
                    entry.failures = entry.failures.saturating_add(1);
                    let delay = Duration::from_millis(250)
                        .saturating_mul(1u32 << entry.failures.min(7))
                        .min(RETRY_MAX);
                    entry.deadline = Instant::now() + delay;
                    tracing::warn!(event = "storage.summary_cache_failed", session_id = id,
                        error = %error, retry_ms = delay.as_millis() as u64,
                        "Session summary will be retried; committed logs remain authoritative");
                }
            }
        }
        shared.changed.notify_all();
    }
}

fn refresh(
    root: &std::path::Path,
    shared: &Shared,
    cell: &Arc<SessionHandleCell>,
) -> JsonlResult<Refresh> {
    let prepared = {
        let actor = cell.actor.lock();
        if !actor.header.is_object() || actor.summary_commit == actor.commit {
            return Ok(Refresh::Saved(actor.commit));
        }
        if actor.commit != actor.durable_commit {
            return Ok(Refresh::WaitingForSync);
        }
        summary_cache::capture(root, &actor)?
    };
    let Some(prepared) = prepared else {
        return Ok(Refresh::Saved(cell.actor.lock().commit));
    };
    let commit = prepared.commit;
    #[cfg(test)]
    if let Some(hook) = shared.before_stage.lock().take() {
        hook();
    }
    let staged = prepared.stage()?;
    // Encoding/temp I/O is outside the actor lock. Only the final rename is
    // serialized with deletion/reset and the actor's lifecycle.
    let _lifecycle = shared.lifecycle.read();
    let current = {
        let state = shared.state.lock();
        !state.stopping
            && state
                .pending
                .get(&cell.id)
                .is_some_and(|entry| Weak::ptr_eq(&entry.cell, &Arc::downgrade(cell)))
    };
    if !current {
        return Ok(Refresh::Saved(commit));
    }
    let mut actor = cell.actor.lock();
    if !actor.header.is_object()
        || crate::storage::jsonl::layout::ensure_not_deleted(root, &actor.id).is_err()
    {
        return Ok(Refresh::Saved(commit));
    }
    let published = {
        let _publication = shared.publication.lock();
        staged.publish()?
    };
    if published {
        actor.summary_commit = actor.summary_commit.max(commit);
        Ok(Refresh::Saved(commit))
    } else {
        // Keep this version dirty. If the newer append has crossed its barrier,
        // schedule the latest state; otherwise its ACK will wake this entry.
        Ok(Refresh::Superseded)
    }
}
