import type {
  AgentRuntimeMessage,
  AgentSession,
  RuntimeEvent,
} from "./contracts.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { runtimeTransaction } from "./runtime-transaction.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { sessionLiveBus } from "./session-live-bus.js";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";

export interface ContextCompactionState {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  requestId: string | null;
  originalTokens?: number;
  compressedTokens?: number;
  messageCount?: number;
  compacted?: boolean;
  error?: string;
}

export function readContextCompaction(
  session: AgentSession,
): ContextCompactionState | undefined {
  return session.sessionMetadata?.contextCompaction as
    | ContextCompactionState
    | undefined;
}

/** Commit state, transcript and audit event together, then notify observers. */
export function saveContextCompaction(
  sessionId: string,
  state: ContextCompactionState,
): void {
  const summary =
    state.status === "running"
      ? "正在压缩上下文"
      : state.status === "failed"
        ? "上下文压缩失败"
        : state.compacted
          ? "上下文已压缩"
          : "上下文无需进一步压缩";
  const message: AgentRuntimeMessage = {
    id: state.id,
    sessionId,
    role: "system",
    runId: null,
    stepId: null,
    content: state.error ? `${summary}：${state.error}` : summary,
    metadata: { source: "context_compaction", contextCompaction: state },
    createdAt: state.completedAt ?? state.startedAt,
  };
  const event: RuntimeEvent = {
    id: makeRuntimeId("evt"),
    sessionId,
    type:
      state.status === "running"
        ? "context_compaction_started"
        : state.status === "failed"
          ? "context_compaction_failed"
          : "context_compacted",
    timestamp: state.completedAt ?? state.startedAt,
    visibility: "user_visible",
    summary,
    payload: { ...state },
  };
  const session = runtimeTransaction(() => {
    store.appendMessage(message);
    store.appendEvent(event);
    return store.updateSessionMetadata(sessionId, { contextCompaction: state });
  });
  emitRuntimeBusEvent({
    type: "session_changed",
    sessionId,
    patch: {
      sessionMetadata: session.sessionMetadata,
      updatedAt: session.updatedAt,
    },
  });
  sessionLiveBus.emit(sessionId, {
    type: "context_compaction_state",
    state,
    message,
  });
}

export function interruptContextCompaction(
  sessionId: string,
  error: string,
): void {
  const state = readContextCompaction(store.getSession(sessionId));
  if (state?.status === "running")
    saveContextCompaction(sessionId, {
      ...state,
      status: "failed",
      completedAt: nowIso(),
      error,
    });
}
