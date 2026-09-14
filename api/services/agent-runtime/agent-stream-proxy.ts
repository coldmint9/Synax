import { runCoordinator } from './run-coordinator.js';
import { getBackendAdapter } from './backends/backend-registry.js';
import { resolveBackendModel, resolveSessionBackend } from './backends/backend-binding.js';
import { AgentValidationError } from './runtime-errors.js';
import { interactionService } from './interaction-service.js';
import { getRawSqlite } from '../../db/index.js';
import type { AgentRunStreamChunk, StreamTurnRequest } from './contracts.js';
import { agentEventService } from './event-service.js';
import { agentLoopRuntime } from './loop-runtime.js';
import { sessionProcessManager } from './session-process-manager.js';
import { maybeScheduleSessionTitleFromStreamChunk, ensureSessionTitleGenerated } from './session-title-service.js';
import type { AgentSessionStreamMode } from '../../lib/ipc/agent-session-protocol.js';
import { acpSessionEngine, shouldUseAcpEngine } from './acp-engine/index.js';
import { agentRuntimeStore } from './session-store.js';

function useInProcessAgentSessions(): boolean {
  return process.env.SYNAX_AGENT_SESSION_IN_PROCESS === '1';
}

export function usesForkedAgentSessions(): boolean {
  return !useInProcessAgentSessions();
}

export function canStartAgentSessionProcess(sessionId?: string): boolean {
  if (sessionId) {
    const session = agentRuntimeStore.tryGetSession(sessionId);
    if (session && shouldUseAcpEngine(sessionId, {})) {
      return true;
    }
  }
  if (!usesForkedAgentSessions()) return true;
  return sessionProcessManager.canSpawnChild(sessionId);
}

export function assertCanStartAgentSessionProcess(sessionId?: string): void {
  if (sessionId) {
    const session = agentRuntimeStore.tryGetSession(sessionId);
    if (session && shouldUseAcpEngine(sessionId, {})) {
      return;
    }
  }
  if (!usesForkedAgentSessions()) return;
  sessionProcessManager.assertCanSpawnChild(sessionId);
}

async function* withSessionTitleScheduling(
  sessionId: string,
  source: AsyncGenerator<AgentRunStreamChunk>,
): AsyncGenerator<AgentRunStreamChunk> {
  try {
    for await (const chunk of source) {
      maybeScheduleSessionTitleFromStreamChunk(sessionId, chunk);
      yield chunk;
    }
  } finally {
    ensureSessionTitleGenerated(sessionId);
  }
}

export async function* streamAgentSession(
  sessionId: string,
  mode: AgentSessionStreamMode,
  input: StreamTurnRequest,
  abortSignal?: AbortSignal,
): AsyncGenerator<AgentRunStreamChunk> {
  const binding = resolveSessionBackend(sessionId);
  const model = resolveBackendModel(sessionId, input);
  const metadata = agentRuntimeStore.getSession(sessionId).sessionMetadata;
  if (binding.id !== 'native' && (metadata?.mode === 'plan' || (metadata?.mode === 'goal' && metadata.goal))) {
    throw new AgentValidationError('Plan and goal controls require the native Synax engine. Start a Native session to use them.');
  }
  const backend = getBackendAdapter(binding.id);
  const request = model ? { ...input, model } : input;
  if (binding.id === 'native' && metadata?.mode === 'goal') {
    yield* observeBackgroundRun(withSessionTitleScheduling(sessionId, backend.stream(sessionId, mode, request)), abortSignal);
  } else {
    yield* withSessionTitleScheduling(sessionId, backend.stream(sessionId, mode, request, abortSignal));
  }
}

export function resumeAgentSessionInBackground(sessionId: string, input: StreamTurnRequest = {}): void {
  runCoordinator.resume(sessionId, input);
}

export async function interruptAgentSessionsAndWait(
  sessionIds: Iterable<string>,
  reason = 'Agent runtime session deleted by user.',
): Promise<void> {
  const ids = [...new Set([...sessionIds].flatMap(id => agentRuntimeStore.tryGetSession(id) ? agentRuntimeStore.listSessionTree(id).map(s=>s.id) : [id]))];
  for (const sessionId of ids) {
    if (!agentRuntimeStore.tryGetSession(sessionId)) continue;
    await runCoordinator.interrupt(sessionId, reason);
    if (acpSessionEngine.usesAcpSession(sessionId)) {
      await acpSessionEngine.interruptSession(sessionId, reason);
    }
  }
  if (!useInProcessAgentSessions()) {
    await sessionProcessManager.interruptAndWaitForSessions(ids, reason);
  }
  await agentLoopRuntime.interruptAndWaitForSessions(ids, reason);
}

export async function closeAcpAgentSessions(sessionIds: Iterable<string>): Promise<void> {
  for (const sessionId of sessionIds) {
    if (acpSessionEngine.usesAcpSession(sessionId)) {
      await acpSessionEngine.closeSession(sessionId);
    }
  }
}

// Goal execution belongs to the session, not the browser's SSE connection.
// A detached observer drops its buffer; the producer continues persisting output.
async function* observeBackgroundRun(
  source: AsyncGenerator<AgentRunStreamChunk>, signal?: AbortSignal,
): AsyncGenerator<AgentRunStreamChunk> {
  const queue: AgentRunStreamChunk[]=[];
  let ended=false, attached=true, failure:unknown, wake:(()=>void)|undefined;
  const notify=()=>{wake?.();wake=undefined;};
  const detach=()=>{attached=false;queue.length=0;notify();};
  signal?.addEventListener('abort',detach,{once:true});
  if(signal?.aborted)detach();
  void (async()=>{
    try {for await(const chunk of source){
      if(attached){
        // ponytail: bounded observer buffer; slow/disconnected clients reload the durable transcript.
        if(queue.length>=256)detach();else{queue.push(chunk);notify();}
      }
    }}catch(error){failure=error;}finally{ended=true;notify();}
  })();
  try {
    while(attached){
      if(queue.length){yield queue.shift()!;continue;}
      if(ended){if(failure)throw failure;return;}
      await new Promise<void>(resolve=>{wake=resolve;});
    }
  }finally{detach();signal?.removeEventListener('abort',detach);}
}

export function recoverAnsweredInteractions(): void {
  const rows = getRawSqlite().prepare("SELECT DISTINCT i.session_id FROM agent_runtime_interactions i JOIN agent_runtime_sessions s ON s.id=i.session_id WHERE i.consumed_at IS NULL AND i.response_json IS NOT NULL AND s.status='waiting_input' LIMIT 100").all() as Array<{session_id:string}>;
  for(const row of rows)if(interactionService.ready(row.session_id))resumeAgentSessionInBackground(row.session_id);
}
export function startInteractionRecovery(): () => void {
  const tick=()=>{try{recoverAnsweredInteractions();}catch{/* startup/shutdown DB lifetime; next tick retries durable markers */}};
  const timer=setInterval(tick,15_000);timer.unref();setImmediate(tick);
  return ()=>clearInterval(timer);
}
