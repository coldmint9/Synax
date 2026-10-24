//! Process-local model/tool execution. The host drains a pending delivery
//! queue; committed conversation history is owned by the session store.

use crate::agent::context::{self as loop_context, Compaction, ContextAction, ContextPolicy};
use crate::agent::policy::{self as loop_policy, Decision, Disposition, RuntimeBinding};
use crate::llm::errors::InvalidToolArguments;
use crate::llm::{completion::provider_events, contract::ProviderRequest};
use crate::runtime::{actor::SessionShardRouter, execution::ExecutionLease};
use crate::storage::jsonl::hot::HotOps as HotStore;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, watch};
use tracing::Instrument;
use uuid::Uuid;

const MAX_PENDING_EVENT_BYTES: usize = 32 * 1024 * 1024;
const TERMINAL_RETENTION_MS: u64 = 15 * 60 * 1000;
const MAX_ACTIVE_LOOPS: usize = 128;
const MAX_TOOL_ARGUMENT_RETRIES: u32 = 2;
/// Retries of one model step whose failure delivered no content to the host.
/// The provider layer already retries an unstarted reply; this is the outer
/// bound for a runtime fault that escaped it. Waits are 2s, 4s and 8s.
const MAX_MODEL_RETRIES: u32 = 3;
type LoopError = Box<dyn std::error::Error + Send + Sync>;
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct AgentLoopRequest {
    #[serde(flatten)]
    pub provider: ProviderRequest,
    // Retain old request/execution bytes for idempotency, but never use this
    // retired field to stop execution. New callers do not send a step budget.
    #[serde(default, rename = "maxSteps", skip_serializing_if = "Option::is_none")]
    pub legacy_max_steps: Option<u64>,
    #[serde(default, rename = "runtimeBinding")]
    pub runtime_binding: Option<RuntimeBinding>,
    #[serde(default, rename = "requestId")]
    pub request_id: Option<String>,
    #[serde(default, rename = "contextPolicy")]
    pub context_policy: Option<ContextPolicy>,
    #[serde(default, rename = "executionContext")]
    pub execution_context: Option<ExecutionLease>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub(crate) struct ToolResultRequest {
    #[serde(rename = "loopId")]
    pub loop_id: String,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: String,
    pub result: Value,
    #[serde(default, rename = "isError")]
    pub is_error: bool,
    #[serde(default, rename = "executionContext")]
    pub execution_context: Option<ExecutionLease>,
}

impl ToolResultRequest {
    fn fingerprint(&self) -> [u8; 32] {
        let mut value = json!([self.is_error, self.result]);
        value.sort_all_objects();
        Sha256::digest(serde_json::to_vec(&value).expect("tool results serialize")).into()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ResumeLoopRequest {
    #[serde(rename = "loopId")]
    pub loop_id: String,
    #[serde(flatten)]
    pub request: AgentLoopRequest,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StepContextRequest {
    pub loop_id: String,
    pub context_id: String,
    pub system_prompt: String,
    pub tools: Vec<Value>,
    /// Fully reconstructed checkpoint + live tail, already budget-checked by
    /// the host against this session's durable history. No historical replay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<Vec<Value>>,
    #[serde(default)]
    pub execution_context: Option<ExecutionLease>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
enum Phase {
    Prepare {
        step: u32,
    },
    Context {
        step: u32,
        context_id: String,
    },
    Model {
        step: u32,
        attempt: u32,
    },
    Compact {
        step: u32,
        plan: Compaction,
    },
    Tools {
        step: u32,
        calls: Vec<String>,
    },
    Finish {
        step: u32,
        #[serde(default)]
        disposition: Option<Disposition>,
    },
}

#[derive(Clone, Serialize, Deserialize)]
struct ToolArgumentRetry {
    attempt: u32,
    error: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct ModelRetry {
    attempt: u32,
    reason: String,
    error: String,
}

#[derive(Clone)]
struct ExecutionState {
    initial_hash: String,
    request: AgentLoopRequest,
    phase: Phase,
    pending: HashSet<String>,
    results: HashMap<String, ToolResultRequest>,
    call_tools: HashMap<String, String>,
    step_context: Option<StepContextRequest>,
    compacted_step: Option<u32>,
    context_repair_step: Option<u32>,
    context_correction: Option<String>,
    tool_argument_retry: Option<ToolArgumentRetry>,
    model_retry: Option<ModelRetry>,
    sequence: u64,
    terminal_at: Option<u64>,
    cancel_requested: bool,
}

struct LoopState {
    execution: ExecutionState,
    events: VecDeque<LoopEvent>,
    acknowledged: u64,
    pending_bytes: usize,
    terminal_results: HashMap<String, [u8; 32]>,
    running: bool,
    failure: Option<String>,
}

/// Encode once for delivery and reconnect. Avoid a JSON object tree per token.
#[derive(Clone)]
struct LoopEvent {
    sequence: u64,
    bytes: Arc<[u8]>,
}

impl LoopEvent {
    fn encode(loop_id: &str, sequence: u64, mut value: Value) -> Result<Self, LoopError> {
        let object = value.as_object_mut().ok_or("invalid loop event")?;
        object.insert("loopId".into(), json!(loop_id));
        object.insert("sequence".into(), json!(sequence));
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        Ok(Self {
            sequence,
            bytes: bytes.into(),
        })
    }
}

impl LoopState {
    fn check_cursor(&self, after: u64) -> Result<(), LoopError> {
        if after < self.acknowledged {
            return Err("event cursor expired: output was already acknowledged by the host".into());
        }
        if after > self.execution.sequence {
            return Err("event cursor is ahead of the loop".into());
        }
        Ok(())
    }

    fn acknowledge(&mut self, through: u64) -> Result<(), LoopError> {
        if through <= self.acknowledged {
            return Ok(());
        }
        self.check_cursor(through)?;
        while self
            .events
            .front()
            .is_some_and(|event| event.sequence <= through)
        {
            self.pending_bytes -= self.events.pop_front().unwrap().bytes.len();
        }
        self.acknowledged = through;
        Ok(())
    }
}

struct LoopHandle {
    id: String,
    store: Option<Arc<HotStore>>,
    router: Option<Arc<SessionShardRouter>>,
    state: Mutex<LoopState>,
    changed: watch::Sender<u64>,
    cancel: watch::Sender<bool>,
}

impl LoopHandle {
    /// Publish process-local state; the host acknowledges durable transcript
    /// writes independently. A restarted executor never reloads this state.
    async fn commit(
        &self,
        state: &mut LoopState,
        mut next: ExecutionState,
        events: Vec<Value>,
        terminal: bool,
    ) -> Result<(), LoopError> {
        if let Some(error) = &state.failure {
            return Err(error.clone().into());
        }
        let mut published = Vec::with_capacity(events.len());
        let mut pending_bytes = state.pending_bytes;
        for event in events {
            next.sequence += 1;
            let event = LoopEvent::encode(&self.id, next.sequence, event)?;
            pending_bytes += event.bytes.len();
            if !terminal && pending_bytes > MAX_PENDING_EVENT_BYTES {
                return Err("agent loop pending event capacity exceeded".into());
            }
            published.push(event);
        }
        if terminal {
            next.terminal_at = Some(now_ms());
        }
        state.execution = next;
        state.pending_bytes = pending_bytes;
        state.events.extend(published);
        self.changed.send_modify(|revision| *revision += 1);
        Ok(())
    }

    async fn emit(&self, event: Value, terminal: bool) -> Result<(), LoopError> {
        let mut state = self.state.lock().await;
        if state.execution.terminal_at.is_some() {
            return Err("agent loop is already terminal".into());
        }
        if let Some(error) = &state.failure {
            return Err(error.clone().into());
        }
        // Stream events are emitted for every provider delta. Do not route
        // this through `commit`: cloning `ExecutionState` also clones the
        // complete provider prompt, tool definitions and accumulated tool
        // results. With a long prompt, five concurrent sessions turn a small
        // delta into a large transient allocation on every token.
        let sequence = state.execution.sequence + 1;
        let event = LoopEvent::encode(&self.id, sequence, event)?;
        let pending_bytes = state.pending_bytes + event.bytes.len();
        if !terminal && pending_bytes > MAX_PENDING_EVENT_BYTES {
            return Err("agent loop pending event capacity exceeded".into());
        }
        state.execution.sequence = sequence;
        state.pending_bytes = pending_bytes;
        if terminal {
            state.execution.terminal_at = Some(now_ms());
        }
        state.events.push_back(event);
        self.changed.send_modify(|revision| *revision += 1);
        Ok(())
    }
}

pub(crate) struct LoopSubscription {
    handle: Arc<LoopHandle>,
    changed: watch::Receiver<u64>,
    cursor: u64,
}
impl LoopSubscription {
    pub(crate) async fn next(&mut self) -> Result<Option<Arc<[u8]>>, LoopError> {
        loop {
            {
                let state = self.handle.state.lock().await;
                state.check_cursor(self.cursor)?;
                let offset = (self.cursor - state.acknowledged) as usize;
                if let Some(event) = state.events.get(offset) {
                    self.cursor = event.sequence;
                    return Ok(Some(event.bytes.clone()));
                }
                if let Some(error) = &state.failure {
                    return Err(error.clone().into());
                }
                if state.execution.terminal_at.is_some() {
                    return Ok(None);
                }
            }
            self.changed.changed().await?;
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct AgentLoopManager {
    loops: Arc<Mutex<HashMap<String, Arc<LoopHandle>>>>,
    store: Option<Arc<HotStore>>,
    router: Option<Arc<SessionShardRouter>>,
}
impl AgentLoopManager {
    pub(crate) async fn check_resource(
        &self,
        context: &ExecutionLease,
    ) -> Result<String, LoopError> {
        let router = self
            .router
            .as_ref()
            .ok_or("execution authority is unavailable")?;
        router
            .control_command(
                context.session_id.clone(),
                Uuid::new_v4().to_string(),
                0,
                0,
                "execution_check".into(),
                serde_json::to_vec(context)?,
            )
            .await?;
        let mut root = context.session_id.clone();
        let mut seen = HashSet::new();
        loop {
            if !seen.insert(root.clone()) || seen.len() > 64 {
                return Err("invalid session ancestry".into());
            }
            let snapshot: Value =
                serde_json::from_slice(&router.ui_snapshot(root.clone(), None).await?)?;
            let Some(parent) = snapshot["session"]["parentSessionId"].as_str() else {
                return Ok(root);
            };
            root = parent.to_owned();
        }
    }
    pub(crate) fn new(store: Option<Arc<HotStore>>) -> Self {
        Self {
            store,
            ..Self::default()
        }
    }
    pub(crate) fn with_router(mut self, router: Arc<SessionShardRouter>) -> Self {
        self.router = Some(router);
        self
    }

    async fn get(&self, id: &str) -> Result<Arc<LoopHandle>, LoopError> {
        self.loops.lock().await.get(id).cloned()
            .ok_or_else(|| "RUN_INTERRUPTED: execution is no longer available; continue the conversation in a new run".into())
    }

    fn launch(handle: Arc<LoopHandle>) {
        let span = tracing::error_span!("agent_loop", loop_id = %handle.id,
            session_id = tracing::field::Empty, run_id = tracing::field::Empty,
            step = tracing::field::Empty, phase = tracing::field::Empty);
        tokio::spawn(
            async move {
                let started = std::time::Instant::now();
                {
                    let state = handle.state.lock().await;
                    if let Some(binding) = &state.execution.request.runtime_binding {
                        tracing::Span::current().record("session_id", &binding.session_id);
                        tracing::Span::current().record("run_id", &binding.run_id);
                    }
                }
                tracing::info!(event = "agent.started", "Agent loop executor started");
                let outcome = match run_loop(&handle).await {
                    Ok(LoopFinish::Done(steps, disposition)) => {
                        tracing::info!(
                            event = "agent.completed",
                            steps,
                            status = disposition.as_ref().map(|d| d.status.as_str()),
                            reason = disposition.as_ref().map(|d| d.reason.as_str()),
                            duration_ms = started.elapsed().as_millis() as u64,
                            "Agent loop completed"
                        );
                        json!({"type":"done","steps":steps,"disposition":disposition})
                    }
                    Ok(LoopFinish::Cancelled) => {
                        tracing::info!(
                            event = "agent.cancelled",
                            duration_ms = started.elapsed().as_millis() as u64,
                            "Agent loop cancelled"
                        );
                        json!({"type":"cancelled"})
                    }
                    Err(error) => {
                        tracing::error!(
                            event = "agent.failed",
                            error_kind = crate::logging::error_kind(error.as_ref()),
                            duration_ms = started.elapsed().as_millis() as u64,
                            "Agent loop failed"
                        );
                        json!({"type":"error","error":error.to_string()})
                    }
                };
                if let Err(error) = handle.emit(outcome, true).await {
                    tracing::error!(
                        event = "agent.terminal_commit_failed",
                        error_kind = crate::logging::error_kind(error.as_ref()),
                        "Could not persist terminal agent state"
                    );
                }
                let mut state = handle.state.lock().await;
                state.running = false;
                // A terminal loop is retained briefly for idempotent replay, but
                // it no longer needs the full prompt, tool schema or tool-result
                // map. Keeping those roots for the retention window makes finished
                // sessions look like active sessions in the heap profile.
                state.execution.request.provider.prompt.clear();
                state.execution.request.provider.tools.clear();
                state.execution.request.provider.provider_options = Value::Null;
                state.execution.request.provider.response_options = Value::Null;
                state.execution.request.provider.cache_policy = Value::Null;
                state.execution.request.provider.headers.clear();
                state.execution.request.provider.api_key = None;
                state.execution.step_context = None;
                state.execution.pending.clear();
                state.terminal_results = state
                    .execution
                    .results
                    .iter()
                    .map(|(id, result)| (id.clone(), result.fingerprint()))
                    .collect();
                state.execution.results.clear();
                state.execution.call_tools.clear();
                state.execution.tool_argument_retry = None;
                handle.changed.send_modify(|revision| *revision += 1);
            }
            .instrument(span),
        );
    }

    pub(crate) async fn start(&self, request: AgentLoopRequest) -> Result<String, LoopError> {
        if let Some(policy) = &request.context_policy {
            policy.validate()?;
        }
        if request
            .request_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 256)
        {
            return Err("requestId must contain 1 to 256 bytes".into());
        }
        let initial_hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&request)?));
        let id = request
            .request_id
            .as_ref()
            .map(|key| format!("aloop_{:x}", Sha256::digest(key.as_bytes())))
            .unwrap_or_else(|| format!("aloop_{}", Uuid::new_v4().simple()));
        let mut loops = self.loops.lock().await;
        let existing = loops.get(&id).cloned();
        if let Some(handle) = existing {
            let mut state = handle.state.lock().await;
            if state.execution.initial_hash != initial_hash {
                return Err("requestId was already used for different loop input".into());
            }
            let next = state.execution.clone();
            handle.commit(&mut state, next, Vec::new(), false).await?;
            let launch = !state.running && state.execution.terminal_at.is_none();
            if launch {
                state.execution.request.provider.api_key = request.provider.api_key;
                state.execution.request.provider.headers = request.provider.headers;
                state.running = true;
            }
            drop(state);
            loops.insert(id.clone(), handle.clone());
            if launch {
                Self::launch(handle);
            }
            return Ok(id);
        }
        let mut expired = Vec::new();
        let mut active = 0;
        for (id, handle) in loops.iter() {
            match handle.state.lock().await.execution.terminal_at {
                Some(at) if now_ms().saturating_sub(at) > TERMINAL_RETENTION_MS => {
                    expired.push(id.clone())
                }
                None => active += 1,
                _ => {}
            }
        }
        for id in expired {
            loops.remove(&id);
        }
        if active >= MAX_ACTIVE_LOOPS {
            return Err("agent loop capacity reached".into());
        }
        if let Some(store) = &self.store {
            if !store.claim_agent_loop(
                &id,
                &initial_hash,
                request.request_id.as_deref(),
                request
                    .runtime_binding
                    .as_ref()
                    .map(|binding| binding.run_id.as_str()),
            )? {
                return Err(
                    "RUN_INTERRUPTED: this request was already accepted by a previous execution"
                        .into(),
                );
            }
        }
        let (changed, _) = watch::channel(0);
        let (cancel, _) = watch::channel(false);
        let initial_phase = next_phase(&request, 1);
        let handle = Arc::new(LoopHandle {
            id: id.clone(),
            store: self.store.clone(),
            router: self.router.clone(),
            changed,
            cancel,
            state: Mutex::new(LoopState {
                execution: ExecutionState {
                    initial_hash,
                    request,
                    phase: initial_phase,
                    pending: HashSet::new(),
                    results: HashMap::new(),
                    call_tools: HashMap::new(),
                    step_context: None,
                    compacted_step: None,
                    context_repair_step: None,
                    context_correction: None,
                    tool_argument_retry: None,
                    model_retry: None,
                    sequence: 0,
                    terminal_at: None,
                    cancel_requested: false,
                },
                events: VecDeque::new(),
                acknowledged: 0,
                pending_bytes: 0,
                terminal_results: HashMap::new(),
                running: true,
                failure: None,
            }),
        });
        handle.emit(json!({"type":"loop-started"}), false).await?;
        loops.insert(id.clone(), handle.clone());
        Self::launch(handle);
        Ok(id)
    }

    /// Restart execution only on explicit host resumption. Credentials are
    /// reattached here and are never serialized into the loop execution.
    pub(crate) async fn check(
        &self,
        id: &str,
        context: Option<&ExecutionLease>,
    ) -> Result<(), LoopError> {
        let handle = self.get(id).await?;
        check_execution(&handle, context).await?;
        if handle.state.lock().await.execution.terminal_at.is_some() {
            return Err("RUN_INTERRUPTED: execution has already ended".into());
        }
        Ok(())
    }

    pub(crate) async fn resume(&self, input: ResumeLoopRequest) -> Result<(), LoopError> {
        let handle = self.get(&input.loop_id).await?;
        check_execution(&handle, input.request.execution_context.as_ref()).await?;
        let mut state = handle.state.lock().await;
        let saved = &state.execution.request.provider;
        let supplied = input.request.provider;
        if state.execution.request.runtime_binding != input.request.runtime_binding
            || saved.api_format != supplied.api_format
            || saved.base_url != supplied.base_url
            || saved.model != supplied.model
        {
            return Err("resumed provider configuration does not match the loop".into());
        }
        if state.execution.terminal_at.is_some() {
            return Ok(());
        }
        if let Some(error) = &state.failure {
            return Err(error.clone().into());
        }
        let mut next = state.execution.clone();
        next.request.execution_context = input.request.execution_context;
        next.request.provider.api_key = supplied.api_key;
        next.request.provider.headers = supplied.headers;
        handle.commit(&mut state, next, Vec::new(), false).await?;
        if state.running {
            return Ok(());
        }
        state.running = true;
        drop(state);
        tracing::info!(event = "agent.resumed", loop_id = %input.loop_id, "Agent loop resumed");
        Self::launch(handle);
        Ok(())
    }

    pub(crate) async fn subscribe_events(
        &self,
        id: &str,
        after: u64,
    ) -> Result<LoopSubscription, LoopError> {
        let handle = self.get(id).await?;
        let changed = handle.changed.subscribe();
        handle.state.lock().await.check_cursor(after)?;
        Ok(LoopSubscription {
            handle,
            changed,
            cursor: after,
        })
    }

    pub(crate) async fn acknowledge_events(
        &self,
        id: &str,
        through: u64,
        context: Option<&ExecutionLease>,
    ) -> Result<(), LoopError> {
        let handle = self.get(id).await?;
        let mut state = handle.state.lock().await;
        // Delivery may be acknowledged after execution ends. Match its owner
        // directly; an execution_check would reject a completed run's final ACK.
        if let Some(expected) = &state.execution.request.execution_context {
            if context.is_none_or(|context| !expected.same_owner(context)) {
                return Err("event acknowledgement requires the execution owner".into());
            }
        }
        state.acknowledge(through)
    }

    pub(crate) async fn send_tool_result(
        &self,
        request: ToolResultRequest,
    ) -> Result<(), LoopError> {
        let handle = self.get(&request.loop_id).await?;
        check_execution(&handle, request.execution_context.as_ref()).await?;
        let mut state = handle.state.lock().await;
        if let Some(saved) = state.terminal_results.get(&request.tool_call_id) {
            return if saved == &request.fingerprint() {
                Ok(())
            } else {
                Err("conflicting tool result".into())
            };
        }
        let mut next = state.execution.clone();
        let tool_call_id = request.tool_call_id.clone();
        let is_error = request.is_error;
        if let Some(previous) = next.results.get(&request.tool_call_id) {
            // Even duplicate acknowledgements go through the WAL barrier.
            if previous.result != request.result || previous.is_error != request.is_error {
                return Err("conflicting tool result".into());
            }
        } else {
            if next.terminal_at.is_some() || next.cancel_requested {
                return Err("agent loop is closed".into());
            }
            if !next.pending.remove(&request.tool_call_id) {
                return Err("unknown or unrequested tool call".into());
            }
            next.request.execution_context = request.execution_context.clone();
            next.results.insert(request.tool_call_id.clone(), request);
        }
        handle.commit(&mut state, next, Vec::new(), false).await?;
        tracing::info!(event = "agent.tool_result", loop_id = %handle.id, tool_call_id,
            is_error, "Tool result committed");
        Ok(())
    }

    pub(crate) async fn set_context(&self, input: StepContextRequest) -> Result<(), LoopError> {
        let handle = self.get(&input.loop_id).await?;
        check_execution(&handle, input.execution_context.as_ref()).await?;
        let mut state = handle.state.lock().await;
        let mut next = state.execution.clone();
        if let Some(previous) = &next.step_context {
            if previous.context_id == input.context_id {
                if previous.system_prompt != input.system_prompt || previous.tools != input.tools || previous.prompt != input.prompt {
                    return Err("conflicting step context".into());
                }
                return handle.commit(&mut state, next, Vec::new(), false).await;
            }
        }
        if !matches!(&next.phase, Phase::Context { context_id, .. } if context_id == &input.context_id)
            || next.terminal_at.is_some()
            || next.cancel_requested
        {
            return Err("step context is not pending".into());
        }
        next.step_context = Some(input);
        handle.commit(&mut state, next, Vec::new(), false).await
    }

    pub(crate) async fn cancel(&self, id: &str) -> Result<(), LoopError> {
        tracing::info!(
            event = "agent.cancel_requested",
            loop_id = id,
            "Agent loop cancellation requested"
        );
        let handle = self.get(id).await?;
        let mut changed = handle.changed.subscribe();
        {
            let mut state = handle.state.lock().await;
            if state.execution.terminal_at.is_some() {
                return Ok(());
            }
            let mut next = state.execution.clone();
            next.cancel_requested = true;
            let running = state.running;
            handle
                .commit(
                    &mut state,
                    next,
                    if running {
                        Vec::new()
                    } else {
                        vec![json!({"type":"cancelled"})]
                    },
                    !running,
                )
                .await?;
            handle.cancel.send_replace(true);
        }
        loop {
            {
                let state = handle.state.lock().await;
                if let Some(error) = &state.failure {
                    return Err(error.clone().into());
                }
                if state.execution.terminal_at.is_some() && !state.running {
                    return Ok(());
                }
            }
            changed.changed().await?;
        }
    }

    pub(crate) async fn shutdown(&self) {
        let ids: Vec<_> = self.loops.lock().await.keys().cloned().collect();
        for id in ids {
            let _ = self.cancel(&id).await;
        }
    }
}

async fn check_execution(
    handle: &LoopHandle,
    context: Option<&ExecutionLease>,
) -> Result<(), LoopError> {
    let expected = handle
        .state
        .lock()
        .await
        .execution
        .request
        .execution_context
        .clone();
    if expected.is_some() && context.is_none() {
        return Err("execution context is required".into());
    }
    let Some(context) = context else {
        return Ok(());
    };
    let binding = handle
        .state
        .lock()
        .await
        .execution
        .request
        .runtime_binding
        .clone()
        .ok_or("execution context requires a runtime binding")?;
    if binding.session_id != context.session_id || binding.run_id != context.run_id {
        return Err("execution context does not match runtime binding".into());
    }
    let router = handle
        .router
        .as_ref()
        .ok_or("execution authority is unavailable")?;
    router
        .control_command(
            context.session_id.clone(),
            Uuid::new_v4().to_string(),
            0,
            0,
            "execution_check".into(),
            serde_json::to_vec(context)?,
        )
        .await?;
    Ok(())
}

fn next_phase(request: &AgentLoopRequest, step: u32) -> Phase {
    if request.runtime_binding.is_some() {
        Phase::Prepare { step }
    } else {
        Phase::Model { step, attempt: 0 }
    }
}

async fn runtime_facts(
    handle: &LoopHandle,
    request: &AgentLoopRequest,
) -> Result<Option<(Value, Value, Value)>, LoopError> {
    let Some(binding) = &request.runtime_binding else {
        return Ok(None);
    };
    let store = handle
        .store
        .as_ref()
        .ok_or("native loop requires durable runtime storage")?;
    let snapshot: Value = serde_json::from_slice(
        &store
            .ui_snapshot(&binding.session_id, None)
            .map_err(|error| error.to_string())?,
    )?;
    let session = snapshot["session"].clone();
    let run = snapshot["run"].clone();
    if run["id"] != binding.run_id || run["sessionId"] != binding.session_id {
        return Err("native loop's run has been replaced".into());
    }
    let mut root = session.clone();
    let mut visited = HashSet::new();
    while let Some(parent) = root["parentSessionId"].as_str().map(str::to_owned) {
        if !visited.insert(parent.clone()) || visited.len() > 64 {
            return Err("invalid runtime parent chain".into());
        }
        let snapshot: Value = serde_json::from_slice(&store.ui_snapshot(&parent, None)?)?;
        root = snapshot["session"].clone();
    }
    Ok(Some((session, root, run)))
}

enum LoopFinish {
    Done(u32, Option<Disposition>),
    Cancelled,
}

async fn run_loop(handle: &LoopHandle) -> Result<LoopFinish, LoopError> {
    let mut cancel = handle.cancel.subscribe();
    loop {
        let execution = handle.state.lock().await.execution.clone();
        if execution.cancel_requested {
            return Ok(LoopFinish::Cancelled);
        }
        let (step, phase) = match &execution.phase {
            Phase::Prepare { step } => (*step, "prepare"),
            Phase::Context { step, .. } => (*step, "context"),
            Phase::Model { step, .. } => (*step, "model"),
            Phase::Compact { step, .. } => (*step, "compact"),
            Phase::Tools { step, .. } => (*step, "tools"),
            Phase::Finish { step, .. } => (*step, "finish"),
        };
        tracing::Span::current().record("step", step);
        tracing::Span::current().record("phase", phase);
        tracing::info!(event = "agent.phase", step, phase, "Agent phase entered");
        match execution.phase {
            Phase::Prepare { step } => {
                if let Some((session, root, run)) =
                    runtime_facts(handle, &execution.request).await?
                {
                    if let Decision::Finish(disposition) =
                        loop_policy::before_model(&session, &root, &run)
                    {
                        let mut state = handle.state.lock().await;
                        let mut next = state.execution.clone();
                        next.phase = Phase::Finish {
                            step: step.saturating_sub(1),
                            disposition: Some(disposition),
                        };
                        handle.commit(&mut state, next, Vec::new(), false).await?;
                        continue;
                    }
                }
                let context_id = format!("{}:{step}", handle.id);
                let mut state = handle.state.lock().await;
                let mut next = state.execution.clone();
                next.phase = Phase::Context {
                    step,
                    context_id: context_id.clone(),
                };
                next.step_context = None;
                handle
                    .commit(
                        &mut state,
                        next,
                        vec![json!({"type":"context-request","contextId":context_id,"step":step,"contextCorrection":execution.context_correction})],
                        false,
                    )
                    .await?;
            }
            Phase::Context { step, context_id } => {
                let mut changed = handle.changed.subscribe();
                let prepared = loop {
                    let state = handle.state.lock().await;
                    if state.execution.cancel_requested {
                        return Ok(LoopFinish::Cancelled);
                    }
                    if let Some(error) = &state.failure {
                        return Err(error.clone().into());
                    }
                    if let Some(context) = &state.execution.step_context {
                        if context.context_id == context_id {
                            break context.clone();
                        }
                    }
                    drop(state);
                    changed.changed().await?;
                };
                let mut state = handle.state.lock().await;
                let mut next = state.execution.clone();
                if let Some(prompt) = prepared.prompt {
                    next.request.provider.prompt = prompt;
                    next.compacted_step = Some(step);
                }
                next.request
                    .provider
                    .prompt
                    .retain(|message| message["role"] != "system");
                next.request
                    .provider
                    .prompt
                    .insert(0, json!({"role":"system","content":prepared.system_prompt}));
                next.request.provider.tools = prepared.tools;
                next.phase = Phase::Model { step, attempt: 0 };
                handle.commit(&mut state, next, Vec::new(), false).await?;
            }

            Phase::Compact { step, mut plan } => {
                let policy = execution
                    .request
                    .context_policy
                    .as_ref()
                    .ok_or("missing compaction policy")?;
                if plan.offset == plan.source.len() {
                    let (prompt, composition) =
                        plan.complete(&execution.request.provider, policy)?;
                    let mut state = handle.state.lock().await;
                    let mut next = state.execution.clone();
                    next.request.provider.prompt = prompt;
                    next.compacted_step = Some(step);
                    next.phase = Phase::Model { step, attempt: 0 };
                    handle
                        .commit(
                            &mut state,
                            next,
                            vec![json!({"type":"context-compacted","step":step,
                        "originalTokens":plan.original_tokens,"compressedTokens":composition.total,
                        "messageCount":plan.message_count,"summary":plan.summary,
                        "composition":composition})],
                            false,
                        )
                        .await?;
                    continue;
                }
                plan.attempt += 1;
                let request_id = format!("{}:compact:{step}:{}", handle.id, plan.attempt);
                {
                    let mut state = handle.state.lock().await;
                    let mut next = state.execution.clone();
                    next.phase = Phase::Compact {
                        step,
                        plan: plan.clone(),
                    };
                    handle
                        .commit(
                            &mut state,
                            next,
                            vec![json!({"type":"compaction-call-started","step":step,
                        "requestId":request_id,"startedAt":chrono::Utc::now().to_rfc3339()})],
                            false,
                        )
                        .await?;
                }
                let (request, through) = plan.request(&execution.request.provider, policy)?;
                let mut stream = provider_events(request);
                let mut summary = String::new();
                let mut usage = Value::Null;
                let mut finish = None;
                loop {
                    let event = tokio::select! {
                        biased;
                        _ = async { cancel.wait_for(|requested| *requested).await.map(|_| ()) } => return Ok(LoopFinish::Cancelled),
                        event = stream.next() => event,
                    };
                    let Some(event) = event else {
                        break;
                    };
                    let event = event?;
                    match event["type"].as_str() {
                        Some("text-delta") => {
                            summary.push_str(event["delta"].as_str().unwrap_or_default())
                        }
                        Some("usage") => {
                            usage = event["usage"].clone();
                            handle.emit(json!({"type":"compaction-usage","step":step,"chunk":plan.chunk + 1,
                                "requestId":request_id,"usage":usage}), false).await?;
                        }
                        Some("tool-call") => {
                            return Err("compaction unexpectedly requested a tool".into());
                        }
                        Some("finish") => {
                            finish = event["finishReason"].as_str().map(str::to_owned)
                        }
                        _ => {}
                    }
                }
                if summary.trim().is_empty() || finish.as_deref() != Some("stop") {
                    return Err("context compaction did not produce a complete execution".into());
                }
                if loop_context::tokens(&summary) > plan.summary_tokens {
                    return Err("context compaction exceeded its output budget".into());
                }
                plan.summary = summary;
                plan.offset = through;
                plan.chunk += 1;
                let mut state = handle.state.lock().await;
                let mut next = state.execution.clone();
                let event = json!({"type":"compaction-call-finished","step":step,
                    "chunk":plan.chunk,"requestId":request_id,"usage":usage});
                next.phase = Phase::Compact { step, plan };
                handle.commit(&mut state, next, vec![event], false).await?;
            }
            Phase::Finish { step, disposition } => return Ok(LoopFinish::Done(step, disposition)),
            Phase::Model { step, attempt } => {
                let mut model_request = execution.request.provider.clone();
                if let Some((session, root, run)) =
                    runtime_facts(handle, &execution.request).await?
                {
                    model_request.cache_policy["rootSessionId"] = root["id"].clone();
                    if let Decision::Finish(disposition) =
                        loop_policy::before_model(&session, &root, &run)
                    {
                        let mut state = handle.state.lock().await;
                        let mut next = state.execution.clone();
                        next.phase = Phase::Finish {
                            step: step.saturating_sub(1),
                            disposition: Some(disposition),
                        };
                        handle.commit(&mut state, next, Vec::new(), false).await?;
                        continue;
                    }
                }
                if attempt == 0 {
                    if let Some(policy) = &execution.request.context_policy {
                        let action = if execution.compacted_step == Some(step) {
                            let composition =
                                loop_context::composition(&execution.request.provider)?;
                            if composition.total > policy.input_budget() {
                                return Err(
                                    "context_blocked: compacted request exceeds budget".into()
                                );
                            }
                            ContextAction::Ready(composition)
                        } else {
                            loop_context::plan(&execution.request.provider, policy)?
                        };
                        match action {
                            ContextAction::Ready(composition) => {
                                handle.emit(json!({"type":"context-composition","step":step,"composition":composition}), false).await?;
                            }
                            ContextAction::Compact(plan) => {
                                let event = json!({"type":"context-compaction-started","step":step,"originalTokens":plan.original_tokens,"source":plan.source});
                                let mut state = handle.state.lock().await;
                                let mut next = state.execution.clone();
                                next.phase = Phase::Compact { step, plan };
                                handle.commit(&mut state, next, vec![event], false).await?;
                                continue;
                            }
                        }
                    }
                }
                {
                    let mut state = handle.state.lock().await;
                    let mut next = state.execution.clone();
                    next.phase = Phase::Model {
                        step,
                        attempt: attempt + 1,
                    };
                    let mut event = json!({"type":if attempt == 0 { "step-started" } else { "step-restarted" },"step":step,"attempt":attempt + 1});
                    if let Some(retry) = &next.tool_argument_retry {
                        event["reason"] = json!("invalid_tool_arguments");
                        event["error"] = json!(retry.error);
                        event["attempt"] = json!(retry.attempt);
                        event["maxRetries"] = json!(MAX_TOOL_ARGUMENT_RETRIES);
                    } else if let Some(retry) = &next.model_retry {
                        event["reason"] = json!(retry.reason);
                        event["error"] = json!(retry.error);
                        event["attempt"] = json!(retry.attempt);
                        event["maxRetries"] = json!(MAX_MODEL_RETRIES);
                    }
                    handle.commit(&mut state, next, vec![event], false).await?;
                }
                let mut events = provider_events(model_request);
                check_execution(handle, execution.request.execution_context.as_ref()).await?;
                let mut lease_tick = tokio::time::interval(std::time::Duration::from_millis(500));
                let mut calls = Vec::new();
                let mut assistant = None;
                let mut final_events = Vec::new();
                let mut argument_error = None;
                let mut failure = None;
                // Any event the host already received makes this attempt
                // unrepeatable: replaying it would duplicate visible output.
                let mut delivered = false;
                loop {
                    let event = tokio::select! {
                        biased;
                        _ = async { cancel.wait_for(|requested| *requested).await.map(|_| ()) } => return Ok(LoopFinish::Cancelled),
                        _ = lease_tick.tick() => {
                            let context = handle.state.lock().await.execution.request.execution_context.clone();
                            check_execution(handle, context.as_ref()).await?;
                            continue;
                        },
                        event = events.next() => event,
                    };
                    let Some(event) = event else {
                        break;
                    };
                    let mut event = match event {
                        Ok(event) => event,
                        Err(error) if error.is::<InvalidToolArguments>() => {
                            argument_error = Some(error);
                            break;
                        }
                        Err(error) => {
                            failure = Some(error);
                            break;
                        }
                    };
                    event["step"] = json!(step);
                    match event["type"].as_str() {
                        Some("assistant-message") => {
                            assistant = event.get("message").cloned();
                            final_events.push(event);
                        }
                        Some("tool-call") => {
                            calls.push(
                                event["toolCallId"]
                                    .as_str()
                                    .ok_or("missing tool call ID")?
                                    .to_owned(),
                            );
                            final_events.push(event);
                        }
                        Some("finish") => final_events.push(event),
                        // Only conversation deltas are unrepeatable. Telemetry
                        // (usage, raw protocol frames) and the buffered final
                        // events of a failed attempt are dropped with it.
                        Some("text-delta" | "reasoning-delta") => {
                            delivered = true;
                            handle.emit(event, false).await?
                        }
                        _ => handle.emit(event, false).await?,
                    }
                }
                if let Some(error) = failure {
                    drop(events);
                    let message = error.to_string().to_ascii_lowercase();
                    let context_overflow = ["context_length_exceeded", "maximum context length", "prompt is too long", "input is too long"]
                        .iter().any(|text| message.contains(text));
                    if !delivered && context_overflow && execution.context_repair_step != Some(step)
                        && execution.request.provider.max_retries != Some(0) && execution.request.runtime_binding.is_some()
                    {
                        if let Some(policy) = execution.request.context_policy.as_ref() {
                            let budget = policy.input_budget() * 3 / 4;
                            let context_id = format!("{}:{step}:budget-repair", handle.id);
                            let mut state = handle.state.lock().await;
                            let mut next = state.execution.clone();
                            next.context_repair_step = Some(step);
                            next.request.context_policy.as_mut().unwrap().input_limit = Some(budget);
                            next.step_context = None;
                            next.phase = Phase::Context { step, context_id: context_id.clone() };
                            handle.commit(&mut state, next, vec![json!({"type":"context-request","step":step,
                                "contextId":context_id,"inputBudget":budget,"reason":"provider-context-overflow","contextCorrection":execution.context_correction})], false).await?;
                            continue;
                        }
                    }
                    let retries = execution
                        .model_retry
                        .as_ref()
                        .map_or(0, |retry| retry.attempt);
                    // A retry is only honest while nothing reached the host: a
                    // delivered partial answer would be duplicated, and a
                    // caller that asked for `maxRetries: 0` wants no retries
                    // at any layer. Everything else transient is backed off
                    // before the session is allowed to fail.
                    let retries_disabled = execution.request.provider.max_retries == Some(0);
                    if delivered
                        || retries_disabled
                        || retries >= MAX_MODEL_RETRIES
                        || !crate::llm::retry::retryable_failure(error.as_ref())
                    {
                        return Err(error);
                    }
                    let delay = crate::llm::retry::retry_delay(retries as usize);
                    let reason = crate::llm::retry::failure_reason(error.as_ref());
                    let error_text = error.to_string();
                    tracing::warn!(
                        event = "agent.model_retry_scheduled",
                        step,
                        attempt = retries + 1,
                        max_retries = MAX_MODEL_RETRIES,
                        reason,
                        delay_ms = delay.as_millis() as u64,
                        error_kind = crate::logging::error_kind(error.as_ref()),
                        "Model step failed before delivering content; backing off"
                    );
                    {
                        let mut state = handle.state.lock().await;
                        let mut next = state.execution.clone();
                        next.model_retry = Some(ModelRetry {
                            attempt: retries + 1,
                            reason: reason.to_owned(),
                            error: error_text.chars().take(1000).collect(),
                        });
                        next.phase = Phase::Model {
                            step,
                            attempt: attempt + 1,
                        };
                        let retry = json!({"reason":reason,"phase":"waiting","group":1,
                            "attempt":retries + 1,"maxRetries":MAX_MODEL_RETRIES,
                            "nextRetryAt":chrono::Utc::now().timestamp_millis() + delay.as_millis() as i64,
                            "error":error_text.chars().take(1000).collect::<String>()});
                        handle
                            .commit(
                                &mut state,
                                next,
                                vec![json!({"type":"retry_status","step":step,"retry":retry})],
                                false,
                            )
                            .await?;
                    }
                    // Dropping the failed stream released its body; the sleep
                    // is cancelled with the loop, never left behind.
                    tokio::select! {
                        biased;
                        _ = async { cancel.wait_for(|requested| *requested).await.map(|_| ()) } => return Ok(LoopFinish::Cancelled),
                        _ = tokio::time::sleep(delay) => {}
                    }
                    continue;
                }
                if let Some(error) = argument_error {
                    let retries = execution
                        .tool_argument_retry
                        .as_ref()
                        .map_or(0, |retry| retry.attempt);
                    if retries >= MAX_TOOL_ARGUMENT_RETRIES {
                        return Err(error);
                    }
                    let reason = format!(
                        "{error}. No tools from this response were executed. Retry the intended tool calls using a complete JSON object matching each tool's schema, with properly escaped strings and no Markdown fences. If the response was truncated, use smaller calls."
                    );
                    let mut state = handle.state.lock().await;
                    let mut next = state.execution.clone();
                    next.tool_argument_retry = Some(ToolArgumentRetry {
                        attempt: retries + 1,
                        error: error.to_string(),
                    });
                    // Persist the correction and retry budget together. The
                    // rejected assistant/tool batch is never added to history.
                    next.request
                        .provider
                        .prompt
                        .push(json!({"role":"user","content":[{"type":"text","text":reason}]}));
                    handle
                        .commit(
                            &mut state,
                            next,
                            vec![json!({"type":"policy-correction","step":step,"reason":reason})],
                            false,
                        )
                        .await?;
                    continue;
                }
                let assistant =
                    assistant.ok_or("provider response is missing assistant content")?;
                let final_text = assistant["content"]
                    .as_array()
                    .map(|parts| {
                        parts
                            .iter()
                            .filter(|part| part["type"] == "text")
                            .filter_map(|part| part["text"].as_str())
                            .collect::<String>()
                    })
                    .unwrap_or_default();
                let decision = if calls.is_empty() {
                    match runtime_facts(handle, &execution.request).await? {
                        Some((session, root, run)) => {
                            loop_policy::final_answer(&session, &root, &run, &final_text)
                        }
                        None => Decision::Finish(Disposition {
                            status: "completed".into(),
                            reason: "completed".into(),
                            summary: final_text,
                        }),
                    }
                } else {
                    Decision::Continue
                };
                let invalid_batch = loop_policy::validate_tool_batch(&final_events);
                let mut state = handle.state.lock().await;
                let mut next = state.execution.clone();
                next.tool_argument_retry = None;
                next.context_correction = None;
                if let Some(retry) = next.model_retry.take() {
                    final_events.push(json!({"type":"retry_status","step":step,"retry":{
                        "reason":retry.reason,"phase":"recovered","group":1,
                        "attempt":retry.attempt,"maxRetries":MAX_MODEL_RETRIES,
                        "nextRetryAt":Value::Null,"error":""}}));
                }
                next.request.provider.prompt.push(assistant);
                for call in final_events
                    .iter()
                    .filter(|event| event["type"] == "tool-call")
                {
                    let id = call["toolCallId"]
                        .as_str()
                        .ok_or("missing call identity")?
                        .to_owned();
                    if next.results.contains_key(&id) || next.pending.contains(&id) {
                        return Err(format!("provider reused tool call ID '{id}'").into());
                    }
                    next.call_tools.insert(
                        id.clone(),
                        call["toolName"].as_str().unwrap_or_default().into(),
                    );
                    if invalid_batch.is_none() {
                        next.pending.insert(id);
                    }
                }
                if let Some(error) = invalid_batch {
                    final_events.retain(|event| event["type"] != "tool-call");
                    let parts: Vec<_> = calls.iter().map(|id| json!({"type":"tool-result","toolCallId":id,"output":{"error":error},"isError":true})).collect();
                    next.request
                        .provider
                        .prompt
                        .push(json!({"role":"tool","content":parts}));
                    for id in &calls {
                        final_events.push(json!({"type":"tool-result","step":step,"toolCallId":id,"result":{"error":error},"isError":true}));
                    }
                    final_events
                        .push(json!({"type":"policy-correction","step":step,"reason":error}));
                    final_events.push(json!({"type":"step-completed","step":step}));
                    next.phase = next_phase(&next.request, step + 1);
                } else {
                    next.phase = match decision {
                        Decision::Continue => Phase::Tools { step, calls },
                        Decision::Finish(disposition) => {
                            final_events.push(json!({"type":"step-completed","step":step}));
                            Phase::Finish {
                                step,
                                disposition: Some(disposition),
                            }
                        }
                        Decision::Correct(reason) => {
                            next.context_correction = Some(reason.clone());
                            next.request.provider.prompt.push(
                                json!({"role":"user","content":[{"type":"text","text":reason}]}),
                            );
                            final_events.push(
                                json!({"type":"policy-correction","step":step,"reason":reason}),
                            );
                            final_events.push(json!({"type":"step-completed","step":step}));
                            next_phase(&next.request, step + 1)
                        }
                    };
                }
                handle.commit(&mut state, next, final_events, false).await?;
            }
            Phase::Tools { step, calls } => {
                let waiting = std::time::Instant::now();
                tracing::info!(
                    event = "agent.tools_waiting",
                    step,
                    tool_count = calls.len(),
                    "Waiting for tool results"
                );
                let mut changed = handle.changed.subscribe();
                let results = loop {
                    let ready = {
                        let state = handle.state.lock().await;
                        if let Some(error) = &state.failure {
                            return Err(error.clone().into());
                        }
                        if state.execution.cancel_requested {
                            return Ok(LoopFinish::Cancelled);
                        }
                        calls
                            .iter()
                            .map(|id| state.execution.results.get(id).cloned())
                            .collect::<Option<Vec<_>>>()
                    };
                    if let Some(results) = ready {
                        break results;
                    }
                    changed.changed().await?;
                };
                let mut parts = Vec::new();
                tracing::info!(
                    event = "agent.tools_ready",
                    step,
                    tool_count = results.len(),
                    duration_ms = waiting.elapsed().as_millis() as u64,
                    "Tool results ready"
                );
                let mut events = Vec::new();
                let mut disposition = None;
                for result in results {
                    if let Some(name) = execution.call_tools.get(&result.tool_call_id) {
                        disposition =
                            loop_policy::interaction_result(name, &result.result).or(disposition);
                    }
                    events.push(json!({"type":"tool-result","step":step,"toolCallId":result.tool_call_id,"result":result.result,"isError":result.is_error}));
                    parts.push(json!({"type":"tool-result","toolCallId":result.tool_call_id,"output":result.result,"isError":result.is_error}));
                }
                events.push(json!({"type":"step-completed","step":step}));
                let mut state = handle.state.lock().await;
                let mut next = state.execution.clone();
                next.request
                    .provider
                    .prompt
                    .push(json!({"role":"tool","content":parts}));
                next.phase = if let Some(disposition) = disposition {
                    Phase::Finish {
                        step,
                        disposition: Some(disposition),
                    }
                } else {
                    next_phase(&next.request, step + 1)
                };
                handle.commit(&mut state, next, events, false).await?;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> AgentLoopRequest {
        serde_json::from_value(json!({"apiFormat":"invalid","model":"test","maxSteps":1})).unwrap()
    }

    fn pending_loop(id: &str) -> Arc<LoopHandle> {
        let (changed, _) = watch::channel(0);
        let (cancel, _) = watch::channel(false);
        Arc::new(LoopHandle {
            id: id.into(),
            store: None,
            router: None,
            changed,
            cancel,
            state: Mutex::new(LoopState {
                execution: ExecutionState {
                    initial_hash: String::new(),
                    request: request(),
                    phase: Phase::Model {
                        step: 1,
                        attempt: 1,
                    },
                    pending: HashSet::new(),
                    results: HashMap::new(),
                    call_tools: HashMap::new(),
                    step_context: None,
                    compacted_step: None,
                    context_repair_step: None,
                    context_correction: None,
                    tool_argument_retry: None,
                    model_retry: None,
                    sequence: 0,
                    terminal_at: None,
                    cancel_requested: false,
                },
                events: VecDeque::new(),
                acknowledged: 0,
                pending_bytes: 0,
                terminal_results: HashMap::new(),
                running: true,
                failure: None,
            }),
        })
    }

    #[tokio::test]
    async fn acknowledgements_free_payloads_without_losing_pending_deliveries() {
        let loops = AgentLoopManager::default();
        let handle = pending_loop("pending");
        loops
            .loops
            .lock()
            .await
            .insert(handle.id.clone(), handle.clone());
        handle
            .emit(json!({"type":"text-delta","delta":"已处理"}), false)
            .await
            .unwrap();
        handle
            .emit(json!({"type":"tool-call","toolCallId":"permission"}), false)
            .await
            .unwrap();
        handle
            .emit(json!({"type":"tool-call","toolCallId":"next-tool"}), false)
            .await
            .unwrap();
        let released = Arc::downgrade(&handle.state.lock().await.events[0].bytes);
        let mut observer = loops.subscribe_events(&handle.id, 0).await.unwrap();
        let first: Value =
            serde_json::from_slice(&observer.next().await.unwrap().unwrap()).unwrap();
        assert_eq!(first["sequence"], 1);
        loops.acknowledge_events(&handle.id, 1, None).await.unwrap();
        loops.acknowledge_events(&handle.id, 1, None).await.unwrap();
        assert!(released.upgrade().is_none());
        assert!(loops.acknowledge_events(&handle.id, 4, None).await.is_err());
        assert!(loops.subscribe_events(&handle.id, 0).await.is_err());
        let boundary: Value =
            serde_json::from_slice(&observer.next().await.unwrap().unwrap()).unwrap();
        assert_eq!(boundary["toolCallId"], "permission");
        drop(observer);
        // Permission handling can close the stream before its generator ACKs.
        // Resume at the host's handled cursor, retaining the next tool request.
        loops.acknowledge_events(&handle.id, 2, None).await.unwrap();
        let mut resumed = loops.subscribe_events(&handle.id, 2).await.unwrap();
        let next: Value = serde_json::from_slice(&resumed.next().await.unwrap().unwrap()).unwrap();
        assert_eq!(next["toolCallId"], "next-tool");
        handle.emit(json!({"type":"done"}), true).await.unwrap();
        let final_event = resumed.next().await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&final_event).unwrap()["sequence"],
            4
        );
        assert!(resumed.next().await.unwrap().is_none());
        loops.acknowledge_events(&handle.id, 4, None).await.unwrap();
        let state = handle.state.lock().await;
        assert_eq!(state.pending_bytes, 0);
        assert!(state.events.is_empty());
    }

    #[tokio::test]
    async fn five_long_running_streams_retain_only_the_unacknowledged_batch() {
        let loops = AgentLoopManager::default();
        let mut handles = Vec::new();
        for index in 0..5 {
            let handle = pending_loop(&format!("memory-{index}"));
            loops
                .loops
                .lock()
                .await
                .insert(handle.id.clone(), handle.clone());
            handles.push(handle);
        }
        // More than the former 32 MiB lifetime limit per loop, with five active
        // queues. Only eight delivered-but-unacknowledged packets may survive.
        let delta = "x".repeat(32 * 1024);
        for sequence in 1..=1040 {
            for handle in &handles {
                handle
                    .emit(json!({"type":"text-delta","delta":delta}), false)
                    .await
                    .unwrap();
                let state = handle.state.lock().await;
                assert!(state.events.len() <= 8);
                assert!(state.pending_bytes < 264 * 1024);
                drop(state);
                if sequence % 8 == 0 {
                    loops
                        .acknowledge_events(&handle.id, sequence, None)
                        .await
                        .unwrap();
                }
            }
        }
        for handle in &handles {
            let state = handle.state.lock().await;
            assert_eq!(state.execution.sequence, 1040);
            assert_eq!(state.pending_bytes, 0);
            assert!(state.events.is_empty());
        }
    }

    #[tokio::test]
    async fn pending_capacity_failure_does_not_publish_a_sequence_gap() {
        let handle = pending_loop("capacity");
        handle.state.lock().await.pending_bytes = MAX_PENDING_EVENT_BYTES;
        assert!(
            handle
                .emit(json!({"type":"text-delta","delta":"full"}), false)
                .await
                .is_err()
        );
        {
            let mut state = handle.state.lock().await;
            let next = state.execution.clone();
            assert!(
                handle
                    .commit(&mut state, next, vec![json!({"type":"tool-call"})], false)
                    .await
                    .is_err()
            );
            assert_eq!(state.execution.sequence, 0);
            assert!(state.events.is_empty());
        }
        handle
            .emit(json!({"type":"error","error":"delivery stalled"}), true)
            .await
            .unwrap();
        assert_eq!(handle.state.lock().await.execution.sequence, 1);
    }

    #[tokio::test]
    async fn completed_run_ack_still_requires_its_execution_owner() {
        let loops = AgentLoopManager::default();
        let handle = pending_loop("owner");
        let lease = ExecutionLease {
            session_id: "session".into(),
            run_id: "run".into(),
            epoch: "epoch".into(),
            host_id: "host".into(),
            closed: false,
        };
        handle
            .state
            .lock()
            .await
            .execution
            .request
            .execution_context = Some(lease.clone());
        loops
            .loops
            .lock()
            .await
            .insert(handle.id.clone(), handle.clone());
        handle.emit(json!({"type":"done"}), true).await.unwrap();
        assert!(loops.acknowledge_events(&handle.id, 1, None).await.is_err());
        let other = ExecutionLease {
            epoch: "other".into(),
            ..lease.clone()
        };
        assert!(
            loops
                .acknowledge_events(&handle.id, 1, Some(&other))
                .await
                .is_err()
        );
        loops
            .acknowledge_events(&handle.id, 1, Some(&lease))
            .await
            .unwrap();
        assert_eq!(handle.state.lock().await.pending_bytes, 0);
    }

    #[tokio::test]
    async fn terminal_events_are_replayed_and_stream_closes() {
        let loops = AgentLoopManager::default();
        let id = loops.start(request()).await.unwrap();
        let mut first = loops.subscribe_events(&id, 0).await.unwrap();
        let mut seen = Vec::new();
        while let Some(event) = first.next().await.unwrap() {
            seen.push(serde_json::from_slice::<Value>(&event).unwrap());
        }
        assert_eq!(seen[0]["type"], "loop-started");
        assert_eq!(seen.last().unwrap()["type"], "error");
        assert_eq!(seen.iter().filter(|e| e["type"] == "error").count(), 1);
        assert!(!seen.iter().any(|e| e["type"] == "done"));
        let mut replay = loops.subscribe_events(&id, 1).await.unwrap();
        for event in seen.iter().skip(1) {
            let bytes = replay.next().await.unwrap().unwrap();
            assert_eq!(&serde_json::from_slice::<Value>(&bytes).unwrap(), event);
        }
        assert!(replay.next().await.unwrap().is_none());
        assert!(
            loops
                .subscribe_events(&id, seen.len() as u64 + 1)
                .await
                .is_err()
        );
        loops.cancel(&id).await.unwrap();
    }

    #[test]
    fn execution_serialization_omits_provider_credentials() {
        let request: AgentLoopRequest = serde_json::from_value(json!({
            "apiFormat":"openai", "model":"test", "apiKey":"secret-key",
            "headers":{"authorization":"Bearer private-token", "x-gateway-key":"private-header"}
        }))
        .unwrap();
        let saved = serde_json::to_string(&request).unwrap();
        for secret in ["secret-key", "private-token", "private-header"] {
            assert!(!saved.contains(secret));
        }
        let restored: AgentLoopRequest = serde_json::from_str(&saved).unwrap();
        assert!(restored.provider.api_key.is_none());
        assert!(restored.provider.headers.is_empty());
    }

    #[test]
    fn retains_legacy_step_budget_for_execution_identity_without_a_default() {
        assert_eq!(request().legacy_max_steps, Some(1));
        let request: AgentLoopRequest =
            serde_json::from_value(json!({"apiFormat":"invalid","model":"test"})).unwrap();
        assert_eq!(request.legacy_max_steps, None);
        assert!(
            serde_json::to_value(request)
                .unwrap()
                .get("maxSteps")
                .is_none()
        );
    }

    #[tokio::test]
    async fn accepts_retired_step_budgets_without_admission_limits() {
        let loops = AgentLoopManager::default();
        for value in [0, 1, 257, 10_000] {
            let mut req = request();
            req.legacy_max_steps = Some(value);
            let id = loops.start(req).await.unwrap();
            loops.cancel(&id).await.unwrap();
        }
    }
}
