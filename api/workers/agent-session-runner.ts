import { withinExecutionContext } from "../lib/execution-context.js";
import { terminateOwnedCommands } from "../services/agent-runtime/tools/exec-async.js";
import { closeAllBrowserSessions } from "../services/agent-runtime/tools/browser/browser-manager.js";
import { logger } from "../lib/logger.js";
import {
  isAgentSessionParentMessage,
  sendAgentSessionToParent,
  type AgentSessionChildInit,
  type AgentSessionStreamMode,
} from "../lib/ipc/agent-session-protocol.js";
import type { StreamTurnRequest } from "../services/agent-runtime/contracts.js";
import { agentLoopRuntime } from "../services/agent-runtime/loop-runtime.js";
import { bootstrapAgentChildForSession } from "../services/agent-runtime/agent-child-bootstrap.js";
import { setSessionWorkspaceRoot } from "../services/agent-runtime/tools/workspace.js";

const activeStreams = new Map<string, AbortController>();
const runningTasks = new Set<Promise<void>>();

function pickGenerator(
  mode: AgentSessionStreamMode,
  sessionId: string,
  input: StreamTurnRequest,
  abortSignal: AbortSignal,
) {
  switch (mode) {
    case "turn":
      return agentLoopRuntime.streamRun(sessionId, input, abortSignal, false);
    case "continue":
      return agentLoopRuntime.streamContinue(sessionId, input, abortSignal);
    case "resume":
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
    for await (const chunk of withinExecutionContext(input.executionContext, pickGenerator(
      mode,
      sessionId,
      input,
      abortController.signal,
    ))) {
      sendAgentSessionToParent({
        type: "stream:chunk",
        sessionId,
        streamId,
        chunk,
      });
    }
    sendAgentSessionToParent({ type: "stream:done", sessionId, streamId });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    sendAgentSessionToParent({
      type: "stream:error",
      sessionId,
      streamId,
      error,
    });
    logger.error(
      { err, sessionId, streamId, mode },
      "[agent-session-runner] stream failed",
    );
  } finally {
    activeStreams.delete(streamId);
  }
}

function main(): void {
  const raw = process.env.AGENT_SESSION_INIT;
  if (!raw) {
    logger.error("[agent-session-runner] AGENT_SESSION_INIT missing");
    process.exit(1);
    return;
  }

  let init: AgentSessionChildInit;
  try {
    init = JSON.parse(raw) as AgentSessionChildInit;
  } catch (err) {
    logger.error({ err }, "[agent-session-runner] invalid AGENT_SESSION_INIT");
    process.exit(1);
    return;
  }

  let initialized = false;
  const initialize = () => {
    if (initialized || !process.connected) return;
    initialized = true;
    setSessionWorkspaceRoot(init.sessionId, init.workDir);
    bootstrapAgentChildForSession(init.sessionId);
    sendAgentSessionToParent({ type: 'session:ready', sessionId: init.sessionId });
    logger.info({ sessionId: init.sessionId, pid: process.pid }, '[agent-session-runner] ready');
  };

  let stopping = false;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    for (const controller of activeStreams.values())
      if (!controller.signal.aborted) controller.abort(new Error(reason));
    await terminateOwnedCommands();
    await closeAllBrowserSessions(reason);
    await Promise.allSettled([...runningTasks]);
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void shutdown("Worker terminated by parent.");
  });
  process.on("SIGINT", () => {
    void shutdown("Worker interrupted.");
  });
  process.on("disconnect", () => {
    void shutdown("Parent disconnected.");
  });

  process.on("message", (message: unknown) => {
    if (stopping || !isAgentSessionParentMessage(message)) return;

    if (message.type === 'session:initialize') { initialize(); return; }
    if (!initialized) return;
    if (message.type === "stream:start") {
      const task = runStream(
        init.sessionId,
        message.streamId,
        message.mode,
        message.input,
      );
      runningTasks.add(task);
      void task.finally(() => runningTasks.delete(task));
      return;
    }

    if (message.type === "stream:cancel") {
      const controller = activeStreams.get(message.streamId);
      if (controller && !controller.signal.aborted) {
        controller.abort(
          new Error(message.reason ?? "Stream cancelled by parent."),
        );
      }
      return;
    }

    if (message.type === "session:interrupt") {
      void shutdown(message.reason);
    }
  });

  // Retain compatibility with an already-running pre-upgrade parent.
  if (process.env.SYNAX_RECORDED_START !== '1') initialize();
  else sendAgentSessionToParent({ type: 'session:booted', sessionId: init.sessionId });
  if (!process.connected) void shutdown('Parent disconnected before initialization.');
}

setImmediate(main);
