import { onRunObservation, observeRunRealtime, setRunRealtimeObservation } from "./runRealtime";
import { RustRuntimeConnection, type RuntimeBootstrap } from './rustRuntimeConnection';
import { useRuntimeConnectionStore } from '../../shared/state/runtimeConnectionStore';
import type { LlmRetryState } from "../../../../services/local-node/infrastructure/llm-runtime/retry-state";
export type { LlmRetryState } from "../../../../services/local-node/infrastructure/llm-runtime/retry-state";
import { AuthenticatedEventSource } from "./authenticatedEventSource";
import { useApiConnectivityStore } from "../../shared/lib/apiConnectivity";
import type { ConversationGitStateEvent } from '../../../../services/local-node/modules/agent-runtime/conversation-git/contracts';
import {
  RuntimeStreamProjector,
  type RuntimeSnapshotEvent,
  type RuntimeSnapshot,
  type RuntimeStreamRecord,
} from "./runtimeStream";
import type {
  AgentRun,
  AgentRunStep,
  AgentSession,
  RuntimeEvent,
  AgentRuntimeMessage,
  ContextCompactionState,
  ContextUsageSnapshot,
  ToolCallRecord,
  PermissionDecision,
} from "./agentRuntime";

export type SessionLiveEvent =
  | ConversationGitStateEvent
  | { type: 'domain_reconnected'; sessionId: string }
  | { type: "conversation_git_messages"; messages: AgentRuntimeMessage[] }
  | { type: "execution_status"; sessionId: string; runId: string; execution: import("./agentRuntime").ToolExecutionProgress }
  | { type: "message"; message: AgentRuntimeMessage }
  | { type: "event"; event: RuntimeEvent }
  | { type: "permission_updated"; permission: PermissionDecision }
  | { type: "input_queue_changed"; sessionId: string; queueRevision: number }
  | RuntimeSnapshotEvent
  | { type: "media_job"; jobId: string; status: string; resultAssetIds: string[] }
  | {
      type: "context_compaction_state";
      state: ContextCompactionState;
      message: AgentRuntimeMessage;
    }
  | { type: "retry_status"; stepId: string; retry: LlmRetryState }
  | {
      type: "runtime_state";
      sessionId: string;
      patch: Partial<AgentSession>;
      run?: AgentRun;
      reset: boolean;
      refresh: boolean;
    }
  | {
      type: "step_started";
      stepId: string;
      stepIndex: number;
      step?: AgentRunStep;
    }
  | {
      type: "message_delta";
      stepId: string;
      delta: string;
      outputTokens?: number;
    }
  | {
      type: "thought_delta";
      stepId: string;
      delta: string;
      thinkingTokens?: number;
    }
  | { type: "tool_call"; stepId: string; toolCall: ToolCallRecord }
  | { type: "tool_result"; stepId: string; toolCall: ToolCallRecord }
  | { type: "context_compaction_started"; event?: RuntimeEvent }
  | {
      type: "context_compacted";
      stepId: string;
      originalTokens: number;
      compressedTokens: number;
      messageCount: number;
      contextUsage?: ContextUsageSnapshot;
      event?: RuntimeEvent;
    }
  | { type: "context_compaction_failed"; error: string; event?: RuntimeEvent };

const ACTIVE_SESSION_STATUSES = new Set<AgentSession["status"]>([
  "running",
  "queued",
  "waiting_permission",
  "waiting_input",
]);

function isTerminalLifecycleEvent(event: SessionLiveEvent): boolean {
  if (event.type === "runtime_state") {
    return typeof event.patch.status === "string" &&
      !ACTIVE_SESSION_STATUSES.has(event.patch.status);
  }
  if (event.type === "runtime_snapshot") {
    return !ACTIVE_SESSION_STATUSES.has(event.session.status);
  }
  return false;
}

/** Give the run stream sole ownership of live projections. Session events
 * still carry auxiliary domains and discover runs created by another client.
 * On replay expiry, rebuild from one durable snapshot before accepting deltas. */
export function sessionLiveStream(
  sessionId: string, onEvent: (event: SessionLiveEvent) => void, onError?: (err: Event) => void,
): () => void {
  let activeRun: string | null = null;
  let closed = false;
  let stopRun: (() => void) | undefined;
  let stopDurable: (() => void) | undefined;
  const unavailable = new Set<string>();
  const recover = () => {
    if (closed) return;
    if (activeRun) unavailable.add(activeRun);
    activeRun = null;
    setRunRealtimeObservation(sessionId, null);
    stopRun?.(); stopRun = undefined;
    stopDurable?.();
    stopDurable = durableSessionLiveStream(sessionId, receive, onError);
  };
  const start = (runId: string | null) => {
    if (!runId) { recover(); return; }
    if (activeRun === runId || unavailable.has(runId)) return;
    if (activeRun) unavailable.add(activeRun);
    if (unavailable.size > 64) unavailable.delete(unavailable.values().next().value!);
    stopRun?.(); activeRun = runId;
    setRunRealtimeObservation(sessionId, runId);
    stopRun = observeRunRealtime(
      sessionId,
      runId,
      event => {
        if (isTerminalLifecycleEvent(event)) finishActiveRun();
        onEvent(event);
      },
      recover,
    );
  };
  const finishActiveRun = () => {
    activeRun = null;
    setRunRealtimeObservation(sessionId, null);
    stopRun?.();
    stopRun = undefined;
  };
  const core = new Set(['runtime_snapshot', 'runtime_state', 'message', 'event', 'permission_updated',
    'execution_status', 'step_started', 'retry_status', 'message_delta', 'thought_delta', 'tool_call', 'tool_result']);
  const receive = (event: SessionLiveEvent) => {
    const run = event.type === 'runtime_snapshot' || event.type === 'runtime_state' ? event.run : undefined;
    if (run && ['queued', 'running'].includes(run.status)) start(run.id);
    if (activeRun && core.has(event.type)) {
      // Terminal records are written to the durable stream after the final
      // reply is persisted. The run realtime channel intentionally does not
      // carry those records, so do not filter the durable terminal state out
      // while the realtime observation is still attached.
      if (!isTerminalLifecycleEvent(event)) return;
      finishActiveRun();
    }
    onEvent(event);
  };
  const unsubscribe = onRunObservation(sessionId, start);
  stopDurable = durableSessionLiveStream(sessionId, receive, onError);
  return () => { closed = true; setRunRealtimeObservation(sessionId, null); unsubscribe(); stopRun?.(); stopDurable?.(); };
}

function durableSessionLiveStream(
  sessionId: string,
  onEvent: (event: SessionLiveEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  const desktop = (window as unknown as { electronAPI?: {
    getRuntimeConnection?: (sessionId: string, clientId: string, snapshot: boolean) => Promise<RuntimeBootstrap>;
  } }).electronAPI;
  if (!desktop?.getRuntimeConnection) return nodeSessionLiveStream(sessionId, onEvent, onError);
  const projector = new RuntimeStreamProjector();
  const clientId = crypto.randomUUID();
  let auxiliary: AuthenticatedEventSource | undefined;
  let fallback: (() => void) | undefined;
  const connection = new RustRuntimeConnection({
    sessionId,
    bootstrap: async (snapshot, signal) => {
      const result = await desktop.getRuntimeConnection!(sessionId, clientId, snapshot);
      signal.throwIfAborted();
      return result;
    },
    snapshot: value => {
      useApiConnectivityStore.getState().markSuccess();
      for (const projected of projector.snapshot(value)) onEvent(projected);
      // These events belong to non-agent domains until their own storage migration.
      if (!auxiliary) {
        auxiliary = new AuthenticatedEventSource(`/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/stream?auxiliary=1`);
        auxiliary.onopen = () => onEvent({ type: 'domain_reconnected', sessionId });
        for (const type of ['context_compaction_started', 'context_compacted', 'context_compaction_failed', 'context_compaction_state', 'media_job', 'conversation_git_messages', 'conversation_git_state']) {
          auxiliary.addEventListener(type, event => {
            try { onEvent(JSON.parse(event.data) as SessionLiveEvent); }
            catch (error) { console.error(`Invalid ${type} event`, error); }
          });
        }
      }
    },
    record: record => { for (const projected of projector.record(record)) onEvent(projected); },
    state: state => useRuntimeConnectionStore.getState().set(sessionId, state),
    fallback: () => {
      useRuntimeConnectionStore.getState().remove(sessionId);
      fallback = nodeSessionLiveStream(sessionId, onEvent, onError);
    },
    error: error => console.warn('Runtime connection recovering:', error.message),
  });
  const lifecycle = new AbortController();
  const wake = () => { if (document.visibilityState !== 'hidden') connection.wake(); };
  window.addEventListener('online', wake, { signal: lifecycle.signal });
  window.addEventListener('pageshow', wake, { signal: lifecycle.signal });
  document.addEventListener('visibilitychange', wake, { signal: lifecycle.signal });
  connection.start();
  return () => {
    lifecycle.abort(); connection.close(); auxiliary?.close(); fallback?.();
    useRuntimeConnectionStore.getState().remove(sessionId);
  };
}

function nodeSessionLiveStream(
  sessionId: string,
  onEvent: (event: SessionLiveEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  const projector = new RuntimeStreamProjector();
  const es = new AuthenticatedEventSource(
    `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/stream`,
  );
  es.onopen = () => onEvent({ type: 'domain_reconnected', sessionId });
  es.addEventListener("snapshot", (event: MessageEvent) => {
    try {
      useApiConnectivityStore.getState().markSuccess();
      for (const projected of projector.snapshot(
        JSON.parse(event.data) as RuntimeSnapshot,
      ))
        onEvent(projected);
    } catch (error) {
      console.error("Invalid runtime snapshot", error);
    }
  });
  es.addEventListener("chunk", (event: MessageEvent) => {
    try {
      for (const projected of projector.record(
        JSON.parse(event.data) as RuntimeStreamRecord,
      ))
        onEvent(projected);
    } catch (error) {
      console.error("Invalid runtime stream record", error);
    }
  });
  for (const type of [
    "context_compaction_started",
    "context_compacted",
    "context_compaction_failed",
    "context_compaction_state",
    "media_job",
    "conversation_git_messages",
    "conversation_git_state",
  ] as const) {
    es.addEventListener(type, (event: MessageEvent) => {
      try {
        onEvent(JSON.parse(event.data) as SessionLiveEvent);
      } catch (error) {
        console.error(`Invalid ${type} event`, error);
      }
    });
  }
  es.onerror = (event) => {
    // CONNECTING is a recoverable observation failure; AuthenticatedEventSource reconnects and receives a fresh snapshot.
    if (es.readyState === AuthenticatedEventSource.CLOSED) {
      es.close();
      onError?.(event);
    }
  };
  return () => es.close();
}
