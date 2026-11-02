import type { ContextCompactionState } from "./context-compaction-state.js";
import type { LlmRetryState } from "../../infrastructure/llm-runtime/retry-state.js";
import type {
  AgentRuntimeMessage,
  RuntimeEvent,
  ToolCallRecord,
} from "./contracts.js";
import { isSessionEventsQuiesced } from "./runtime-event-quiesce.js";
import type { ConversationGitStateEvent } from './conversation-git/contracts.js';

export type SessionLiveEvent =
  | ConversationGitStateEvent
  | { type: "conversation_git_messages"; messages: AgentRuntimeMessage[] }
  | { type: "media_job"; jobId: string; status: string | undefined; resultAssetIds: string[] }
  | {
      type: "context_compaction_state";
      state: ContextCompactionState;
      message: AgentRuntimeMessage;
    }
  | { type: "retry_status"; stepId: string; retry: LlmRetryState }
  | {
      type: "step_started";
      stepId: string;
      stepIndex: number;
      modelCapabilities?: { reasoning: boolean };
    }
  | {
      type: "message_delta";
      stepId: string;
      delta: string;
      /** Cumulative output-token estimate for this step at emission time. */
      outputTokens?: number;
    }
  | {
      type: "thought_delta";
      stepId: string;
      delta: string;
      /** Cumulative reasoning-token estimate for this step at emission time. */
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

const MAX_BUFFERED_EVENTS = 2000;
const MAX_SESSION_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * MAX_SESSION_BYTES;
const MAX_BUFFERED_SESSIONS = 128;
const BUFFER_TTL_MS = 60_000;
type BufferedEvent = { event: SessionLiveEvent; bytes: number };
type BufferState = { events: Map<string | number, BufferedEvent>; bytes: number; expiresAt: number };
type Subscriber = { receive: (event: SessionLiveEvent) => void };

/** Best-effort hints only. Durable history and domain snapshots remain authoritative. */
export class SessionLiveBus {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly buffers = new Map<string, BufferState>();
  private bytes = 0;
  private nextEventId = 0;
  private expiry?: ReturnType<typeof setTimeout>;

  private dropBuffer(sessionId: string): void {
    const state = this.buffers.get(sessionId);
    if (state) this.bytes -= state.bytes;
    this.buffers.delete(sessionId);
    if (!this.buffers.size) {
      clearTimeout(this.expiry);
      this.expiry = undefined;
    }
  }

  private scheduleExpiry(): void {
    if (this.expiry || !this.buffers.size) return;
    const earliest = Math.min(...[...this.buffers.values()].map(state => state.expiresAt));
    this.expiry = setTimeout(() => {
      this.expiry = undefined;
      for (const [id, state] of this.buffers) if (state.expiresAt <= Date.now()) this.dropBuffer(id);
      this.scheduleExpiry();
    }, Math.max(1, earliest - Date.now()));
    this.expiry.unref?.();
  }

  private bufferEvent(sessionId: string, event: SessionLiveEvent): void {
    // Never pin an arbitrary full tool result in an abandoned session's heap.
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > MAX_SESSION_BYTES) return;
    const state = this.buffers.get(sessionId) ?? { events: new Map(), bytes: 0, expiresAt: Date.now() + BUFFER_TTL_MS };
    // Only replace complete state hints. File deltas must retain their ordering;
    // overflow drops old hints and reconnect repairs from the domain snapshot.
    const key = event.type === 'conversation_git_state' && !event.files && !event.changedFileIds?.length && !event.changedFiles?.length
      ? `merge:${event.taskId}` : ++this.nextEventId;
    if (typeof key === 'string') {
      const previous = state.events.get(key);
      if (previous) {
        if (previous.event.type === 'conversation_git_state' && event.type === 'conversation_git_state' && previous.event.eventSeq > event.eventSeq) return;
        state.events.delete(key);
        state.bytes -= previous.bytes;
        this.bytes -= previous.bytes;
      }
    }
    state.events.set(key, { event, bytes });
    state.bytes += bytes;
    this.bytes += bytes;
    while (state.events.size > MAX_BUFFERED_EVENTS || state.bytes > MAX_SESSION_BYTES) {
      const oldest = state.events.keys().next().value!;
      const removed = state.events.get(oldest)!;
      state.events.delete(oldest);
      state.bytes -= removed.bytes;
      this.bytes -= removed.bytes;
    }
    this.buffers.set(sessionId, state);
    while (this.buffers.size > MAX_BUFFERED_SESSIONS || this.bytes > MAX_TOTAL_BYTES)
      this.dropBuffer(this.buffers.keys().next().value!);
    this.scheduleExpiry();
  }

  emit(sessionId: string, event: SessionLiveEvent): void {
    // A quiesced (tearing-down) session has no transcript left to stream to.
    if (isSessionEventsQuiesced(sessionId)) return;
    const listeners = this.subscribers.get(sessionId);
    if (!listeners?.size) return this.bufferEvent(sessionId, event);
    for (const listener of [...listeners]) listener.receive(event);
  }

  subscribe(
    sessionId: string,
    handler: (event: SessionLiveEvent) => void,
  ): () => void {
    const listeners = this.subscribers.get(sessionId) ?? new Set<Subscriber>();
    // Register before draining. A handler may synchronously emit another event;
    // queue it behind the replay instead of losing it between drain and subscribe.
    const pending = [...this.buffers.get(sessionId)?.events.values() ?? []].map(item => item.event);
    let draining = true;
    const deliver = (event: SessionLiveEvent) => {
      try { handler(event); }
      catch (error) { console.warn('[session-live-bus] observer failed', error instanceof Error ? error.message : 'unknown error'); }
    };
    const subscriber = { receive: (event: SessionLiveEvent) => {
      if (draining) {
        if (pending.length < MAX_BUFFERED_EVENTS) pending.push(event);
      } else deliver(event);
    } };
    listeners.add(subscriber);
    this.subscribers.set(sessionId, listeners);
    this.dropBuffer(sessionId);
    // Bound reentrant replay work as well as retained memory.
    for (let count = 0; count < pending.length && count < MAX_BUFFERED_EVENTS; count++) deliver(pending[count]);
    pending.length = 0;
    draining = false;
    return () => {
      listeners.delete(subscriber);
      if (!listeners.size && this.subscribers.get(sessionId) === listeners) this.subscribers.delete(sessionId);
    };
  }

  clearBuffer(sessionId: string): void {
    this.dropBuffer(sessionId);
  }

  cleanup(sessionId: string): void {
    this.clearBuffer(sessionId);
    this.subscribers.get(sessionId)?.clear();
    this.subscribers.delete(sessionId);
  }

  diagnostics() {
    return { sessions: this.subscribers.size, listeners: [...this.subscribers.values()].reduce((n, set) => n + set.size, 0),
      bufferedSessions: this.buffers.size, bufferedBytes: this.bytes, expiryTimers: this.expiry ? 1 : 0 };
  }
}

export const sessionLiveBus = new SessionLiveBus();
