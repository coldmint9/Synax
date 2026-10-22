//! Process-wide resource admission. Active leases are never recycled merely
//! because a deadline/heartbeat expires: the owner must confirm execution stopped.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_REQUESTS: usize = 4096;
const MAX_ROOT_QUEUE: usize = 128;
const MAX_POOLS: usize = 128;
const QUEUE_TIMEOUT_MS: u64 = 300_000;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRequest {
    pub id: String,
    pub resource: String,
    pub session_id: String,
    pub root_session_id: String,
    pub owner_id: String,
    pub run_id: String,
    pub epoch: String,
    pub expires_at: u64,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceStatus {
    pub state: &'static str,
    pub queued_at: u64,
    pub started_at: Option<u64>,
    pub deadline: Option<u64>,
    pub queue_wait_ms: u64,
}
struct Entry {
    request: ResourceRequest,
    status: ResourceStatus,
    started: Option<Instant>,
    last_seen: Instant,
}
#[derive(Default)]
struct Pool {
    roots: VecDeque<String>,
    queues: HashMap<String, VecDeque<String>>,
    active: HashMap<String, usize>,
}
#[derive(Default)]
struct State {
    entries: HashMap<String, Entry>,
    pools: HashMap<String, Pool>,
    cancelled: HashMap<String, (String, Instant)>,
}

pub struct ResourceScheduler {
    state: Mutex<State>,
    limits: HashMap<String, usize>,
}
impl Default for ResourceScheduler {
    fn default() -> Self {
        let limits = [
            ("search", 4),
            ("io", 8),
            ("command", 4),
            ("cpu", 2),
            ("provider", 8),
        ]
        .into_iter()
        .map(|(name, fallback)| {
            let limit = std::env::var(format!("SYNAX_RESOURCE_{}_LIMIT", name.to_uppercase()))
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|v| (1..=128).contains(v))
                .unwrap_or(fallback);
            (name.to_owned(), limit)
        })
        .collect();
        Self {
            state: Mutex::new(State::default()),
            limits,
        }
    }
}
pub fn shared() -> Arc<ResourceScheduler> {
    static SCHEDULER: OnceLock<Arc<ResourceScheduler>> = OnceLock::new();
    SCHEDULER
        .get_or_init(|| Arc::new(ResourceScheduler::default()))
        .clone()
}
impl ResourceScheduler {
    fn limit(&self, resource: &str) -> Option<usize> {
        self.limits
            .get(resource.split(':').next().unwrap_or(resource))
            .copied()
    }
    fn dispatch(&self, state: &mut State, resource: &str) {
        let limit = self.limit(resource).unwrap_or(1);
        let Some(pool) = state.pools.get_mut(resource) else {
            return;
        };
        let mut remaining = pool.roots.len();
        while pool.active.values().sum::<usize>() < limit && remaining > 0 {
            let Some(root) = pool.roots.pop_front() else {
                break;
            };
            remaining -= 1;
            let queue = pool.queues.entry(root.clone()).or_default();
            while queue.front().is_some_and(|id| {
                state
                    .entries
                    .get(id)
                    .is_none_or(|e| e.status.state != "queued")
            }) {
                queue.pop_front();
            }
            // One operation per root for tools, up to two provider calls so a
            // parent and a delegate can use otherwise independent requests.
            let per_root = if resource.starts_with("provider:") {
                2
            } else {
                1
            };
            if pool.active.get(&root).copied().unwrap_or(0) < per_root {
                if let Some(id) = queue.pop_front() {
                    let entry = state.entries.get_mut(&id).unwrap();
                    let now = now_ms();
                    entry.status.state = "running";
                    entry.status.started_at = Some(now);
                    entry.status.deadline = Some(now.saturating_add(entry.request.timeout_ms));
                    entry.status.queue_wait_ms = now.saturating_sub(entry.status.queued_at);
                    entry.started = Some(Instant::now());
                    *pool.active.entry(root.clone()).or_default() += 1;
                    tracing::info!(event = "resource.started", resource, session_id = %entry.request.session_id,
                        root_session_id = %root, queue_wait_ms = entry.status.queue_wait_ms);
                }
            }
            if !queue.is_empty() {
                pool.roots.push_back(root);
            } else {
                pool.queues.remove(&root);
            }
        }
    }
    fn sweep(&self, state: &mut State) {
        state
            .cancelled
            .retain(|_, (_, at)| at.elapsed() < Duration::from_secs(360));
        let now = now_ms();
        state.entries.retain(|_, entry| {
            match entry.status.state {
                "queued" if now >= entry.request.expires_at => entry.status.state = "queue_timeout",
                "running"
                    if entry.started.is_some_and(|s| {
                        s.elapsed() >= Duration::from_millis(entry.request.timeout_ms)
                    }) =>
                {
                    entry.status.state = "cancelling"
                }
                "running" if entry.last_seen.elapsed() >= Duration::from_secs(30) => {
                    entry.status.state = "unresponsive"
                }
                _ => {}
            }
            matches!(
                entry.status.state,
                "running" | "cancelling" | "unresponsive"
            ) || now < entry.request.expires_at.saturating_add(60_000)
        });
        let keys: Vec<_> = state.pools.keys().cloned().collect();
        for resource in keys {
            self.dispatch(state, &resource);
        }
        state
            .pools
            .retain(|_, p| !p.roots.is_empty() || !p.active.is_empty());
    }
    pub fn request(&self, request: ResourceRequest) -> Result<ResourceStatus, String> {
        if self.limit(&request.resource).is_none()
            || [
                &request.id,
                &request.resource,
                &request.session_id,
                &request.root_session_id,
                &request.owner_id,
                &request.run_id,
                &request.epoch,
            ]
            .iter()
            .any(|v| v.is_empty() || v.len() > 256)
            || request.timeout_ms == 0
            || request.timeout_ms > 86_400_000
        {
            return Err("invalid resource request".into());
        }
        let mut state = self.state.lock();
        self.sweep(&mut state);
        if let Some((owner, _)) = state.cancelled.get(&request.id) {
            return Err(if owner == &request.owner_id {
                "resource request cancelled"
            } else {
                "resource request identity conflict"
            }
            .into());
        }
        if let Some(entry) = state.entries.get_mut(&request.id) {
            if entry.request != request {
                return Err("resource request identity conflict".into());
            }
            entry.last_seen = Instant::now();
            if entry.status.state == "unresponsive" {
                entry.status.state = "running";
            }
            return Ok(entry.status.clone());
        }
        let now = now_ms();
        if request.expires_at <= now
            || request.expires_at > now.saturating_add(QUEUE_TIMEOUT_MS + 5_000)
        {
            return Err("resource request expired".into());
        }
        if state.entries.len() + state.cancelled.len() >= MAX_REQUESTS
            || !state.pools.contains_key(&request.resource) && state.pools.len() >= MAX_POOLS
        {
            return Err("resource queue is full".into());
        }
        let pool = state.pools.entry(request.resource.clone()).or_default();
        let queue = pool
            .queues
            .entry(request.root_session_id.clone())
            .or_default();
        if queue.len() >= MAX_ROOT_QUEUE {
            return Err("session resource queue is full".into());
        }
        if queue.is_empty() {
            pool.roots.push_back(request.root_session_id.clone());
        }
        queue.push_back(request.id.clone());
        let resource = request.resource.clone();
        let id = request.id.clone();
        state.entries.insert(
            id.clone(),
            Entry {
                request,
                status: ResourceStatus {
                    state: "queued",
                    queued_at: now,
                    started_at: None,
                    deadline: None,
                    queue_wait_ms: 0,
                },
                started: None,
                last_seen: Instant::now(),
            },
        );
        self.dispatch(&mut state, &resource);
        Ok(state.entries[&id].status.clone())
    }
    pub fn release(&self, id: &str, owner_id: &str) -> Result<(), String> {
        let mut state = self.state.lock();
        let Some(entry) = state.entries.get_mut(id) else {
            if id.is_empty() || owner_id.is_empty() || id.len() > 256 || owner_id.len() > 256 {
                return Err("invalid release identity".into());
            }
            if state.cancelled.len() >= MAX_REQUESTS {
                return Err("resource cancellation queue is full".into());
            }
            state
                .cancelled
                .insert(id.into(), (owner_id.into(), Instant::now()));
            return Ok(());
        };
        if entry.request.owner_id != owner_id {
            return Err("resource lease owner mismatch".into());
        }
        let active = matches!(
            entry.status.state,
            "running" | "cancelling" | "unresponsive"
        );
        let resource = entry.request.resource.clone();
        let root = entry.request.root_session_id.clone();
        if active {
            tracing::info!(event = "resource.finished", resource = %resource,
            session_id = %entry.request.session_id, queue_wait_ms = entry.status.queue_wait_ms,
            execute_ms = entry.started.map_or(0, |start| start.elapsed().as_millis() as u64));
        }
        entry.status.state = "released";
        if active {
            if let Some(pool) = state.pools.get_mut(&resource) {
                if let Some(count) = pool.active.get_mut(&root) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        pool.active.remove(&root);
                    }
                }
            }
        }
        self.dispatch(&mut state, &resource);
        Ok(())
    }
    /// Only the supervisor calls this after confirming the worker and its owned processes stopped.
    pub fn release_owner(&self, owner_id: &str) {
        let ids: Vec<_> = self
            .state
            .lock()
            .entries
            .values()
            .filter(|e| e.request.owner_id == owner_id)
            .map(|e| e.request.id.clone())
            .collect();
        for id in ids {
            let _ = self.release(&id, owner_id);
        }
    }
    pub fn overdue(&self) -> Vec<ResourceRequest> {
        let mut state = self.state.lock();
        self.sweep(&mut state);
        state
            .entries
            .values()
            .filter(|e| matches!(e.status.state, "cancelling" | "unresponsive"))
            .map(|e| e.request.clone())
            .collect()
    }
    pub fn has_owner(&self, owner: &str) -> bool {
        self.state.lock().entries.values().any(|entry| {
            entry.request.owner_id == owner
                && matches!(
                    entry.status.state,
                    "queued" | "running" | "cancelling" | "unresponsive"
                )
        })
    }
}
pub struct ResourceGuard {
    pub scheduler: Arc<ResourceScheduler>,
    pub request: ResourceRequest,
}
impl Drop for ResourceGuard {
    fn drop(&mut self) {
        let _ = self
            .scheduler
            .release(&self.request.id, &self.request.owner_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scheduler(limit: usize) -> ResourceScheduler {
        ResourceScheduler {
            state: Mutex::new(State::default()),
            limits: HashMap::from([("search".into(), limit)]),
        }
    }
    fn request(id: &str, root: &str) -> ResourceRequest {
        ResourceRequest {
            id: id.into(),
            resource: "search".into(),
            session_id: id.into(),
            root_session_id: root.into(),
            owner_id: "owner".into(),
            run_id: "run".into(),
            epoch: "1".into(),
            expires_at: now_ms() + 300_000,
            timeout_ms: 30_000,
        }
    }
    #[test]
    fn roots_receive_turns_and_children_share_a_budget() {
        let scheduler = scheduler(1);
        let a = request("a", "root-a");
        let a2 = request("a2", "root-a");
        let b = request("b", "root-b");
        assert_eq!(scheduler.request(a.clone()).unwrap().state, "running");
        assert_eq!(scheduler.request(a2.clone()).unwrap().state, "queued");
        assert_eq!(scheduler.request(b.clone()).unwrap().state, "queued");
        scheduler.release("a", "owner").unwrap();
        // Existing root gets one turn, then yields even if it keeps submitting.
        assert_eq!(scheduler.request(a2).unwrap().state, "running");
        let a3 = request("a3", "root-a");
        scheduler.request(a3.clone()).unwrap();
        scheduler.release("a2", "owner").unwrap();
        assert_eq!(scheduler.request(b).unwrap().state, "running");
        assert_eq!(scheduler.request(a3).unwrap().state, "queued");
    }
    #[test]
    fn cancellation_receipts_prevent_reacquisition_and_double_release() {
        let scheduler = scheduler(1);
        let a = request("a", "root");
        scheduler.request(a.clone()).unwrap();
        assert!(scheduler.release("a", "wrong-owner").is_err());
        scheduler.release("a", "owner").unwrap();
        scheduler.release("a", "owner").unwrap();
        assert_eq!(scheduler.request(a).unwrap().state, "released");
    }
    #[test]
    fn expired_active_work_is_quarantined_until_stopped() {
        let scheduler = scheduler(1);
        let a = request("a", "root-a");
        let b = request("b", "root-b");
        scheduler.request(a).unwrap();
        scheduler.request(b.clone()).unwrap();
        scheduler.state.lock().entries.get_mut("a").unwrap().started =
            Some(Instant::now() - Duration::from_secs(60));
        assert_eq!(scheduler.overdue().len(), 1);
        assert_eq!(scheduler.request(b.clone()).unwrap().state, "queued");
        scheduler.release("a", "owner").unwrap();
        assert_eq!(scheduler.request(b).unwrap().state, "running");
    }
}
