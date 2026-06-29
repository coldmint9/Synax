import type { AgentRunStreamChunk, StreamTurnRequest } from './contracts.js';
import { agentEventService } from './event-service.js';
import { agentLoopRuntime } from './loop-runtime.js';
import { sessionProcessManager } from './session-process-manager.js';
import { maybeScheduleSessionTitleFromStreamChunk, ensureSessionTitleGenerated } from './session-title-service.js';
import type { AgentSessionStreamMode } from '../../lib/ipc/agent-session-protocol.js';
import { forwardChunkToLiveBus } from '../../lib/ipc/agent-session-protocol.js';
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

async function* inProcessStream(
  sessionId: string,
  mode: AgentSessionStreamMode,
  input: StreamTurnRequest,
  abortSignal?: AbortSignal,
): AsyncGenerator<AgentRunStreamChunk> {
  switch (mode) {
    case 'turn':
      yield* agentLoopRuntime.streamRun(sessionId, input, abortSignal, false);
      return;
    case 'continue':
      yield* agentLoopRuntime.streamContinue(sessionId, input, abortSignal);
      return;
    case 'resume':
      yield* agentLoopRuntime.streamRun(sessionId, input, abortSignal, true);
      return;
  }
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

async function* acpEngineStream(
  sessionId: string,
  mode: AgentSessionStreamMode,
  input: StreamTurnRequest,
  abortSignal?: AbortSignal,
): AsyncGenerator<AgentRunStreamChunk> {
  for await (const chunk of acpSessionEngine.stream(sessionId, mode, input, abortSignal)) {
    forwardChunkToLiveBus(sessionId, chunk);
    yield chunk;
  }
}

export async function* streamAgentSession(
  sessionId: string,
  mode: AgentSessionStreamMode,
  input: StreamTurnRequest,
  abortSignal?: AbortSignal,
): AsyncGenerator<AgentRunStreamChunk> {
  if (shouldUseAcpEngine(sessionId, input)) {
    yield* withSessionTitleScheduling(sessionId, acpEngineStream(sessionId, mode, input, abortSignal));
    return;
  }
  if (useInProcessAgentSessions()) {
    yield* withSessionTitleScheduling(sessionId, inProcessStream(sessionId, mode, input, abortSignal));
    return;
  }
  yield* withSessionTitleScheduling(sessionId, sessionProcessManager.streamSession(sessionId, mode, input, abortSignal));
}

export function resumeAgentSessionInBackground(sessionId: string, input: StreamTurnRequest = {}): void {
  void (async () => {
    try {
      for await (const _chunk of streamAgentSession(sessionId, 'resume', input)) {
        // Background resumes persist into the runtime store and event log.
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      agentEventService.append({
        sessionId,
        type: 'run_failed',
        summary: message,
        payload: { source: 'permission_reply_resume', error: message },
      });
    }
  })();
}

export async function interruptAgentSessionsAndWait(
  sessionIds: Iterable<string>,
  reason = 'Agent runtime session deleted by user.',
): Promise<void> {
  const ids = [...sessionIds];
  for (const sessionId of ids) {
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
