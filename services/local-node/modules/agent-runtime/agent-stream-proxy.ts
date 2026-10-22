import { logger } from "../../infrastructure/runtime/logger.js";
import { runCoordinator } from './run-coordinator.js';
import { getBackendAdapter } from './backends/backend-registry.js';
import { resolveBackendModel, resolveSessionBackend } from './backends/backend-binding.js';
import { AgentRuntimeError, AgentValidationError } from './runtime-errors.js';
import { agentSessionsRunInProcess, MAX_AGENT_SESSION_PROCESSES } from '../../infrastructure/runtime/env.js';
import { interactionService } from './interaction-service.js';
import type { AgentRunStreamChunk, StreamTurnRequest } from './contracts.js';
import { agentEventService } from './event-service.js';
import { rustNativeBackend } from './backends/rust-native-backend.js';
import { sessionProcessManager } from './session-process-manager.js';
import { maybeScheduleSessionTitleFromStreamChunk, ensureSessionTitleGenerated } from './session-title-service.js';
import type { AgentSessionStreamMode } from '../../infrastructure/runtime/ipc/agent-session-protocol.js';
import { agentRuntimeStore } from './session-store.js';
import { recoverAnsweredInteractionsOnce, stopAnsweredInteractionRecovery } from './interaction-recovery.js';

function useInProcessAgentSessions(): boolean {
  return agentSessionsRunInProcess();
}

export function usesForkedAgentSessions(): boolean {
  return !useInProcessAgentSessions();
}

export function canStartAgentSessionProcess(sessionId?: string): boolean {
  if (sessionId) {
    agentRuntimeStore.tryGetSession(sessionId);
  }
  if (!usesForkedAgentSessions()) {
    // In-process runs must honour the same admission cap: without it every
    // session would share the host's heap and event loop unbounded.
    return runCoordinator.activeSessionIds().length < MAX_AGENT_SESSION_PROCESSES;
  }
  return sessionProcessManager.canSpawnChild(sessionId);
}

export function assertCanStartAgentSessionProcess(sessionId?: string): void {
  if (sessionId) {
    agentRuntimeStore.tryGetSession(sessionId);
  }
  if (!usesForkedAgentSessions()) {
    if (runCoordinator.activeSessionIds().length < MAX_AGENT_SESSION_PROCESSES)
      return;
    throw new AgentRuntimeError(
      `Too many active agent session processes (max ${MAX_AGENT_SESSION_PROCESSES}).`,
      "SESSION_LIMIT",
      429,
    );
  }
  sessionProcessManager.assertCanQueueChild();
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
  }
  if (!useInProcessAgentSessions()) {
    await sessionProcessManager.interruptAndWaitForSessions(ids, reason);
  }
  await Promise.all(ids.map(id => rustNativeBackend.interrupt(id, reason)));
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

export function recoverAnsweredInteractions():void {
  void recoverAnsweredInteractionsOnce(resumeAgentSessionInBackground).catch(error => logger.warn({error}, 'Interaction recovery failed'));
}

export function startInteractionRecovery(): () => Promise<void> {
  const tick=()=>{try{recoverAnsweredInteractions();}catch{/* startup/shutdown DB lifetime; next tick retries durable markers */}};
  const timer=setInterval(tick,15_000);timer.unref();
  const initial=setImmediate(tick);
  return ()=>{clearInterval(timer);clearImmediate(initial);return stopAnsweredInteractionRecovery();};
}
