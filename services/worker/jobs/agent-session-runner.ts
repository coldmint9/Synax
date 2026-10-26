import { WorkerStreamCredits } from "../../local-node/infrastructure/runtime/ipc/stream-credit.js";
import { createWorkerShutdown, startExitWatchdog } from "./worker-shutdown.js";
import { withinExecutionContext } from "../../local-node/infrastructure/runtime/execution-context.js";
import { terminateOwnedCommands } from "../../local-node/modules/agent-runtime/tools/exec-async.js";
import { closeAllBrowserSessions } from "../../local-node/modules/agent-runtime/tools/browser/browser-manager.js";
import { logger } from "../../local-node/infrastructure/runtime/logger.js";
import { flushDiagnosticLogs } from "../../local-node/infrastructure/runtime/buffered-log-writer.js";
import {
  isAgentSessionParentMessage,
  sendAgentSessionToParent,
  type AgentSessionChildInit,
  type AgentSessionStreamMode,
} from "../../local-node/infrastructure/runtime/ipc/agent-session-protocol.js";
import type { StreamTurnRequest } from "../../local-node/modules/agent-runtime/contracts.js";
import { rustNativeBackend } from "../../local-node/modules/agent-runtime/backends/rust-native-backend.js";
import { agentRuntimeStore } from "../../local-node/modules/agent-runtime/session-store.js";
import { bootstrapAgentChildForSession } from "../../local-node/modules/agent-runtime/agent-child-bootstrap.js";
import { setSessionWorkspaceRoot } from "../../local-node/modules/agent-runtime/tools/workspace.js";
import { compactSessionContextWithLlm } from "../../local-node/modules/agent-runtime/manual-context-compaction.js";
import { businessStore } from "../../local-node/infrastructure/persistence/business-store.js";
import { hydrateSessionAssets } from "../../local-node/modules/agent-runtime/media-assets.js";
import { AgentNotFoundError } from "../../local-node/modules/agent-runtime/runtime-errors.js";
import { RuntimeSidecarError } from "../../local-node/modules/agent-runtime/sidecar/sidecar-client.js";

import { runtimeBus } from "../../local-node/modules/agent-runtime/runtime-bus.js";

const activeStreams = new Map<string, AbortController>();
const activeCompactions = new Map<string, AbortController>();
const runningTasks = new Set<Promise<void>>();
let yieldWorkerRequested = false;
const streamCredits = new WorkerStreamCredits();

function pickGenerator(
  mode: AgentSessionStreamMode,
  sessionId: string,
  input: StreamTurnRequest,
  abortSignal: AbortSignal,
) {
  return rustNativeBackend.stream(sessionId, mode, { ...input, shouldYieldWorker: () => yieldWorkerRequested }, abortSignal);
}

async function runContextCompaction(sessionId: string, requestId: string): Promise<void> {
  const controller = new AbortController();
  activeCompactions.set(requestId, controller);
  try {
    await agentRuntimeStore.hydrateExecutionSession(sessionId, true);
    const result = await compactSessionContextWithLlm(sessionId, controller.signal, requestId);
    sendAgentSessionToParent({
      type: "context:compact:done",
      sessionId,
      requestId,
      result,
    });
  } catch (error) {
    sendAgentSessionToParent({
      type: "context:compact:error",
      sessionId,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    activeCompactions.delete(requestId);
  }
}

async function runStream(
  sessionId: string,
  streamId: string,
  mode: AgentSessionStreamMode,
  input: StreamTurnRequest,
  flowControl?: "byte-credit-v1",
): Promise<void> {
  const abortController = new AbortController();
  activeStreams.set(streamId, abortController);
  try {
    await agentRuntimeStore.hydrateExecutionSession(sessionId, true);
    // The native backend refreshes policy metadata before execution. Only
    // this conversation's asset bindings are needed, not the global catalog.
    await hydrateSessionAssets(sessionId);
    for await (const chunk of withinExecutionContext(
      input.executionContext,
      pickGenerator(mode, sessionId, input, abortController.signal),
      { native: true, signal: abortController.signal },
    )) {
      // Display output must leave the worker before any persistence barrier.
      const display = chunk.type === "message_delta" || chunk.type === "thought_delta" || chunk.type === "execution_status";
      if (!display || process.env.SYNAX_DURABLE_DELTA_BUFFER === "0") {
        await agentRuntimeStore.flush();
        await businessStore.flush();
      }
      if (chunk.type === "worker_yield") {
        sendAgentSessionToParent({ type: "stream:parked", sessionId, streamId });
        return;
      }
      const deliveryId = flowControl ? await streamCredits.reserve(streamId, chunk, abortController.signal,
        message => sendAgentSessionToParent({ ...message, sessionId })) : undefined;
      sendAgentSessionToParent({
        type: "stream:chunk",
        deliveryId,
        sessionId,
        streamId,
        chunk,
      });
    }
    await agentRuntimeStore.flush();
    await businessStore.flush();
    sendAgentSessionToParent({ type: "stream:done", sessionId, streamId });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    sendAgentSessionToParent({
      type: "stream:error",
      sessionId,
      streamId,
      error,
      code: err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : undefined,
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
  const initialize = async () => {
    if (initialized || !process.connected) return;
    initialized = true;
    try {
      await agentRuntimeStore.hydrateSessionFamily(init.sessionId);
    } catch (error) {
      // A newly started sidecar may not have a projection yet. The worker can
      // still boot and return a structured error for requests against a
      // missing session; the parent host will hydrate the projection later.
      if (!(error instanceof RuntimeSidecarError) || error.code !== "PROJECTION_MISSING") throw error;
      logger.info("[agent-session-runner] runtime projection is not hydrated during bootstrap");
    }
    try {
      await agentRuntimeStore.hydrateExecutionSession(init.sessionId);
    } catch (error) {
      // A worker can be started for a session that was archived or removed
      // after the parent admitted the process. Keep the IPC worker alive so
      // the request receives a structured not-found response instead of a
      // child-process crash.
      if (!(error instanceof AgentNotFoundError) &&
          (!(error instanceof RuntimeSidecarError) || !["PROJECTION_MISSING", "HISTORY_NOT_FOUND"].includes(error.code)))
        throw error;
      logger.info({ sessionId: init.sessionId }, "[agent-session-runner] session missing during bootstrap");
    }
    await businessStore.refresh();
    await hydrateSessionAssets(init.sessionId);
    initialized = true;
    setSessionWorkspaceRoot(init.sessionId, init.workDir);
    bootstrapAgentChildForSession(init.sessionId);
    sendAgentSessionToParent({
      type: "session:ready",
      sessionId: init.sessionId,
    });
    logger.info(
      { sessionId: init.sessionId, pid: process.pid },
      "[agent-session-runner] ready",
    );
  };

  let stopping = false;
  const shutdown = createWorkerShutdown({
    startWatchdog: () => startExitWatchdog(),
    abort(reason) {
      stopping = true;
      for (const controller of activeStreams.values())
        if (!controller.signal.aborted) controller.abort(new Error(reason));
      for (const controller of activeCompactions.values())
        if (!controller.signal.aborted) controller.abort(new Error(reason));
    },
    cleanup: (reason) => [
      Promise.resolve().then(() => terminateOwnedCommands()),
      Promise.resolve().then(() => closeAllBrowserSessions(reason)),
      Promise.allSettled([...runningTasks]),
    ],
    report: (error) => logger.error({ error }, "[agent-session-runner] shutdown failed"),
    flush: flushDiagnosticLogs,
    exit: (code) => process.exit(code),
  });
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

    if (message.type === "session:initialize") {
      void initialize().catch(error => { logger.error({error}, "worker initialization failed"); process.exit(1); });
      return;
    }
    if (!initialized) return;
    if (message.type === "stream:credit") { streamCredits.grant(message.deliveryId, message.error); return; }
    if (message.type === "runtime:notify") { runtimeBus.emit(message.event); return; }
    if (message.type === "stream:yield-request") { yieldWorkerRequested = message.requested; return; }
    if (message.type === "context:cancel") {
      activeCompactions.get(message.requestId)?.abort(new Error("Context compaction cancelled by parent."));
      return;
    }
    if (message.type === "context:compact") {
      const task = runContextCompaction(init.sessionId, message.requestId);
      runningTasks.add(task);
      void task.finally(() => runningTasks.delete(task));
      return;
    }
    if (message.type === "stream:start") {
      const task = runStream(
        init.sessionId,
        message.streamId,
        message.mode,
        message.input,
        message.flowControl,
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
    if (message.type === "session:interrupt-subtree") {
      void (async () => {
        let error: string | undefined;
        try {
          const hosted = agentRuntimeStore.listSessionTree(init.sessionId);
          if (
            !hosted.some(
              (session) =>
                session.id === message.sessionId &&
                session.id !== init.sessionId,
            )
          )
            throw new Error(
              "The requested subagent does not belong to this worker.",
            );
          await Promise.all(agentRuntimeStore.listSessionTree(message.sessionId).map(
            session => rustNativeBackend.interrupt(session.id, message.reason),
          ));
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        sendAgentSessionToParent({
          type: "session:subtree-stopped",
          requestId: message.requestId,
          sessionId: message.sessionId,
          error,
        });
      })();
    }
  });

  sendAgentSessionToParent({
      type: "session:booted",
      sessionId: init.sessionId,
    });
  if (!process.connected)
    void shutdown("Parent disconnected before initialization.");
}

setImmediate(main);
