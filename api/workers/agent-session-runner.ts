import { logger } from '../lib/logger.js';
import {
  isAgentSessionParentMessage,
  sendAgentSessionToParent,
  type AgentSessionChildInit,
  type AgentSessionStreamMode,
} from '../lib/ipc/agent-session-protocol.js';
import type { StreamTurnRequest } from '../services/agent-runtime/contracts.js';
import { agentLoopRuntime } from '../services/agent-runtime/loop-runtime.js';
import { bootstrapAgentChildForSession } from '../services/agent-runtime/agent-child-bootstrap.js';
import { setSessionWorkspaceRoot } from '../services/agent-runtime/tools/workspace.js';

const activeStreams = new Map<string, AbortController>();

function pickGenerator(
  mode: AgentSessionStreamMode,
  sessionId: string,
  input: StreamTurnRequest,
  abortSignal: AbortSignal,
) {
  switch (mode) {
    case 'turn':
      return agentLoopRuntime.streamRun(sessionId, input, abortSignal, false);
    case 'continue':
      return agentLoopRuntime.streamContinue(sessionId, input, abortSignal);
    case 'resume':
      return agentLoopRuntime.streamRun(sessionId, input, abortSignal, true);
  }
}

async function runStream(
  sessionId: string,
  streamId: string,
  mode: AgentSessionStreamMode,
  input: StreamTurnRequest,
): Promise<void> {
  const abortController = new AbortController();
  activeStreams.set(streamId, abortController);
  try {
    for await (const chunk of pickGenerator(mode, sessionId, input, abortController.signal)) {
      sendAgentSessionToParent({
        type: 'stream:chunk',
        sessionId,
        streamId,
        chunk,
      });
    }
    sendAgentSessionToParent({ type: 'stream:done', sessionId, streamId });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    sendAgentSessionToParent({ type: 'stream:error', sessionId, streamId, error });
    logger.error({ err, sessionId, streamId, mode }, '[agent-session-runner] stream failed');
  } finally {
    activeStreams.delete(streamId);
  }
}

function main(): void {
  const raw = process.env.AGENT_SESSION_INIT;
  if (!raw) {
    logger.error('[agent-session-runner] AGENT_SESSION_INIT missing');
    process.exit(1);
    return;
  }

  let init: AgentSessionChildInit;
  try {
    init = JSON.parse(raw) as AgentSessionChildInit;
  } catch (err) {
    logger.error({ err }, '[agent-session-runner] invalid AGENT_SESSION_INIT');
    process.exit(1);
    return;
  }

  setSessionWorkspaceRoot(init.sessionId, init.workDir);
  bootstrapAgentChildForSession(init.sessionId);

  process.on('message', (message: unknown) => {
    if (!isAgentSessionParentMessage(message)) return;

    if (message.type === 'stream:start') {
      void runStream(init.sessionId, message.streamId, message.mode, message.input);
      return;
    }

    if (message.type === 'stream:cancel') {
      const controller = activeStreams.get(message.streamId);
      if (controller && !controller.signal.aborted) {
        controller.abort(new Error(message.reason ?? 'Stream cancelled by parent.'));
      }
      return;
    }

    if (message.type === 'session:interrupt') {
      for (const controller of activeStreams.values()) {
        if (!controller.signal.aborted) {
          controller.abort(new Error(message.reason));
        }
      }
      process.exit(0);
    }
  });

  sendAgentSessionToParent({ type: 'session:ready', sessionId: init.sessionId });
  logger.info({ sessionId: init.sessionId, pid: process.pid }, '[agent-session-runner] ready');
}

setImmediate(main);
