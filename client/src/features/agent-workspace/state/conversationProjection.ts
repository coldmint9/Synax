import type { AgentSession } from "../../../adapters/transport/agentRuntime";
import type { RuntimeChunk } from "../../../adapters/transport/runtimeStream";
import type { SessionLiveEvent } from "../../../adapters/transport/sessionLive";
import { applyMessageDelta, applyThoughtDelta, applyToolCall, applyToolResult, EMPTY_STREAMING_BUFFERS, isStreamingLiveEmpty, snapshotStreamingBuffers } from "../streamingLiveBlocks";
import { retirePersistedSnapshots } from "./liveStepRetirement";
import type { ConversationState } from "./conversationController";

export function upsertConversationRecord<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex(existing => existing.id === item.id);
  if (index < 0) return [...items, item];
  if (items[index] === item) return items;
  const next = [...items];
  next[index] = item;
  return next;
}

function patchSession(session: AgentSession | null, patch: Partial<AgentSession>): AgentSession | null {
  if (!session) return session;
  return { ...session, ...patch, ...(patch.sessionMetadata ? { sessionMetadata: { ...session.sessionMetadata, ...patch.sessionMetadata } } : {}) };
}

export function retireConversationSnapshots(state: ConversationState): ConversationState {
  const { steps, messages, toolCalls } = state.history;
  const snapshots = retirePersistedSnapshots(state.streamingCompletedSteps, steps, messages, toolCalls);
  return snapshots === state.streamingCompletedSteps ? state : { ...state, streamingCompletedSteps: snapshots };
}

function parkCurrentStep(state: ConversationState): ConversationState {
  if (!state.streamingStepId || isStreamingLiveEmpty(state.streamingLive)) return state;
  const step = state.history.steps.find(item => item.id === state.streamingStepId);
  const snapshot = {
    stepId: state.streamingStepId,
    stepIndex: step?.index ?? 0,
    runId: step?.runId ?? state.session?.activeRunId ?? undefined,
    startedAt: step?.startedAt,
    rendered: true,
    blocks: snapshotStreamingBuffers(state.streamingLive),
  };
  return { ...state, streamingCompletedSteps: [...state.streamingCompletedSteps.filter(item => item.stepId !== snapshot.stepId), snapshot] };
}

function applyChunk(state: ConversationState, chunk: RuntimeChunk): ConversationState {
  if (chunk.type === "step_started" && chunk.step) {
    if (chunk.step.sessionId !== state.sessionId) return state;
    const same = state.streamingStepId === chunk.step.id;
    const next = same ? state : parkCurrentStep(state);
    return {
      ...next,
      history: { ...next.history, steps: upsertConversationRecord(next.history.steps, chunk.step) },
      streamingStepId: chunk.step.id,
      streamingLive: same ? next.streamingLive : EMPTY_STREAMING_BUFFERS,
      streamingRetry: same ? next.streamingRetry : null,
    };
  }
  if (!chunk.stepId || chunk.stepId !== state.streamingStepId) {
    if ((chunk.type === "tool_call" || chunk.type === "tool_result") && chunk.toolCall?.sessionId === state.sessionId)
      return { ...state, history: { ...state.history, toolCalls: upsertConversationRecord(state.history.toolCalls, chunk.toolCall) } };
    return state;
  }
  if (chunk.type === "message_delta") return { ...state, streamingLive: applyMessageDelta(state.streamingLive, chunk.delta ?? "") };
  if (chunk.type === "thought_delta") return { ...state, streamingLive: applyThoughtDelta(state.streamingLive, chunk.delta ?? "") };
  if ((chunk.type === "tool_call" || chunk.type === "tool_result") && chunk.toolCall?.sessionId === state.sessionId) {
    return {
      ...state,
      history: { ...state.history, toolCalls: upsertConversationRecord(state.history.toolCalls, chunk.toolCall) },
      streamingLive: (chunk.type === "tool_call" ? applyToolCall : applyToolResult)(state.streamingLive, chunk.toolCall),
    };
  }
  if (chunk.type === "retry_status" && chunk.retry) return {
    ...state,
    streamingRetry: chunk.retry.phase === "recovered" ? null : chunk.retry,
    streamingLive: chunk.retry.phase === "waiting" || chunk.retry.phase === "group_wait" ? EMPTY_STREAMING_BUFFERS : state.streamingLive,
  };
  return state;
}

/** Only persisted records are replayed over an HTTP read; deltas stay in their live projection. */
export function mergeConversationEventRecords(state: ConversationState, event: SessionLiveEvent): ConversationState {
  if ("sessionId" in event && event.sessionId !== state.sessionId) return state;
  switch (event.type) {
    case "runtime_snapshot": {
      let history = state.history;
      if (event.run) history = { ...history, runs: upsertConversationRecord(history.runs, event.run) };
      for (const chunk of event.liveChunks) {
        if (chunk.step?.sessionId === state.sessionId) history = { ...history, steps: upsertConversationRecord(history.steps, chunk.step) };
        if (chunk.toolCall?.sessionId === state.sessionId) history = { ...history, toolCalls: upsertConversationRecord(history.toolCalls, chunk.toolCall) };
      }
      return { ...state, session: event.session, history };
    }
    case "runtime_state": return { ...state, session: patchSession(state.session, event.patch), history: event.run ? { ...state.history, runs: upsertConversationRecord(state.history.runs, event.run) } : state.history };
    case "execution_status": return { ...state, history: { ...state.history, runs: state.history.runs.map(run => run.id === event.runId ? { ...run, execution: event.execution } : run) } };
    case "message": return event.message.sessionId === state.sessionId ? { ...state, history: { ...state.history, messages: upsertConversationRecord(state.history.messages, event.message) } } : state;
    case "event": return event.event.sessionId === state.sessionId ? { ...state, history: { ...state.history, events: upsertConversationRecord(state.history.events, event.event) } } : state;
    case "permission_updated": return event.permission.sessionId === state.sessionId ? { ...state, history: { ...state.history, permissions: upsertConversationRecord(state.history.permissions, event.permission) } } : state;
    case "context_compaction_state": return event.message.sessionId === state.sessionId ? { ...state, history: { ...state.history, messages: upsertConversationRecord(state.history.messages, event.message) } } : state;
    case "conversation_git_messages": {
      let messages = state.history.messages;
      for (const message of event.messages) if (message.sessionId === state.sessionId) messages = upsertConversationRecord(messages, message);
      return messages === state.history.messages ? state : { ...state, history: { ...state.history, messages } };
    }
    case "step_started": return event.step?.sessionId === state.sessionId ? { ...state, history: { ...state.history, steps: upsertConversationRecord(state.history.steps, event.step) } } : state;
    case "tool_call":
    case "tool_result": return event.toolCall.sessionId === state.sessionId ? { ...state, history: { ...state.history, toolCalls: upsertConversationRecord(state.history.toolCalls, event.toolCall) } } : state;
    default: return state;
  }
}

export function applyConversationEvent(state: ConversationState, event: SessionLiveEvent): ConversationState {
  if ("sessionId" in event && event.sessionId !== state.sessionId) return state;
  if (event.type === "runtime_snapshot") {
    let next = mergeConversationEventRecords(parkCurrentStep(state), event);
    next = { ...next, streamingStepId: null, streamingLive: EMPTY_STREAMING_BUFFERS, streamingRetry: null };
    for (const chunk of event.liveChunks) next = applyChunk(next, chunk);
    // Reconnect snapshots replace, rather than append to, the current step.
    if (next.streamingStepId) next = { ...next, streamingCompletedSteps: next.streamingCompletedSteps.filter(item => item.stepId !== next.streamingStepId) };
    if (!isConversationActive(event.session.status)) next = { ...parkCurrentStep(next), streamingStepId: null, streamingLive: EMPTY_STREAMING_BUFFERS, streamingRetry: null };
    return retireConversationSnapshots(next);
  }
  if (event.type === "runtime_state") {
    const settled = event.reset || (event.patch.status !== undefined && !isConversationActive(event.patch.status));
    const next = mergeConversationEventRecords(settled ? parkCurrentStep(state) : state, event);
    return retireConversationSnapshots(settled ? { ...next, streamingStepId: null, streamingLive: EMPTY_STREAMING_BUFFERS, streamingRetry: null } : next);
  }
  if (["step_started", "message_delta", "thought_delta", "tool_call", "tool_result", "retry_status"].includes(event.type)) {
    return applyChunk(state, event as RuntimeChunk);
  }
  return retireConversationSnapshots(mergeConversationEventRecords(state, event));
}

export function isConversationActive(status: AgentSession["status"]): boolean {
  return ["running", "queued", "waiting_permission", "waiting_input", "stopping"].includes(status);
}
