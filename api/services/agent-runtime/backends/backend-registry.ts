import { claudeBackend } from "./claude-backend.js";
import { codexBackend } from "./codex-backend.js";
import { acpPermissionBridge } from "../acp-engine/acp-permission-bridge.js";
import { agentRuntimeStore } from "../session-store.js";
import { agentLoopRuntime } from "../loop-runtime.js";
import { sessionProcessManager } from "../session-process-manager.js";
import { acpSessionEngine } from "../acp-engine/index.js";
import { forwardChunkToLiveBus } from "../../../lib/ipc/agent-session-protocol.js";
import {
  BACKENDS,
  type BackendAdapter,
  type BackendId,
} from "./backend-contracts.js";

const native: BackendAdapter = {
  async *stream(sessionId, mode, input, signal) {
    if (process.env.SYNAX_AGENT_SESSION_IN_PROCESS !== "1") {
      yield* sessionProcessManager.streamSession(
        sessionId,
        mode,
        input,
        signal,
      );
      // A goal may start its next round immediately. The previous worker must exit first.
      await sessionProcessManager.waitForIdleSessions([sessionId]);
    } else if (mode === "continue") {
      yield* agentLoopRuntime.streamContinue(sessionId, input, signal);
    } else {
      yield* agentLoopRuntime.streamRun(
        sessionId,
        input,
        signal,
        mode === "resume",
      );
    }
  },
  async interrupt(sessionId, reason) {
    const ids = agentRuntimeStore
      .listSessionTree(sessionId)
      .map((session) => session.id);
    await sessionProcessManager.interruptAndWaitForSessions(ids, reason);
    await agentLoopRuntime.interruptAndWaitForSessions(ids, reason);
  },
  async close(sessionId) {
    await native.interrupt(sessionId, "Session closed.");
  },
};
const acp: BackendAdapter = {
  async *stream(sessionId, mode, input, signal) {
    for await (const chunk of acpSessionEngine.stream(
      sessionId,
      mode,
      input,
      signal,
    )) {
      forwardChunkToLiveBus(sessionId, chunk);
      yield chunk;
    }
  },
  interrupt: (sessionId, reason) =>
    acpSessionEngine.interruptSession(sessionId, reason),
  close: (sessionId) => acpSessionEngine.closeSession(sessionId),
  hasPendingPermission: (sessionId, id) =>
    acpPermissionBridge.hasPendingPermission(sessionId, id),
  replyPermission(sessionId, id, reply) {
    const resolved = acpPermissionBridge.resolve(sessionId, id, reply);
    if (resolved && !acpPermissionBridge.hasPendingForSession(sessionId))
      agentRuntimeStore.updateSession(sessionId, {
        status: "running",
        pendingResumeToken: null,
      });
    return resolved;
  },
};

export function getBackendAdapter(id: BackendId): BackendAdapter {
  if (id === "native") return native;
  if (id === "codex") return codexBackend;
  if (id === "claude-code") return claudeBackend;
  return acp;
}
export function describeBackends() {
  return BACKENDS;
}
