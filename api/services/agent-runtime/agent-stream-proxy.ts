import type { AgentRunStreamChunk, StreamTurnRequest } from './contracts.js';
import { agentEventService } from './event-service.js';
import { agentLoopRuntime } from './loop-runtime.js';
import { sessionProcessManager } from './session-process-manager.js';
import type { AgentSessionStreamMode } from '../../lib/ipc/agent-session-protocol.js';

function useInProcessAgentSessions(): boolean {
  return process.env.SYNAX_AGENT_SESSION_IN_PROCESS === '1';
}

export function usesForkedAgentSessions(): boolean {
  return !useInProcessAgentSessions();
}

export function canStartAgentSessionProcess(sessionId?: string): boolean {
  if (!usesForkedAgentSessions()) return true;
  return sessionProcessManager.canSpawnChild(sessionId);
}

export function assertCanStartAgentSessionProcess(sessionId?: string): void {
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

export async function* streamAgentSession(
  sessionId: string,
  mode: AgentSessionStreamMode,
  input: StreamTurnRequest,
  abortSignal?: AbortSignal,
): AsyncGenerator<AgentRunStreamChunk> {
  if (useInProcessAgentSessions()) {
    yield* inProcessStream(sessionId, mode, input, abortSignal);
    return;
  }
  yield* sessionProcessManager.streamSession(sessionId, mode, input, abortSignal);
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
  if (!useInProcessAgentSessions()) {
    await sessionProcessManager.interruptAndWaitForSessions(sessionIds, reason);
  }
  await agentLoopRuntime.interruptAndWaitForSessions(sessionIds, reason);
}
