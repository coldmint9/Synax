import { afterEach, describe, expect, it } from 'vitest';
import { emitRuntimeBusEvent } from '../runtime-bus-bridge.js';
import { runtimeBus } from '../runtime-bus.js';

describe('emitRuntimeBusEvent', () => {
  afterEach(() => {
    delete process.env.SYNAX_AGENT_SESSION_CHILD;
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
});
