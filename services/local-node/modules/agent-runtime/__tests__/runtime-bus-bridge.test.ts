import { afterEach, describe, expect, it } from 'vitest';
import { emitRuntimeBusEvent, setRuntimeWorkerNotifier } from '../runtime-bus-bridge.js';
import { runtimeBus } from '../runtime-bus.js';

describe('emitRuntimeBusEvent', () => {
  afterEach(() => {
    delete process.env.SYNAX_AGENT_SESSION_CHILD;
    setRuntimeWorkerNotifier(() => {});
  });

  it('forwards semantic merge progress to its supervising worker', () => {
    const events: unknown[] = [];
    setRuntimeWorkerNotifier(event => { events.push(event); });
    const event = { type: 'merge_worker_progress' as const, sessionId: 'parent', childSessionId: 'child', patch: { identity: 'file:page:revision' } };
    emitRuntimeBusEvent(event);
    expect(events).toEqual([event]);
  });

  it('emits on the API process runtime bus', () => {
    const events: Array<{ type: string; sessionId: string }> = [];
    const unsubscribe = runtimeBus.subscribe((event) => {
      events.push(event);
    });

    emitRuntimeBusEvent({ type: 'session_created', sessionId: 'sess-1' });

    expect(events).toEqual([{ type: 'session_created', sessionId: 'sess-1' }]);
    unsubscribe();
  });

  it('also wakes in-process subscribers inside an agent worker', () => {
    process.env.SYNAX_AGENT_SESSION_CHILD = '1';
    const events: string[] = [];
    const unsubscribe = runtimeBus.subscribe(event => events.push(event.sessionId));
    try {
      emitRuntimeBusEvent({ type: 'session_changed', sessionId: 'child-session' });
      expect(events).toEqual(['child-session']);
    } finally { unsubscribe(); }
  });
});
