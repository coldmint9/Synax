import type { AgentRunStreamChunk, StreamTurnRequest } from '../agent-runtime/contracts.js';
import { agentLoopRuntime } from '../agent-runtime/loop-runtime.js';
import { streamAgentSession } from '../agent-runtime/agent-stream-proxy.js';
import type { AgentSessionStreamMode } from '../../lib/ipc/agent-session-protocol.js';
import { ensureWikiProfileRegistered } from './wiki-loop-profile.js';
import { ensurePlanProfileRegistered } from './wiki-plan-profile.js';
import { ensureRefreshProfileRegistered } from './wiki-refresh-profile.js';

function ensureWikiProfilesLoaded(): void {
  ensureWikiProfileRegistered();
  ensurePlanProfileRegistered();
  ensureRefreshProfileRegistered();
}

async function* streamWikiAgentInWikiChild(
  sessionId: string,
  input: StreamTurnRequest,
  abortSignal?: AbortSignal,
  resume = false,
): AsyncGenerator<AgentRunStreamChunk> {
  ensureWikiProfilesLoaded();
  if (resume) {
    yield* agentLoopRuntime.streamRun(sessionId, input, abortSignal, true);
    return;
  }
  yield* agentLoopRuntime.streamRun(sessionId, input, abortSignal, false);
}

export async function* streamWikiAgent(
  sessionId: string,
  input: StreamTurnRequest,
  abortSignal?: AbortSignal,
  resume = false,
): AsyncGenerator<AgentRunStreamChunk> {
  const mode: AgentSessionStreamMode = resume ? 'resume' : 'turn';

  // Wiki planner/writer tools keep mutable state in this process (outline draft, verifier handles).
  // Run the agent loop inside the wiki job child; remote fork requires DB-backed tool state (TODO).
  if (process.env.SYNAX_WIKI_JOB_CHILD === '1') {
    yield* streamWikiAgentInWikiChild(sessionId, input, abortSignal, resume);
    return;
  }

  if (process.env.SYNAX_AGENT_SESSION_IN_PROCESS === '1') {
    ensureWikiProfilesLoaded();
    if (resume) {
      yield* agentLoopRuntime.streamRun(sessionId, input, abortSignal, true);
      return;
    }
    yield* agentLoopRuntime.streamRun(sessionId, input, abortSignal, false);
    return;
  }

  yield* streamAgentSession(sessionId, mode, input, abortSignal);
}
