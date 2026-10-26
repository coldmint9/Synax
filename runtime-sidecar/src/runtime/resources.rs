//! Process-wide resource admission. Running owners retain their permits until confirmed stopped.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

const MAX_REQUESTS: usize = 4096;
const MAX_RECEIPTS: usize = 32_768;
const MAX_RECEIPT_BYTES: usize = 16 * 1024 * 1024;
const MAX_ROOT_QUEUE: usize = 128;
const MAX_POOLS: usize = 128;
const QUEUE_TIMEOUT_MS: u64 = 300_000;
const CLEANUP_GRACE_MS: u64 = 15_000;
const BACKGROUND_LIMIT: usize = 2;
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);

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
    #[serde(default)]
    pub background: bool,
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
    queue_deadline: Instant,
    changed: Option<watch::Sender<ResourceStatus>>,
}
struct Receipt {
    owner: String,
    fingerprint: Option<[u8; 32]>,
    status: ResourceStatus,
    expires_at: u64,
}
#[derive(Default)]
struct Pool {
    roots: VecDeque<String>,
    queues: HashMap<String, VecDeque<String>>,
    active: HashMap<String, usize>,
    active_total: usize,
    background_active: usize,
}
#[derive(Default)]
struct State {
    entries: HashMap<String, Entry>,
    pools: HashMap<String, Pool>,
    receipts: HashMap<String, Receipt>,
    receipt_expiry: BTreeSet<(u64, String)>,
    // Reserve receipt space on admission, so release never fails at capacity.
    receipt_bytes: usize,
    // One queue expiry, or an execution deadline and heartbeat deadline per entry.
    timers: BTreeSet<(Instant, String, u8)>,
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
            ("provider", 100),
        ]
        .into_iter()
        .map(|(name, fallback)| {
            let value = std::env::var(format!("SYNAX_RESOURCE_{}_LIMIT", name.to_uppercase()))
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|v| (1..=128).contains(v))
                .unwrap_or(fallback);
            (name.to_owned(), value)
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
fn receipt_size(id: &str, owner: &str) -> usize {
    id.len() + owner.len() + 256
}
fn fingerprint(request: &ResourceRequest) -> [u8; 32] {
    let mut digest = Sha256::new();
    for value in [
        &request.id,
        &request.resource,
        &request.session_id,
        &request.root_session_id,
        &request.owner_id,
        &request.run_id,
        &request.epoch,
    ] {
        digest.update((value.len() as u64).to_le_bytes());
        digest.update(value.as_bytes());
    }
    digest.update(request.expires_at.to_le_bytes());
    digest.update(request.timeout_ms.to_le_bytes());
    digest.update([u8::from(request.background)]);
    digest.finalize().into()
}

fn set_status(entry: &mut Entry, status: &'static str) {
    if entry.status.state != status {
        entry.status.state = status;
        if let Some(changed) = &entry.changed {
            changed.send_replace(entry.status.clone());
        }
    }
}
fn remove_timers(state: &mut State, entry: &Entry) {
    let id = &entry.request.id;
    state.timers.remove(&(entry.queue_deadline, id.clone(), 0));
    if let Some(started) = entry.started {
        state.timers.remove(&(
            started + Duration::from_millis(entry.request.timeout_ms),
            id.clone(),
            1,
        ));
        state
            .timers
            .remove(&(entry.last_seen + HEARTBEAT_TIMEOUT, id.clone(), 2));
    }
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
        let per_root = if resource.starts_with("provider:") {
            limit
        } else {
            1
        };
        // Foreground work gets the next free permit; running background work is not preempted.
        loop {
            if pool.active_total >= limit {
                break;
            }
            let foreground = pool.queues.values().flatten().any(|id| {
                state
                    .entries
                    .get(id)
                    .is_some_and(|e| e.status.state == "queued" && !e.request.background)
            });
            let mut granted = false;
            let roots = pool.roots.len();
            for _ in 0..roots {
                if pool.active_total >= limit {
                    break;
                }
                let Some(root) = pool.roots.pop_front() else {
                    break;
                };
                let queue = pool.queues.entry(root.clone()).or_default();
                queue.retain(|id| {
                    state
                        .entries
                        .get(id)
                        .is_some_and(|e| e.status.state == "queued")
                });
                if pool.active.get(&root).copied().unwrap_or(0) < per_root {
                    let position = queue.iter().position(|id| {
                        let e = &state.entries[id];
                        !e.request.background
                            || (!foreground && pool.background_active < BACKGROUND_LIMIT)
                    });
                    if let Some(position) = position {
                        let id = queue.remove(position).unwrap();
                        let entry = state.entries.get_mut(&id).unwrap();
                        let now = now_ms();
                        let started = Instant::now();
                        state.timers.remove(&(entry.queue_deadline, id.clone(), 0));
                        entry.status.started_at = Some(now);
                        entry.status.deadline = Some(now.saturating_add(entry.request.timeout_ms));
                        entry.status.queue_wait_ms = now.saturating_sub(entry.status.queued_at);
                        entry.started = Some(started);
                        entry.last_seen = started;
                        state.timers.insert((
                            started + Duration::from_millis(entry.request.timeout_ms),
                            id.clone(),
                            1,
                        ));
                        state.timers.insert((started + HEARTBEAT_TIMEOUT, id, 2));
                        *pool.active.entry(root.clone()).or_default() += 1;
                        pool.active_total += 1;
                        if entry.request.background {
                            pool.background_active += 1;
                        }
                        set_status(entry, "running");
                        granted = true;
                        tracing::info!(event="resource.started",resource,session_id=%entry.request.session_id,
                            root_session_id=%root,background=entry.request.background,queue_wait_ms=entry.status.queue_wait_ms);
                    }
                }
                if queue.is_empty() {
                    pool.queues.remove(&root);
                } else {
                    pool.roots.push_back(root);
                }
            }
            if !granted {
                break;
            }
        }
        if pool.active_total == 0 && pool.queues.is_empty() {
            state.pools.remove(resource);
        }
    }
    fn finish(state: &mut State, id: &str, status: &'static str) -> Option<String> {
        let mut entry = state.entries.remove(id)?;
        remove_timers(state, &entry);
        let resource = entry.request.resource.clone();
        if entry.started.is_some() {
            if let Some(pool) = state.pools.get_mut(&resource) {
                if let Some(count) = pool.active.get_mut(&entry.request.root_session_id) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        pool.active.remove(&entry.request.root_session_id);
                    }
                }
                pool.active_total = pool.active_total.saturating_sub(1);
                if entry.request.background {
                    pool.background_active = pool.background_active.saturating_sub(1);
                }
            }
            tracing::info!(event="resource.finished",resource=%resource,session_id=%entry.request.session_id,
                queue_wait_ms=entry.status.queue_wait_ms,execute_ms=entry.started.unwrap().elapsed().as_millis() as u64);
        }
        if let Some(pool) = state.pools.get_mut(&resource) {
            if let Some(queue) = pool.queues.get_mut(&entry.request.root_session_id) {
                queue.retain(|queued| queued != id);
                if queue.is_empty() {
                    pool.queues.remove(&entry.request.root_session_id);
                    pool.roots
                        .retain(|root| root != &entry.request.root_session_id);
                }
            }
        }
        set_status(&mut entry, status);
        let expires_at = entry.request.expires_at.saturating_add(60_000);
        state.receipt_expiry.insert((expires_at, id.to_owned()));
        state.receipts.insert(
            id.to_owned(),
            Receipt {
                owner: entry.request.owner_id.clone(),
                fingerprint: Some(fingerprint(&entry.request)),
                status: entry.status,
                expires_at,
            },
        );
        Some(resource)
    }
    fn sweep(&self, state: &mut State) {
        let now = now_ms();
        while state
            .receipt_expiry
            .first()
            .is_some_and(|(at, _)| *at <= now)
        {
            let (at, id) = state.receipt_expiry.pop_first().unwrap();
            if state.receipts.get(&id).is_some_and(|r| r.expires_at == at) {
                let receipt = state.receipts.remove(&id).unwrap();
                state.receipt_bytes -= receipt_size(&id, &receipt.owner);
            }
        }
        let now = Instant::now();
        while state.timers.first().is_some_and(|(at, _, _)| *at <= now) {
            let (_, id, kind) = state.timers.pop_first().unwrap();
            match kind {
                0 => {
                    if let Some(resource) = Self::finish(state, &id, "queue_timeout") {
                        self.dispatch(state, &resource);
                    }
                }
                1 => {
                    if let Some(e) = state.entries.get_mut(&id) {
                        set_status(e, "cancelling");
                    }
                }
                _ => {
                    if let Some(e) = state.entries.get_mut(&id) {
                        if e.status.state == "running" {
                            set_status(e, "unresponsive");
                        }
                    }
                }
            }
        }
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
            .any(|s| s.is_empty() || s.len() > 256)
            || request.timeout_ms == 0
            || request.timeout_ms > 86_400_000
            || (request.background && !request.resource.starts_with("provider:"))
        {
            return Err("invalid resource request".into());
        }
        let mut state = self.state.lock();
        self.sweep(&mut state);
        if let Some(receipt) = state.receipts.get(&request.id) {
            if receipt.owner != request.owner_id
                || receipt
                    .fingerprint
                    .is_some_and(|f| f != fingerprint(&request))
            {
                return Err("resource request identity conflict".into());
            }
            return if receipt.fingerprint.is_none() {
                Err("resource request cancelled".into())
            } else {
                Ok(receipt.status.clone())
            };
        }
        if let Some(mut entry) = state.entries.remove(&request.id) {
            if entry.request != request {
                state.entries.insert(entry.request.id.clone(), entry);
                return Err("resource request identity conflict".into());
            }
            if let Some(start) = entry.started {
                state
                    .timers
                    .remove(&(entry.last_seen + HEARTBEAT_TIMEOUT, request.id.clone(), 2));
                if start.elapsed() >= Duration::from_millis(request.timeout_ms) {
                    set_status(&mut entry, "cancelling");
                } else if entry.status.state == "unresponsive" {
                    set_status(&mut entry, "running");
                }
                entry.last_seen = Instant::now();
                if entry.status.state == "running" {
                    state.timers.insert((
                        entry.last_seen + HEARTBEAT_TIMEOUT,
                        request.id.clone(),
                        2,
                    ));
                }
            }
            let status = entry.status.clone();
            state.entries.insert(request.id.clone(), entry);
            return Ok(status);
        }
        let now = now_ms();
        if request.expires_at <= now
            || request.expires_at > now.saturating_add(QUEUE_TIMEOUT_MS + 5_000)
        {
            return Err("resource request expired".into());
        }
        if state.entries.len() >= MAX_REQUESTS
            || (!state.pools.contains_key(&request.resource) && state.pools.len() >= MAX_POOLS)
        {
            return Err("resource queue is full".into());
        }
        let bytes = receipt_size(&request.id, &request.owner_id);
        if state.entries.len() + state.receipts.len() >= MAX_RECEIPTS
            || state.receipt_bytes + bytes > MAX_RECEIPT_BYTES
        {
            return Err("resource receipt capacity exhausted".into());
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
        let status = ResourceStatus {
            state: "queued",
            queued_at: now,
            started_at: None,
            deadline: None,
            queue_wait_ms: 0,
        };

        let resource = request.resource.clone();
        let id = request.id.clone();
        let queue_deadline = Instant::now() + Duration::from_millis(request.expires_at - now);
        state.timers.insert((queue_deadline, id.clone(), 0));
        state.receipt_bytes += bytes;
        state.entries.insert(
            id.clone(),
            Entry {
                request,
                status,
                started: None,
                last_seen: Instant::now(),
                queue_deadline,
                changed: None,
            },
        );
        self.dispatch(&mut state, &resource);
        Ok(state.entries[&id].status.clone())
    }
    /// Subscribe after admission under the same lock used by dispatch; watch retains the latest status.
    pub async fn wait(
        &self,
        request: ResourceRequest,
        wait_ms: u64,
    ) -> Result<ResourceStatus, String> {
        let status = self.request(request.clone())?;
        if status.state != "queued" {
            return Ok(status);
        }
        let changed = self.state.lock().entries.get_mut(&request.id).map(|entry| {
            entry
                .changed
                .get_or_insert_with(|| watch::channel(entry.status.clone()).0)
                .subscribe()
        });
        let Some(mut changed) = changed else {
            return self.request(request);
        };
        let duration = Duration::from_millis(
            wait_ms
                .min(request.expires_at.saturating_sub(now_ms()))
                .max(1),
        );
        let result = tokio::time::timeout(duration, async {
            loop {
                let status = changed.borrow_and_update().clone();
                if status.state != "queued" {
                    return Some(status);
                }
                if changed.changed().await.is_err() {
                    return None;
                }
            }
        })
        .await;
        match result {
            Ok(Some(status)) => Ok(status),
            _ => self.request(request),
        }
    }
    pub fn release(&self, id: &str, owner_id: &str) -> Result<(), String> {
        if id.is_empty() || owner_id.is_empty() || id.len() > 256 || owner_id.len() > 256 {
            return Err("invalid release identity".into());
        }
        let mut state = self.state.lock();
        self.sweep(&mut state);
        if let Some(entry) = state.entries.get(id) {
            if entry.request.owner_id != owner_id {
                return Err("resource lease owner mismatch".into());
            }
            let resource = Self::finish(&mut state, id, "released").unwrap();
            self.dispatch(&mut state, &resource);
            return Ok(());
        }
        if let Some(receipt) = state.receipts.get(id) {
            return if receipt.owner == owner_id {
                Ok(())
            } else {
                Err("resource lease owner mismatch".into())
            };
        }
        let bytes = receipt_size(id, owner_id);
        if state.entries.len() + state.receipts.len() >= MAX_RECEIPTS
            || state.receipt_bytes + bytes > MAX_RECEIPT_BYTES
        {
            return Err("resource receipt capacity exhausted".into());
        }
        let expires_at = now_ms() + QUEUE_TIMEOUT_MS + 60_000;
        state.receipt_expiry.insert((expires_at, id.to_owned()));
        state.receipt_bytes += bytes;
        state.receipts.insert(
            id.to_owned(),
            Receipt {
                owner: owner_id.into(),
                fingerprint: None,
                expires_at,
                status: ResourceStatus {
                    state: "released",
                    queued_at: now_ms(),
                    started_at: None,
                    deadline: None,
                    queue_wait_ms: 0,
                },
            },
        );
        Ok(())
    }
    /// Only after the owner and its process tree have stopped.
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
        // Supervisor-only scan of active entries, never retained receipts or a per-token hot path.
        state
            .entries
            .values_mut()
            .filter_map(|e| {
                if e.started
                    .is_some_and(|s| s.elapsed() >= Duration::from_millis(e.request.timeout_ms))
                {
                    set_status(e, "cancelling");
                } else if e.started.is_some()
                    && e.last_seen.elapsed() >= HEARTBEAT_TIMEOUT
                    && e.status.state == "running"
                {
                    set_status(e, "unresponsive");
                }
                let overdue = match e.status.state {
                    "cancelling" => e.started.is_some_and(|s| {
                        s.elapsed()
                            >= Duration::from_millis(e.request.timeout_ms + CLEANUP_GRACE_MS)
                    }),
                    "unresponsive" => {
                        e.last_seen.elapsed()
                            >= HEARTBEAT_TIMEOUT + Duration::from_millis(CLEANUP_GRACE_MS)
                    }
                    _ => false,
                };
                overdue.then(|| e.request.clone())
            })
            .collect()
    }
    pub fn has_owner(&self, owner: &str) -> bool {
        self.state
            .lock()
            .entries
            .values()
            .any(|e| e.request.owner_id == owner)
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
            background: false,
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
    fn provider_children_can_fill_the_pool_without_exceeding_its_limit() {
        let scheduler = ResourceScheduler {
            state: Mutex::new(State::default()),
            limits: HashMap::from([("provider".into(), 3)]),
        };
        for id in ["child-a", "child-b", "child-c"] {
            let mut child = request(id, "root-a");
            child.resource = "provider:shared".into();
            assert_eq!(scheduler.request(child).unwrap().state, "running");
        }
        let mut other = request("other", "root-b");
        other.resource = "provider:shared".into();
        assert_eq!(scheduler.request(other.clone()).unwrap().state, "queued");
        scheduler.release("child-a", "owner").unwrap();
        assert_eq!(scheduler.request(other).unwrap().state, "running");
        assert_eq!(
            scheduler.state.lock().pools["provider:shared"].active_total,
            3
        );
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

    #[test]
    fn deadline_allows_cooperative_cleanup_before_worker_termination() {
        let scheduler = scheduler(1);
        let a = request("a", "root-a");
        let b = request("b", "root-b");
        scheduler.request(a.clone()).unwrap();
        scheduler.request(b.clone()).unwrap();
        scheduler.state.lock().entries.get_mut("a").unwrap().started =
            Some(Instant::now() - Duration::from_millis(a.timeout_ms + 100));
        assert!(scheduler.overdue().is_empty());
        assert_eq!(scheduler.request(a).unwrap().state, "cancelling");
        // Cleanup still owns the slot, but can return a normal tool failure.
        assert_eq!(scheduler.request(b.clone()).unwrap().state, "queued");
        scheduler.release("a", "owner").unwrap();
        assert!(scheduler.overdue().is_empty());
        assert_eq!(scheduler.request(b).unwrap().state, "running");
    }

    #[test]
    fn heartbeats_cannot_extend_the_deadline_cleanup_window() {
        let scheduler = scheduler(1);
        let a = request("a", "root");
        scheduler.request(a.clone()).unwrap();
        scheduler.state.lock().entries.get_mut("a").unwrap().started =
            Some(Instant::now() - Duration::from_millis(a.timeout_ms + 20_000));
        assert_eq!(scheduler.request(a).unwrap().state, "cancelling");
        assert_eq!(scheduler.overdue().len(), 1);
    }

    #[test]
    fn missed_heartbeats_get_a_bounded_recovery_window() {
        let scheduler = scheduler(1);
        let mut a = request("a", "root");
        a.timeout_ms = 120_000;
        scheduler.request(a.clone()).unwrap();
        scheduler
            .state
            .lock()
            .entries
            .get_mut("a")
            .unwrap()
            .last_seen = Instant::now() - Duration::from_secs(31);
        assert!(scheduler.overdue().is_empty());
        assert_eq!(scheduler.request(a).unwrap().state, "running");
        scheduler
            .state
            .lock()
            .entries
            .get_mut("a")
            .unwrap()
            .last_seen = Instant::now() - Duration::from_secs(46);
        assert_eq!(scheduler.overdue().len(), 1);
    }

    #[test]
    fn a_late_heartbeat_cannot_revive_an_expired_unresponsive_lease() {
        let scheduler = scheduler(1);
        let mut a = request("a", "root");
        a.timeout_ms = 120_000;
        scheduler.request(a.clone()).unwrap();
        scheduler
            .state
            .lock()
            .entries
            .get_mut("a")
            .unwrap()
            .last_seen = Instant::now() - Duration::from_secs(31);
        assert!(scheduler.overdue().is_empty());
        scheduler.state.lock().entries.get_mut("a").unwrap().started =
            Some(Instant::now() - Duration::from_millis(a.timeout_ms + 20_000));
        assert_eq!(scheduler.request(a).unwrap().state, "cancelling");
        assert_eq!(scheduler.overdue().len(), 1);
    }
    #[test]
    fn completed_receipts_do_not_consume_active_admission_capacity() {
        let scheduler = scheduler(4);
        for i in 0..10_000 {
            let req = request(&format!("short-{i}"), "root");
            assert_eq!(scheduler.request(req.clone()).unwrap().state, "running");
            scheduler.release(&req.id, "owner").unwrap();
            assert_eq!(scheduler.request(req).unwrap().state, "released");
        }
        let state = scheduler.state.lock();
        assert!(state.entries.is_empty());
        assert_eq!(state.receipts.len(), 10_000);
        assert!(state.timers.is_empty());
        assert!(state.receipt_bytes < MAX_RECEIPT_BYTES);
    }
    #[test]
    fn cancellation_before_admission_and_completed_identity_are_fenced() {
        let scheduler = scheduler(1);
        let mut req = request("late", "root");
        scheduler.release("late", "owner").unwrap();
        assert_eq!(
            scheduler.request(req.clone()).unwrap_err(),
            "resource request cancelled"
        );
        req.id = "complete".into();
        scheduler.request(req.clone()).unwrap();
        scheduler.release(&req.id, "owner").unwrap();
        req.timeout_ms += 1;
        assert_eq!(
            scheduler.request(req).unwrap_err(),
            "resource request identity conflict"
        );
        assert!(scheduler.release("late", "wrong-owner").is_err());
    }
    #[tokio::test]
    async fn waiter_wakes_on_release_without_a_poll_interval() {
        let scheduler = Arc::new(scheduler(1));
        scheduler.request(request("busy", "one")).unwrap();
        let queued = request("waiting", "two");
        scheduler.request(queued.clone()).unwrap();
        let waiting = {
            let scheduler = scheduler.clone();
            tokio::spawn(async move { scheduler.wait(queued, 25_000).await })
        };
        tokio::task::yield_now().await;
        let started = Instant::now();
        scheduler.release("busy", "owner").unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), waiting)
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .state,
            "running"
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }
    #[tokio::test]
    async fn waiting_cancellation_and_queue_expiry_are_delivered() {
        let scheduler = Arc::new(scheduler(1));
        scheduler.request(request("busy", "one")).unwrap();
        let mut queued = request("waiting", "two");
        queued.expires_at = now_ms() + 20;
        assert_eq!(
            scheduler.wait(queued, 1_000).await.unwrap().state,
            "queue_timeout"
        );
        let queued = request("cancel", "three");
        scheduler.request(queued.clone()).unwrap();
        let waiting = {
            let scheduler = scheduler.clone();
            tokio::spawn(async move { scheduler.wait(queued, 25_000).await })
        };
        scheduler.release("cancel", "owner").unwrap();
        assert_eq!(waiting.await.unwrap().unwrap().state, "released");
        assert!(scheduler.has_owner("owner"));
    }
    #[test]
    fn background_is_bounded_and_does_not_overtake_foreground() {
        let scheduler = ResourceScheduler {
            state: Mutex::new(State::default()),
            limits: HashMap::from([("provider".into(), 3)]),
        };
        let make = |id: &str, background: bool| {
            let mut r = request(id, id);
            r.resource = "provider:key".into();
            r.background = background;
            r
        };
        for id in ["bg1", "bg2"] {
            assert_eq!(scheduler.request(make(id, true)).unwrap().state, "running");
        }
        let bg3 = make("bg3", true);
        let main2 = make("main2", false);
        assert_eq!(scheduler.request(bg3.clone()).unwrap().state, "queued");
        assert_eq!(
            scheduler.request(make("main1", false)).unwrap().state,
            "running"
        );
        assert_eq!(scheduler.request(main2.clone()).unwrap().state, "queued");
        scheduler.release("bg1", "owner").unwrap();
        assert_eq!(scheduler.request(main2).unwrap().state, "running");
        assert_eq!(scheduler.request(bg3.clone()).unwrap().state, "queued");
        scheduler.release("main1", "owner").unwrap();
        assert_eq!(scheduler.request(bg3).unwrap().state, "running");
    }
    #[test]
    fn cancelled_waiters_do_not_fill_the_root_queue() {
        let scheduler = scheduler(1);
        scheduler.request(request("busy", "busy-root")).unwrap();
        for index in 0..1_000 {
            let req = request(&format!("cancel-{index}"), "waiting-root");
            assert_eq!(scheduler.request(req.clone()).unwrap().state, "queued");
            scheduler.release(&req.id, "owner").unwrap();
        }
        assert_eq!(
            scheduler
                .request(request("last", "waiting-root"))
                .unwrap()
                .state,
            "queued"
        );
        scheduler.release("busy", "owner").unwrap();
        assert_eq!(
            scheduler.state.lock().entries["last"].status.state,
            "running"
        );
    }
}
