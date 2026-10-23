import { describe, expect, it, vi } from 'vitest';
import { SubagentCompletionBroker, readSubagentControl, subagentBlocksParent } from '../subagent-control-broker.js';
import { runtimeBus } from '../runtime-bus.js';
import type { AgentSession, AgentRuntimeMessage } from '../contracts.js';
import type { AgentRuntimeStore } from '../session-store.js';

function fixture() {
  const sessions = new Map<string, AgentSession>([
    ['parent', { id: 'parent', parentSessionId: null, childSessionIds: ['child'], status: 'running', sessionMetadata: null } as AgentSession],
    ['child', { id: 'child', parentSessionId: 'parent', status: 'running', sessionMetadata: null } as AgentSession],
  ]);
  const messages = new Map<string, AgentRuntimeMessage>();
  const store = {
    getSession: (id: string) => { const value = sessions.get(id); if (!value) throw new Error('Missing session'); return structuredClone(value); },
    tryGetSession: (id: string) => sessions.has(id) ? structuredClone(sessions.get(id)) : undefined,
    listSessionTree: () => [...sessions.values()].map(item => structuredClone(item)),
    updateSessionMetadata: (id: string, patch: Record<string, unknown>) => {
      const session = sessions.get(id)!;
      session.sessionMetadata = { ...session.sessionMetadata, ...structuredClone(patch) };
      runtimeBus.emit({ type: 'session_changed', sessionId: id });
      return structuredClone(session);
    },
    flushSession: vi.fn(async (_id: string) => {}),
    hydrateSessionSummary: vi.fn(async (_id: string) => {}),
    getMessage: (_sessionId: string, id: string) => messages.get(id),
    appendMessage: (message: AgentRuntimeMessage) => { messages.set(message.id, structuredClone(message)); return message; },
  };
  const event = { taskId: 'task', parentSessionId: 'parent', childSessionId: 'child', joinMode: 'blocking' as const,
    status: 'running', revision: 1, eventSeq: 1, summary: 'One file resolved.' };
  return { sessions, messages, store: store as unknown as AgentRuntimeStore, methods: store, event };
}

describe('SubagentCompletionBroker', () => {
  it('routes events only to the indexed waiters and releases orphaned domain work', async () => {
    const broker = new SubagentCompletionBroker();
    const controllers = Array.from({ length: 64 }, () => new AbortController());
    const reads = controllers.map(() => vi.fn(() => false));
    const waits = controllers.map((controller, index) => broker.waitForChange({ ids: new Set([`s-${index}`]),
      signal: controller.signal, read: reads[index], ready: value => value }));
    await Promise.resolve();
    broker.notify('s-12');
    await Promise.resolve();
    await Promise.resolve();
    expect(reads[12]).toHaveBeenCalledTimes(2);
    for (let index = 0; index < reads.length; index++) if (index !== 12) expect(reads[index]).toHaveBeenCalledTimes(1);
    controllers.forEach(controller => controller.abort());
    await Promise.all(waits);
    expect(broker.pendingWaiterCount).toBe(0);
    const f = fixture();
    await broker.publish(f.event, f.store);
    f.sessions.get('child')!.status = 'interrupted';
    expect(await broker.wait({ parentSessionId: 'parent', store: f.store })).toMatchObject({ reason: 'recovery_required' });
  });
  it('does not mistake intermediate progress for completion and releases the waiter without timers', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), broker = new SubagentCompletionBroker();
      let settled = false;
      const waiting = broker.wait({ parentSessionId: 'parent', childSessionIds: ['child'], store: f.store }).then(value => { settled = true; return value; });
      await broker.publish(f.event, f.store);
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await broker.publish({ ...f.event, revision: 2, eventSeq: 2, joinMode: 'async', summary: 'Safe to continue other work.' }, f.store);
      expect(await waiting).toMatchObject({ reason: 'released', event: { eventSeq: 2, joinMode: 'async' } });
      expect(broker.pendingWaiterCount).toBe(0);
      expect(subagentBlocksParent(f.sessions.get('child')!)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('does not lose a notification while an async state read is pending', async () => {
    const broker = new SubagentCompletionBroker();
    let state = false, release!: () => void, calls = 0;
    const firstRead = new Promise<void>(resolve => { release = resolve; });
    const waiting = broker.waitForChange({ ids: new Set(['child']), read: async () => {
      const snapshot = state;
      if (++calls === 1) await firstRead;
      return snapshot;
    }, ready: value => value });
    state = true;
    broker.notify('child');
    release();
    expect(await waiting).toEqual({ value: true, reason: 'ready' });
    expect(calls).toBe(2);
    expect(broker.pendingWaiterCount).toBe(0);
  });

  it('cleans up subscriptions and deadlines after abort or timeout', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), broker = new SubagentCompletionBroker(), controller = new AbortController();
      const aborted = broker.wait({ parentSessionId: 'parent', store: f.store, signal: controller.signal, timeoutMs: 30_000 });
      await Promise.resolve();
      controller.abort();
      expect(await aborted).toEqual({ reason: 'aborted' });
      expect(broker.pendingWaiterCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      const timed = broker.wait({ parentSessionId: 'parent', store: f.store, timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      expect(await timed).toEqual({ reason: 'timeout' });
      expect(broker.pendingWaiterCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('recovers the durable latest state and repairs summary delivery without accumulating messages', async () => {
    const f = fixture(), first = new SubagentCompletionBroker();
    f.methods.flushSession.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { throw new Error('Lost parent acknowledgement'); });
    await expect(first.publish(f.event, f.store)).rejects.toThrow('Lost parent acknowledgement');
    expect(readSubagentControl(f.sessions.get('child')!)).toMatchObject({ eventSeq: 1, summaryDeliveredSeq: 0 });
    const restarted = new SubagentCompletionBroker();
    expect(await restarted.recover('parent', 'child', f.store)).toMatchObject({ eventSeq: 1, summaryDeliveredSeq: 1 });
    await restarted.publish(f.event, f.store);
    await restarted.publish({ ...f.event, revision: 2, eventSeq: 2, summary: 'All files resolved.', status: 'completed' }, f.store);
    expect(f.messages.size).toBe(1);
    expect([...f.messages.values()][0].content).toBe('All files resolved.');
    await restarted.acknowledge('parent', 'child', 2, f.store);
    expect(readSubagentControl(f.sessions.get('child')!)).toMatchObject({ consumedSeq: 2 });
    expect(await restarted.wait({ parentSessionId: 'parent', store: f.store })).toMatchObject({ reason: 'terminal' });
  });

  it('rejects sequence collisions, foreign owners, oversized payloads and late writes to a terminal epoch', async () => {
    const f = fixture(), broker = new SubagentCompletionBroker();
    await broker.publish(f.event, f.store);
    await expect(broker.publish({ ...f.event, summary: 'Different event.' }, f.store)).rejects.toThrow('reused');
    await expect(broker.publish({ ...f.event, parentSessionId: 'other' }, f.store)).rejects.toThrow('assignment');
    await expect(broker.publish({ ...f.event, summary: '中'.repeat(3000) }, f.store)).rejects.toThrow('budget');
    await broker.publish({ ...f.event, revision: 2, eventSeq: 2, terminal: true, status: 'cancelled' }, f.store);
    await expect(broker.publish({ ...f.event, revision: 3, eventSeq: 3 }, f.store)).rejects.toThrow('terminal');
    expect(await broker.publish(f.event, f.store)).toMatchObject({ status: 'cancelled' });
  });
});
