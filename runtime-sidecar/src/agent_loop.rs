//! Rust-owned model/tool iteration and durable checkpoints. Observers read a
//! sequenced journal; detaching never controls execution or tool delivery.

use crate::loop_context::{self, Compaction, ContextAction, ContextPolicy};
use crate::loop_policy::{self, Decision, Disposition, RuntimeBinding};
use crate::provider::{ProviderRequest, provider_events};
use crate::provider_adapter::InvalidToolArguments;
use crate::storage::HotStore;
use crate::{actor::SessionShardRouter, execution::ExecutionLease};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, watch};
use uuid::Uuid;

const MAX_REPLAY_BYTES: usize = 32 * 1024 * 1024;
const TERMINAL_RETENTION_MS: u64 = 15 * 60 * 1000;
const MAX_ACTIVE_LOOPS: usize = 128;
const MAX_TOOL_ARGUMENT_RETRIES: u32 = 2;
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
    // Retain old request/checkpoint bytes for idempotency, but never use this
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
struct Checkpoint {
    version: u32,
    #[serde(default)]
    initial_hash: String,
    request: AgentLoopRequest,
    phase: Phase,
    pending: HashSet<String>,
    results: HashMap<String, ToolResultRequest>,
    #[serde(default)]
    call_tools: HashMap<String, String>,
    #[serde(default)]
    step_context: Option<StepContextRequest>,
    #[serde(default)]
    compacted_step: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_argument_retry: Option<ToolArgumentRetry>,
    sequence: u64,
    event_bytes: usize,
    terminal_at: Option<u64>,
    cancel_requested: bool,
}

struct LoopState {
    checkpoint: Checkpoint,
    events: Vec<Value>,
    running: bool,
    failure: Option<String>,
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
    /// Only publish memory state after the checkpoint and its events have
    /// crossed the WAL barrier. Unknown/failed durability stops this executor.
    async fn commit(
        &self,
        state: &mut LoopState,
        mut next: Checkpoint,
        events: Vec<Value>,
        terminal: bool,
    ) -> Result<(), LoopError> {
        if let Some(error) = &state.failure {
            return Err(error.clone().into());
        }
        let mut published = Vec::with_capacity(events.len());
        let mut encoded = Vec::with_capacity(events.len());
        for mut event in events {
            next.sequence += 1;
            let object = event.as_object_mut().ok_or("invalid loop event")?;
            object.insert("loopId".into(), json!(self.id));
            object.insert("sequence".into(), json!(next.sequence));
            let bytes = serde_json::to_vec(&event)?;
            next.event_bytes += bytes.len();
            if !terminal && next.event_bytes > MAX_REPLAY_BYTES {
                return Err("agent loop event journal capacity exceeded".into());
            }
            encoded.push((next.sequence, bytes));
            published.push(event);
        }
        if terminal {
            next.terminal_at = Some(now_ms());
        }
        if let Some(store) = &self.store {
            if let Err(error) = store
                .commit_agent_loop_async(self.id.clone(), serde_json::to_vec(&next)?, encoded)
                .await
            {
                state.failure = Some(error.to_string());
                self.changed.send_modify(|revision| *revision += 1);
                return Err(error.into());
            }
        }
        state.checkpoint = next;
        state.events.extend(published);
        self.changed.send_modify(|revision| *revision += 1);
        Ok(())
    }

    async fn emit(&self, event: Value, terminal: bool) -> Result<(), LoopError> {
        let mut state = self.state.lock().await;
        if state.checkpoint.terminal_at.is_some() {
            return Err("agent loop is already terminal".into());
        }
        let next = state.checkpoint.clone();
        self.commit(&mut state, next, vec![event], terminal).await
    }
}

pub(crate) struct LoopSubscription {
    handle: Arc<LoopHandle>,
    changed: watch::Receiver<u64>,
    cursor: usize,
}
impl LoopSubscription {
    pub(crate) async fn next(&mut self) -> Result<Option<Value>, LoopError> {
        loop {
            {
                let state = self.handle.state.lock().await;
                if let Some(event) = state.events.get(self.cursor) {
                    self.cursor += 1;
                    return Ok(Some(event.clone()));
                }
                if let Some(error) = &state.failure {
                    return Err(error.clone().into());
                }
                if state.checkpoint.terminal_at.is_some() {
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
        let mut loops = self.loops.lock().await;
        if let Some(handle) = loops.get(id) {
            return Ok(handle.clone());
        }
        let handle = self.load(id).await?.ok_or("agent loop not found")?;
        loops.insert(id.to_owned(), handle.clone());
        Ok(handle)
    }

    async fn load(&self, id: &str) -> Result<Option<Arc<LoopHandle>>, LoopError> {
        let Some(store) = &self.store else {
            return Ok(None);
        };
        let Some((checkpoint, events)) = store.load_agent_loop_async(id.to_owned()).await? else {
            return Ok(None);
        };
        let checkpoint: Checkpoint = serde_json::from_slice(&checkpoint)?;
        if checkpoint.version != 1 {
            return Err("unsupported agent loop checkpoint version".into());
        }
        let events = events
            .into_iter()
            .map(|bytes| serde_json::from_slice::<Value>(&bytes))
            .collect::<Result<Vec<_>, _>>()?;
        if events.len() as u64 != checkpoint.sequence
            || events.iter().enumerate().any(|(index, event)| {
                event["sequence"] != json!(index + 1) || event["loopId"] != id
            })
        {
            return Err("agent loop journal does not match checkpoint".into());
        }
        let (changed, _) = watch::channel(0);
        let (cancel, _) = watch::channel(checkpoint.cancel_requested);
        let handle = Arc::new(LoopHandle {
            id: id.to_owned(),
            store: self.store.clone(),
            router: self.router.clone(),
            changed,
            cancel,
            state: Mutex::new(LoopState {
                checkpoint,
                events,
                running: false,
                failure: None,
            }),
        });
        Ok(Some(handle))
    }

    fn launch(handle: Arc<LoopHandle>) {
        tokio::spawn(async move {
            let outcome = match run_loop(&handle).await {
                Ok(LoopFinish::Done(steps, disposition)) => {
                    json!({"type":"done","steps":steps,"disposition":disposition})
                }
                Ok(LoopFinish::Cancelled) => json!({"type":"cancelled"}),
                Err(error) => json!({"type":"error","error":error.to_string()}),
            };
            let _ = handle.emit(outcome, true).await;
            handle.state.lock().await.running = false;
            handle.changed.send_modify(|revision| *revision += 1);
        });
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
        let existing = match loops.get(&id) {
            Some(handle) => Some(handle.clone()),
            None if request.request_id.is_some() => self.load(&id).await?,
            None => None,
        };
        if let Some(handle) = existing {
            let mut state = handle.state.lock().await;
            if state.checkpoint.initial_hash != initial_hash {
                return Err("requestId was already used for different loop input".into());
            }
            let next = state.checkpoint.clone();
            handle.commit(&mut state, next, Vec::new(), false).await?;
            let launch = !state.running && state.checkpoint.terminal_at.is_none();
            if launch {
                state.checkpoint.request.provider.api_key = request.provider.api_key;
                state.checkpoint.request.provider.headers = request.provider.headers;
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
            match handle.state.lock().await.checkpoint.terminal_at {
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
                checkpoint: Checkpoint {
                    version: 1,
                    initial_hash,
                    request,
                    phase: initial_phase,
                    pending: HashSet::new(),
                    results: HashMap::new(),
                    call_tools: HashMap::new(),
                    step_context: None,
                    compacted_step: None,
                    tool_argument_retry: None,
                    sequence: 0,
                    event_bytes: 0,
                    terminal_at: None,
                    cancel_requested: false,
                },
                events: Vec::new(),
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
    /// reattached here and are never serialized into the loop checkpoint.
    pub(crate) async fn resume(&self, input: ResumeLoopRequest) -> Result<(), LoopError> {
        let handle = self.get(&input.loop_id).await?;
        check_execution(&handle, input.request.execution_context.as_ref()).await?;
        let mut state = handle.state.lock().await;
        let saved = &state.checkpoint.request.provider;
        let supplied = input.request.provider;
        if state.checkpoint.request.runtime_binding != input.request.runtime_binding
            || saved.api_format != supplied.api_format
            || saved.base_url != supplied.base_url
            || saved.model != supplied.model
        {
            return Err("resumed provider configuration does not match the loop".into());
        }
        if state.checkpoint.terminal_at.is_some() {
            return Ok(());
        }
        if let Some(error) = &state.failure {
            return Err(error.clone().into());
        }
        let mut next = state.checkpoint.clone();
        next.request.execution_context = input.request.execution_context;
        next.request.provider.api_key = supplied.api_key;
        next.request.provider.headers = supplied.headers;
        handle.commit(&mut state, next, Vec::new(), false).await?;
        if state.running {
            return Ok(());
        }
        state.running = true;
        drop(state);
        Self::launch(handle);
        Ok(())
    }

    pub(crate) async fn subscribe_events(
        &self,
        id: &str,
        after: usize,
    ) -> Result<LoopSubscription, LoopError> {
        let handle = self.get(id).await?;
        let changed = handle.changed.subscribe();
        if after > handle.state.lock().await.events.len() {
            return Err("event cursor is ahead of the loop".into());
        }
        Ok(LoopSubscription {
            handle,
            changed,
            cursor: after,
        })
    }

    pub(crate) async fn send_tool_result(
        &self,
        request: ToolResultRequest,
    ) -> Result<(), LoopError> {
        let handle = self.get(&request.loop_id).await?;
        check_execution(&handle, request.execution_context.as_ref()).await?;
        let mut state = handle.state.lock().await;
        let mut next = state.checkpoint.clone();
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
        handle.commit(&mut state, next, Vec::new(), false).await
    }

    pub(crate) async fn set_context(&self, input: StepContextRequest) -> Result<(), LoopError> {
        let handle = self.get(&input.loop_id).await?;
        check_execution(&handle, input.execution_context.as_ref()).await?;
        let mut state = handle.state.lock().await;
        let mut next = state.checkpoint.clone();
        if let Some(previous) = &next.step_context {
            if previous.context_id == input.context_id {
                if previous.system_prompt != input.system_prompt || previous.tools != input.tools {
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
        let handle = self.get(id).await?;
        let mut changed = handle.changed.subscribe();
        {
            let mut state = handle.state.lock().await;
            if state.checkpoint.terminal_at.is_some() {
                return Ok(());
            }
            let mut next = state.checkpoint.clone();
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
                if state.checkpoint.terminal_at.is_some() && !state.running {
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
        .checkpoint
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
        .checkpoint
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
            .ui_snapshot_async(binding.session_id.clone(), None)
            .await?,
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
        let snapshot: Value =
            serde_json::from_slice(&store.ui_snapshot_async(parent, None).await?)?;
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
        let checkpoint = handle.state.lock().await.checkpoint.clone();
        if checkpoint.cancel_requested {
            return Ok(LoopFinish::Cancelled);
        }
        match checkpoint.phase {
            Phase::Prepare { step } => {
                if let Some((session, root, run)) =
                    runtime_facts(handle, &checkpoint.request).await?
                {
                    if let Decision::Finish(disposition) =
                        loop_policy::before_model(&session, &root, &run)
                    {
                        let mut state = handle.state.lock().await;
                        let mut next = state.checkpoint.clone();
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
                let mut next = state.checkpoint.clone();
                next.phase = Phase::Context {
                    step,
                    context_id: context_id.clone(),
                };
                next.step_context = None;
                handle
                    .commit(
                        &mut state,
                        next,
                        vec![json!({"type":"context-request","contextId":context_id,"step":step})],
                        false,
                    )
                    .await?;
            }
            Phase::Context { step, context_id } => {
                let mut changed = handle.changed.subscribe();
                let prepared = loop {
                    let state = handle.state.lock().await;
                    if state.checkpoint.cancel_requested {
                        return Ok(LoopFinish::Cancelled);
                    }
                    if let Some(error) = &state.failure {
                        return Err(error.clone().into());
                    }
                    if let Some(context) = &state.checkpoint.step_context {
                        if context.context_id == context_id {
                            break context.clone();
                        }
                    }
                    drop(state);
                    changed.changed().await?;
                };
                let mut state = handle.state.lock().await;
                let mut next = state.checkpoint.clone();
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
                let policy = checkpoint
                    .request
                    .context_policy
                    .as_ref()
                    .ok_or("missing compaction policy")?;
                if plan.offset == plan.source.len() {
                    let (prompt, composition) =
                        plan.complete(&checkpoint.request.provider, policy)?;
                    let mut state = handle.state.lock().await;
                    let mut next = state.checkpoint.clone();
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
                    let mut next = state.checkpoint.clone();
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
                let (request, through) = plan.request(&checkpoint.request.provider, policy)?;
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
                    return Err("context compaction did not produce a complete checkpoint".into());
                }
                if loop_context::tokens(&summary) > plan.summary_tokens {
                    return Err("context compaction exceeded its output budget".into());
                }
                plan.summary = summary;
                plan.offset = through;
                plan.chunk += 1;
                let mut state = handle.state.lock().await;
                let mut next = state.checkpoint.clone();
                let event = json!({"type":"compaction-call-finished","step":step,
                    "chunk":plan.chunk,"requestId":request_id,"usage":usage});
                next.phase = Phase::Compact { step, plan };
                handle.commit(&mut state, next, vec![event], false).await?;
            }
            Phase::Finish { step, disposition } => return Ok(LoopFinish::Done(step, disposition)),
            Phase::Model { step, attempt } => {
                if let Some((session, root, run)) =
                    runtime_facts(handle, &checkpoint.request).await?
                {
                    if let Decision::Finish(disposition) =
                        loop_policy::before_model(&session, &root, &run)
                    {
                        let mut state = handle.state.lock().await;
                        let mut next = state.checkpoint.clone();
                        next.phase = Phase::Finish {
                            step: step.saturating_sub(1),
                            disposition: Some(disposition),
                        };
                        handle.commit(&mut state, next, Vec::new(), false).await?;
                        continue;
                    }
                }
                if attempt == 0 {
                    if let Some(policy) = &checkpoint.request.context_policy {
                        let action = if checkpoint.compacted_step == Some(step) {
                            let composition =
                                loop_context::composition(&checkpoint.request.provider)?;
                            if composition.total > policy.input_budget() {
                                return Err(
                                    "context_blocked: compacted request exceeds budget".into()
                                );
                            }
                            ContextAction::Ready(composition)
                        } else {
                            loop_context::plan(&checkpoint.request.provider, policy)?
                        };
                        match action {
                            ContextAction::Ready(composition) => {
                                handle.emit(json!({"type":"context-composition","step":step,"composition":composition}), false).await?;
                            }
                            ContextAction::Compact(plan) => {
                                let event = json!({"type":"context-compaction-started","step":step,"originalTokens":plan.original_tokens,"source":plan.source});
                                let mut state = handle.state.lock().await;
                                let mut next = state.checkpoint.clone();
                                next.phase = Phase::Compact { step, plan };
                                handle.commit(&mut state, next, vec![event], false).await?;
                                continue;
                            }
                        }
                    }
                }
                {
                    let mut state = handle.state.lock().await;
                    let mut next = state.checkpoint.clone();
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
                    }
                    handle.commit(&mut state, next, vec![event], false).await?;
                }
                let mut events = provider_events(checkpoint.request.provider.clone());
                check_execution(handle, checkpoint.request.execution_context.as_ref()).await?;
                let mut lease_tick = tokio::time::interval(std::time::Duration::from_millis(500));
                let mut calls = Vec::new();
                let mut assistant = None;
                let mut final_events = Vec::new();
                let mut argument_error = None;
                loop {
                    let event = tokio::select! {
                        biased;
                        _ = async { cancel.wait_for(|requested| *requested).await.map(|_| ()) } => return Ok(LoopFinish::Cancelled),
                        _ = lease_tick.tick() => {
                            let context = handle.state.lock().await.checkpoint.request.execution_context.clone();
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
                        Err(error) => return Err(error),
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
                        _ => handle.emit(event, false).await?,
                    }
                }
                if let Some(error) = argument_error {
                    let retries = checkpoint.tool_argument_retry.as_ref().map_or(0, |retry| retry.attempt);
                    if retries >= MAX_TOOL_ARGUMENT_RETRIES {
                        return Err(error);
                    }
                    let reason = format!("{error}. No tools from this response were executed. Retry the intended tool calls using a complete JSON object matching each tool's schema, with properly escaped strings and no Markdown fences. If the response was truncated, use smaller calls.");
                    let mut state = handle.state.lock().await;
                    let mut next = state.checkpoint.clone();
                    next.tool_argument_retry = Some(ToolArgumentRetry { attempt: retries + 1, error: error.to_string() });
                    // Persist the correction and retry budget together. The
                    // rejected assistant/tool batch is never added to history.
                    next.request.provider.prompt.push(json!({"role":"user","content":[{"type":"text","text":reason}]}));
                    handle.commit(&mut state, next, vec![json!({"type":"policy-correction","step":step,"reason":reason})], false).await?;
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
                    match runtime_facts(handle, &checkpoint.request).await? {
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
                let mut next = state.checkpoint.clone();
                next.tool_argument_retry = None;
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
                let mut changed = handle.changed.subscribe();
                let results = loop {
                    let ready = {
                        let state = handle.state.lock().await;
                        if let Some(error) = &state.failure {
                            return Err(error.clone().into());
                        }
                        if state.checkpoint.cancel_requested {
                            return Ok(LoopFinish::Cancelled);
                        }
                        calls
                            .iter()
                            .map(|id| state.checkpoint.results.get(id).cloned())
                            .collect::<Option<Vec<_>>>()
                    };
                    if let Some(results) = ready {
                        break results;
                    }
                    changed.changed().await?;
                };
                let mut parts = Vec::new();
                let mut events = Vec::new();
                let mut disposition = None;
                for result in results {
                    if let Some(name) = checkpoint.call_tools.get(&result.tool_call_id) {
                        disposition =
                            loop_policy::interaction_result(name, &result.result).or(disposition);
                    }
                    events.push(json!({"type":"tool-result","step":step,"toolCallId":result.tool_call_id,"result":result.result,"isError":result.is_error}));
                    parts.push(json!({"type":"tool-result","toolCallId":result.tool_call_id,"output":result.result,"isError":result.is_error}));
                }
                events.push(json!({"type":"step-completed","step":step}));
                let mut state = handle.state.lock().await;
                let mut next = state.checkpoint.clone();
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

    #[tokio::test]
    async fn terminal_events_are_replayed_and_stream_closes() {
        let loops = AgentLoopManager::default();
        let id = loops.start(request()).await.unwrap();
        let mut first = loops.subscribe_events(&id, 0).await.unwrap();
        let mut seen = Vec::new();
        while let Some(event) = first.next().await.unwrap() {
            seen.push(event);
        }
        assert_eq!(seen[0]["type"], "loop-started");
        assert_eq!(seen.last().unwrap()["type"], "error");
        assert_eq!(seen.iter().filter(|e| e["type"] == "error").count(), 1);
        assert!(!seen.iter().any(|e| e["type"] == "done"));
        let mut replay = loops.subscribe_events(&id, 1).await.unwrap();
        for event in seen.iter().skip(1) {
            assert_eq!(replay.next().await.unwrap().as_ref(), Some(event));
        }
        assert!(replay.next().await.unwrap().is_none());
        assert!(loops.subscribe_events(&id, seen.len() + 1).await.is_err());
        loops.cancel(&id).await.unwrap();
    }

    #[test]
    fn checkpoint_serialization_omits_provider_credentials() {
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
    fn retains_legacy_step_budget_for_checkpoint_identity_without_a_default() {
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
