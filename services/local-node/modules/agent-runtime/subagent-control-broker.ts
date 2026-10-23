import { createHash } from 'node:crypto';
import { runtimeBus, type RuntimeBusEvent } from './runtime-bus.js';
import { agentRuntimeStore, type AgentRuntimeStore } from './session-store.js';
import { emitRuntimeBusEvent } from './runtime-bus-bridge.js';
import { patchRuntime, runtimeClient, decode } from './sidecar/runtime-repository.js';
import { nowIso } from './runtime-ids.js';
import type { AgentSession } from './contracts.js';

export type SubagentJoinMode = 'blocking' | 'async';
export interface SubagentControlState {
  schema: 1;
  taskId: string;
  parentSessionId: string;
  childSessionId: string;
  joinMode: SubagentJoinMode;
  phase: string;
  status: string;
  revision: number;
  eventSeq: number;
  summary: string | null;
  error: string | null;
  terminal: boolean;
  epoch?: string;
  updatedAt: string;
  /** Cursor acknowledged after the parent consumed this summary. */
  consumedSeq: number;
  /** Cross-session projection receipt; a retry repairs delivery without redoing work. */
  summaryDeliveredSeq: number;
  payloadHash: string;
}
export interface SubagentStateEvent {
  taskId: string;
  parentSessionId: string;
  childSessionId: string;
  joinMode: SubagentJoinMode;
  phase?: string;
  status: string;
  revision: number;
  eventSeq?: number;
  summary?: string | null;
  error?: string | null;
  terminal?: boolean;
  epoch?: string;
  updatedAt?: string;
}
export interface SubagentWaitResult {
  reason: 'terminal' | 'released' | 'aborted' | 'yielded' | 'timeout' | 'recovery_required';
  event?: SubagentControlState;
}
export interface SubagentWaitOptions {
  parentSessionId: string;
  childSessionIds?: readonly string[];
  signal?: AbortSignal;
  shouldYield?: () => boolean | Promise<boolean>;
  timeoutMs?: number;
  store?: AgentRuntimeStore;
}
export const SUBAGENT_CONTROL_METADATA_KEY = 'subagentControl';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const MAX_SUMMARY_BYTES = 8 * 1024;

type SessionView = Pick<AgentSession, 'id' | 'parentSessionId' | 'status' | 'sessionMetadata'>;
export function readSubagentControl(session: Pick<AgentSession, 'sessionMetadata'>): SubagentControlState | null {
  const state = session.sessionMetadata?.[SUBAGENT_CONTROL_METADATA_KEY] as SubagentControlState | undefined;
  if (!state || state.schema !== 1 || !Number.isSafeInteger(state.eventSeq) || state.eventSeq < 1 ||
      !Number.isSafeInteger(state.revision) || !['blocking', 'async'].includes(state.joinMode) ||
      ![state.taskId, state.parentSessionId, state.childSessionId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 256) ||
      typeof state.status !== 'string' || typeof state.terminal !== 'boolean' ||
      typeof state.payloadHash !== 'string' || state.payloadHash.length !== 64) return null;
  return state;
}
export function subagentBlocksParent(session: Pick<AgentSession, 'status' | 'sessionMetadata'>): boolean {
  if (!['queued', 'running'].includes(session.status)) return false;
  const state = readSubagentControl(session);
  return state?.joinMode !== 'async' && !state?.terminal;
}
export function listOwnedSubagentSessions(parentId: string, store: AgentRuntimeStore = agentRuntimeStore): AgentSession[] {
  const root = store.getSession(parentId), queue = [...root.childSessionIds ?? []], seen = new Set<string>([parentId]);
  const sessions: AgentSession[] = [];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    if (seen.has(id)) continue;
    seen.add(id);
    const session = store.tryGetSession(id);
    if (!session) continue;
    sessions.push(session);
    queue.push(...session.childSessionIds ?? []);
  }
  return sessions;
}
export function subagentSummaryMessageId(childSessionId: string): string {
  return `subagent-summary:${childSessionId}`;
}
function validateEvent(event: SubagentStateEvent): void {
  for (const value of [event.taskId, event.parentSessionId, event.childSessionId])
    if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new Error('Invalid subagent identity.');
  if (!Number.isSafeInteger(event.revision) || event.revision < 0 ||
      (event.eventSeq !== undefined && (!Number.isSafeInteger(event.eventSeq) || event.eventSeq < 1))) throw new Error('Invalid subagent revision.');
  if (!['blocking', 'async'].includes(event.joinMode) || !event.status || event.status.length > 64 || (event.phase?.length ?? 0) > 128)
    throw new Error('Invalid subagent state.');
  if (Buffer.byteLength(event.summary ?? '') > MAX_SUMMARY_BYTES || Buffer.byteLength(event.error ?? '') > 4096)
    throw new Error('Subagent summary exceeds its byte budget.');
  if ((event.epoch?.length ?? 0) > 256) throw new Error('Invalid subagent epoch.');
}

/**
 * Durable latest-state mailbox plus a process-local wake-up channel. This is
 * deliberately not an event-log replica: only the latest bounded summary is
 * projected into the parent, while the child keeps its own complete history.
 */
export class SubagentCompletionBroker {
  private readonly waiters = new Set<{ ids: Set<string>; wake: () => void }>();
  private readonly listenersBySession = new Map<string, Set<() => void>>();
  private unsubscribe?: () => void;
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly pendingWrites = new Map<string, number>();
  private totalPendingWrites = 0;

  private subscribe(ids: Set<string>, wake: () => void): { sync: () => boolean; dispose: () => void } {
    if (this.waiters.size >= 128 || ids.size > 256) throw new Error('Subagent waiter capacity reached.');
    const registered = new Set<string>();
    const waiter = { ids, wake };
    this.waiters.add(waiter);
    const sync = () => {
      let changed = false;
      for (const id of ids) if (!registered.has(id)) {
        if (registered.size >= 256) throw new Error('Subagent subscription identity budget exceeded.');
        const listeners = this.listenersBySession.get(id) ?? new Set();
        listeners.add(wake); this.listenersBySession.set(id, listeners); registered.add(id); changed = true;
      }
      return changed;
    };
    sync();
    this.unsubscribe ??= runtimeBus.subscribe(event => this.onRuntimeEvent(event));
    return { sync, dispose: () => {
      for (const id of registered) {
        const listeners = this.listenersBySession.get(id);
        listeners?.delete(wake);
        if (!listeners?.size) this.listenersBySession.delete(id);
      }
      this.waiters.delete(waiter);
      if (!this.waiters.size) { this.unsubscribe?.(); this.unsubscribe = undefined; }
    } };
  }
  private onRuntimeEvent(event: RuntimeBusEvent): void {
    if (['session_changed', 'session_deleted', 'session_input_queue_changed', 'session_process_changed', 'subagent_state_changed'].includes(event.type))
      this.notify(event.sessionId, event.childSessionId);
  }
  notify(sessionId: string, childSessionId?: string): void {
    // Cost is proportional only to listeners for these identities, never every
    // waiter for every token/session event.
    const listeners = new Set(this.listenersBySession.get(sessionId));
    if (childSessionId) for (const listener of this.listenersBySession.get(childSessionId) ?? []) listeners.add(listener);
    for (const listener of listeners) listener();
  }
  /** Test/diagnostic counters contain no session data. */
  get pendingWaiterCount(): number { return this.waiters.size; }

  private async serialized<T>(childId: string, action: () => Promise<T>): Promise<T> {
    const count = this.pendingWrites.get(childId) ?? 0;
    if (count >= 16 || this.totalPendingWrites >= 128) throw new Error('Subagent mailbox is backpressured; await the pending publication.');
    this.totalPendingWrites++;
    this.pendingWrites.set(childId, count + 1);
    const pending = (this.writes.get(childId) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.writes.set(childId, pending);
    try { return await pending; }
    finally {
      this.totalPendingWrites--;
      const remaining = (this.pendingWrites.get(childId) ?? 1) - 1;
      if (remaining) this.pendingWrites.set(childId, remaining); else this.pendingWrites.delete(childId);
      if (this.writes.get(childId) === pending) this.writes.delete(childId);
      this.notify(childId);
    }
  }

  async publish(event: SubagentStateEvent, store: AgentRuntimeStore = agentRuntimeStore, attempt = 0): Promise<SubagentControlState> {
    validateEvent(event);
    return this.serialized(event.childSessionId, async () => {
      if (store === agentRuntimeStore) await store.hydrateSessionSummary(event.childSessionId, true);
      const child = store.getSession(event.childSessionId);
      if (child.parentSessionId !== event.parentSessionId) throw new Error('Subagent event is outside its parent assignment.');
      const previous = readSubagentControl(child);
      if (previous && previous.taskId !== event.taskId) throw new Error('Subagent task binding changed.');
      const payload = { taskId: event.taskId, parentSessionId: event.parentSessionId, childSessionId: event.childSessionId,
        joinMode: event.joinMode, phase: event.phase ?? event.status, status: event.status, revision: event.revision,
        summary: event.summary ?? null, error: event.error ?? null, terminal: event.terminal ?? TERMINAL.has(event.status), epoch: event.epoch };
      const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const eventSeq = event.eventSeq ?? event.revision + 1;
      if (previous && (eventSeq < previous.eventSeq || event.revision < previous.revision)) return previous;
      if (previous && eventSeq === previous.eventSeq) {
        if (previous.payloadHash !== payloadHash) throw new Error('Subagent event sequence was reused with different content.');
        await this.deliverSummary(previous, store);
        this.notify(event.parentSessionId, event.childSessionId);
        return previous;
      }
      if (previous?.terminal && previous.epoch === event.epoch &&
          (['completed', 'cancelled'].includes(previous.status) || ['queued', 'running'].includes(event.status)))
        throw new Error('A terminal subagent epoch cannot be reopened.');
      const state: SubagentControlState = { schema: 1, ...payload, eventSeq, payloadHash,
        updatedAt: event.updatedAt ?? nowIso(), consumedSeq: previous?.consumedSeq ?? 0, summaryDeliveredSeq: previous?.summaryDeliveredSeq ?? 0 };
      await this.persistControl(state, previous, store);
      emitRuntimeBusEvent({ type: 'subagent_state_changed', sessionId: event.parentSessionId,
        childSessionId: event.childSessionId, eventSeq: state.eventSeq });
      await this.deliverSummary(state, store);
      this.notify(event.parentSessionId, event.childSessionId);
      return state;
    }).catch(error => {
      if (attempt < 3 && String(error).includes('METADATA_CONFLICT')) return this.publish(event, store, attempt + 1);
      throw error;
    });
  }

  private async persistControl(state: SubagentControlState, expected: SubagentControlState | null, store: AgentRuntimeStore): Promise<void> {
    if (store === agentRuntimeStore) {
      await store.flushSession(state.childSessionId);
      await patchRuntime(state.childSessionId, 'session_patch', {
        expectedMetadata: { key: SUBAGENT_CONTROL_METADATA_KEY, value: expected },
        patch: { sessionMetadata: { [SUBAGENT_CONTROL_METADATA_KEY]: state } },
      });
      await store.hydrateSessionSummary(state.childSessionId, true);
    } else {
      store.updateSessionMetadata(state.childSessionId, { [SUBAGENT_CONTROL_METADATA_KEY]: state });
      await store.flushSession(state.childSessionId);
    }
  }

  private async deliverSummary(state: SubagentControlState, store: AgentRuntimeStore): Promise<void> {
    if (!state.summary || state.summaryDeliveredSeq >= state.eventSeq) return;
    const parent = store.tryGetSession(state.parentSessionId);
    if (!parent) return; // Recovery retries when the parent is hydrated again.
    const messageId = subagentSummaryMessageId(state.childSessionId);
    const previous = store.getMessage(parent.id, messageId);
    const message = { id: messageId, sessionId: parent.id, runId: null, stepId: null, role: 'assistant' as const,
      content: state.summary, createdAt: previous?.createdAt ?? state.updatedAt,
      metadata: { source: 'subagent_summary', childSessionId: state.childSessionId, taskId: state.taskId, eventSeq: state.eventSeq,
        status: state.status, joinMode: state.joinMode } };
    if (store === agentRuntimeStore) {
      const saved = decode<import('./contracts.js').AgentRuntimeMessage>(await runtimeClient().historyCommand({
        sessionId: parent.id, requestId: `subagent-summary:${state.childSessionId}:${state.eventSeq}:${state.payloadHash}`,
        operation: 'subagent_summary', payload: { message },
      }));
      store.acceptMessageProjection(saved);
    } else {
      store.appendMessage(message);
      await store.flushSession(parent.id);
    }
    const delivered = { ...state, summaryDeliveredSeq: state.eventSeq };
    await this.persistControl(delivered, state, store);
    state.summaryDeliveredSeq = delivered.summaryDeliveredSeq;
  }

  /** Replay the latest durable state and repair a lost cross-session delivery. */
  async recover(parentSessionId: string, childSessionId: string, store: AgentRuntimeStore = agentRuntimeStore): Promise<SubagentControlState | null> {
    await store.hydrateSessionSummary(childSessionId, true);
    await store.hydrateSessionSummary(parentSessionId, true);
    return this.serialized(childSessionId, async () => {
      const child = store.getSession(childSessionId);
      if (child.parentSessionId !== parentSessionId) throw new Error('Subagent does not belong to the parent.');
      const state = readSubagentControl(child);
      if (state) await this.deliverSummary(state, store);
      return state;
    });
  }
  async acknowledge(parentSessionId: string, childSessionId: string, throughSequence: number, store: AgentRuntimeStore = agentRuntimeStore, attempt = 0): Promise<void> {
    await this.serialized(childSessionId, async () => {
      if (store === agentRuntimeStore) await store.hydrateSessionSummary(childSessionId, true);
      const child = store.getSession(childSessionId), state = readSubagentControl(child);
      if (child.parentSessionId !== parentSessionId || !state) throw new Error('Subagent mailbox is unavailable.');
      if (!Number.isSafeInteger(throughSequence) || throughSequence > state.eventSeq) throw new Error('Invalid subagent acknowledgement.');
      if (throughSequence <= state.consumedSeq) return;
      await this.persistControl({ ...state, consumedSeq: throughSequence }, state, store);
    }).catch(error => {
      if (attempt < 3 && String(error).includes('METADATA_CONFLICT')) return this.acknowledge(parentSessionId, childSessionId, throughSequence, store, attempt + 1);
      throw error;
    });
  }

  /** Register-before-read plus a dirty flag covers updates during an async read. */
  async waitForChange<T>(options: {
    ids: Set<string>;
    read: () => T | Promise<T>;
    ready: (value: T) => boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    nextDeadline?: (value: T) => number | undefined;
  }): Promise<{ value?: T; reason: 'ready' | 'aborted' | 'timeout' }> {
    let dirty = true, resolveWake: (() => void) | undefined;
    const wake = () => { dirty = true; resolveWake?.(); resolveWake = undefined; };
    const subscription = this.subscribe(options.ids, wake);
    options.signal?.addEventListener('abort', wake, { once: true });
    const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + Math.max(0, options.timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let value: T | undefined;
    try {
      for (;;) {
        if (options.signal?.aborted) return { value, reason: 'aborted' };
        dirty = false;
        value = await options.read();
        if (subscription.sync()) dirty = true;
        if (options.signal?.aborted) return { value, reason: 'aborted' };
        if (dirty) continue;
        if (options.ready(value)) return { value, reason: 'ready' };
        if (Date.now() >= deadline) return { value, reason: 'timeout' };
        const wakeAt = Math.min(deadline, options.nextDeadline?.(value) ?? Infinity);
        await new Promise<void>(resolve => {
          resolveWake = resolve;
          if (dirty || options.signal?.aborted) { resolveWake = undefined; resolve(); return; }
          if (Number.isFinite(wakeAt)) timer = setTimeout(wake, Math.max(1, wakeAt - Date.now()));
        });
        if (timer) clearTimeout(timer);
        timer = undefined;
      }
    } finally {
      if (timer) clearTimeout(timer);
      resolveWake = undefined;
      options.signal?.removeEventListener('abort', wake);
      subscription.dispose();
    }
  }

  async wait(options: SubagentWaitOptions): Promise<SubagentWaitResult> {
    const store = options.store ?? agentRuntimeStore;
    const ids = new Set([options.parentSessionId, ...(options.childSessionIds ?? [])]);
    const result = await this.waitForChange({ ids, signal: options.signal, timeoutMs: options.timeoutMs,
      read: async () => {
        if (await options.shouldYield?.()) return { reason: 'yielded' } as SubagentWaitResult;
        if (store === agentRuntimeStore) {
          // Cross-process IPC is a hint; refresh only the selected small state.
          await store.hydrateSessionSummary(options.parentSessionId, true);
          const selected = options.childSessionIds ?? store.getSession(options.parentSessionId).childSessionIds ?? [];
          await Promise.all(selected.map(id => store.hydrateSessionSummary(id, true)));
        }
        const children: SessionView[] = options.childSessionIds
          ? options.childSessionIds.flatMap(id => { const child = store.tryGetSession(id); return child ? [child] : []; })
          : (store.getSession(options.parentSessionId).childSessionIds ?? []).flatMap(id => { const child = store.tryGetSession(id); return child ? [child] : []; });
        let event: SubagentControlState | undefined, released = false;
        for (const child of children) {
          ids.add(child.id);
          if (child.parentSessionId !== options.parentSessionId) continue;
          // updateSessionMetadata publishes an in-memory hint before its I/O
          // tail is durable. Do not release a parent until that publication
          // completes; serialized() emits the final wake-up.
          if (this.pendingWrites.has(child.id)) return null;
          const state = readSubagentControl(child);
          if (state && (!event || state.eventSeq > event.eventSeq)) event = state;
          if (state && !state.terminal && ['queued', 'running'].includes(state.status) &&
              ['interrupted', 'failed', 'cancelled'].includes(child.status))
            return { reason: 'recovery_required', event: state } as SubagentWaitResult;
          if (state?.joinMode === 'async' && !state.terminal) { released = true; continue; }
          // A domain-owned control state survives a child run ending or being
          // replaced. Its owner publishes settlement after durable side effects.
          if (state ? !state.terminal : ['queued', 'running'].includes(child.status)) return null;
        }
        return { reason: released ? 'released' : 'terminal', event } as SubagentWaitResult;
      }, ready: value => value !== null });
    if (result.reason !== 'ready') return { reason: result.reason };
    return result.value!;
  }
}
export const subagentCompletionBroker = new SubagentCompletionBroker();
