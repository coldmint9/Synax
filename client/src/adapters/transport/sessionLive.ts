import { RustRuntimeConnection, type RuntimeBootstrap } from './rustRuntimeConnection';
import { useRuntimeConnectionStore } from '../../shared/state/runtimeConnectionStore';
import type { LlmRetryState } from "../../../../services/local-node/infrastructure/llm-runtime/retry-state";
export type { LlmRetryState } from "../../../../services/local-node/infrastructure/llm-runtime/retry-state";
import { AuthenticatedEventSource } from "./authenticatedEventSource";
import { useApiConnectivityStore } from "../../shared/lib/apiConnectivity";
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
  ToolCallRecord,
  PermissionDecision,
} from "./agentRuntime";

export type SessionLiveEvent =
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
      event?: RuntimeEvent;
    }
  | { type: "context_compaction_failed"; error: string; event?: RuntimeEvent };

export function sessionLiveStream(
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
        for (const type of ['context_compaction_started', 'context_compacted', 'context_compaction_failed', 'context_compaction_state', 'media_job']) {
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
