import { afterEach, describe, expect, it } from 'vitest';
import { emitRuntimeBusEvent } from '../runtime-bus-bridge.js';
import { runtimeBus } from '../runtime-bus.js';

describe('emitRuntimeBusEvent', () => {
  afterEach(() => {
    delete process.env.SYNAX_WIKI_JOB_CHILD;
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

  it('forwards runtime events to the wiki job parent via IPC', () => {
    process.env.SYNAX_WIKI_JOB_CHILD = '1';
    const sent: unknown[] = [];
    const originalSend = process.send;
    process.send = ((message: unknown) => {
      sent.push(message);
      return true;
    }) as typeof process.send;

    emitRuntimeBusEvent({ type: 'session_created', sessionId: 'sess-wiki' });

    expect(sent).toEqual([{
      type: 'runtime:event',
      event: { type: 'session_created', sessionId: 'sess-wiki' },
    }]);

    process.send = originalSend;
  });
});
