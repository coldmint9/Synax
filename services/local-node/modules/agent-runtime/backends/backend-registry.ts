import { rustNativeBackend } from "./rust-native-backend.js";
import { agentRuntimeStore } from "../session-store.js";
import { sessionProcessManager } from "../session-process-manager.js";
import { agentSessionsRunInProcess } from "../../../infrastructure/runtime/env.js";
import { ensureInProcessSessionReady } from "../in-process-session-bootstrap.js";
import {
  BACKENDS,
  type BackendAdapter,
  type BackendId,
} from "./backend-contracts.js";

const native: BackendAdapter = {
  async *stream(sessionId, mode, input, signal) {
    if (!agentSessionsRunInProcess()) {
      yield* sessionProcessManager.streamSession(
        sessionId,
        mode,
        input,
        signal,
      );
      // A goal may continue immediately after execution releases its lease.
      // Retained idle workers are reusable; terminating workers must exit first.
      await sessionProcessManager.waitForWorkerRelease(sessionId);
    } else {
      ensureInProcessSessionReady(sessionId);
      yield* rustNativeBackend.stream(sessionId, mode, input, signal);
    }
  },
  async interrupt(sessionId, reason) {
    const ids = agentRuntimeStore
      .listSessionTree(sessionId)
      .map((session) => session.id);
    const results = await Promise.allSettled([
      sessionProcessManager.interruptAndWaitForSessions(ids, reason),
      Promise.all(ids.map(id => rustNativeBackend.interrupt(id, reason))),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  },
  async close(sessionId) {
    await native.interrupt(sessionId, "Session closed.");
  },
};
export function getBackendAdapter(id: BackendId): BackendAdapter {
  if (id === "native") return native;
  throw new Error(`Unsupported backend '${id}'. External engines are removed.`);
}
export function describeBackends() {
  return BACKENDS;
}
