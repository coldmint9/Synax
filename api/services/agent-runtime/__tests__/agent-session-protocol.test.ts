import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitSessionLive, forwardChunkToLiveBus } from '../../../lib/ipc/agent-session-protocol.js';
import { sessionLiveBus } from '../session-live-bus.js';

describe('emitSessionLive', () => {
  const sessionId = 'sess-live-forward';

  beforeEach(() => {
    sessionLiveBus.cleanup(sessionId);
  });

  afterEach(() => {
    delete process.env.SYNAX_AGENT_SESSION_CHILD;
    delete process.env.SYNAX_WIKI_JOB_CHILD;
  });

  it('forwards message_delta chunks to sessionLiveBus on the API process', () => {
    const events: Array<{ type: string; delta?: string }> = [];
    const unsubscribe = sessionLiveBus.subscribe(sessionId, (event) => {
      events.push(event);
    });

    emitSessionLive(sessionId, { type: 'message_delta', stepId: 'step-1', delta: 'hello' });

    expect(events).toEqual([{ type: 'message_delta', stepId: 'step-1', delta: 'hello' }]);
    unsubscribe();
    sessionLiveBus.cleanup(sessionId);
  });

  it('skips session:live IPC from agent child processes (live SSE derived from stream chunks)', () => {
    process.env.SYNAX_AGENT_SESSION_CHILD = '1';
    const sent: unknown[] = [];
    const originalSend = process.send;
    process.send = ((message: unknown) => {
      sent.push(message);
      return true;
    }) as typeof process.send;

    emitSessionLive(sessionId, { type: 'thought_delta', stepId: 'step-2', delta: 'thinking' });

    expect(sent).toEqual([]);

    process.send = originalSend;
  });

  it('forwards session:live to wiki job parent with batched deltas', () => {
    vi.useFakeTimers();
    process.env.SYNAX_WIKI_JOB_CHILD = '1';
    const sent: unknown[] = [];
    const originalSend = process.send;
    process.send = ((message: unknown) => {
      sent.push(message);
      return true;
    }) as typeof process.send;

    emitSessionLive(sessionId, { type: 'message_delta', stepId: 'step-1', delta: 'hel' });
    emitSessionLive(sessionId, { type: 'message_delta', stepId: 'step-1', delta: 'lo' });
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(50);
    expect(sent).toEqual([{
      type: 'session:live',
      sessionId,
      event: { type: 'message_delta', stepId: 'step-1', delta: 'hello' },
    }]);

    process.send = originalSend;
    delete process.env.SYNAX_WIKI_JOB_CHILD;
    vi.useRealTimers();
  });
});

describe('forwardChunkToLiveBus', () => {
  const sessionId = 'sess-live-forward';

  beforeEach(() => {
    sessionLiveBus.cleanup(sessionId);
  });

  it('maps stream chunks to live events', () => {
    const events: Array<{ type: string; delta?: string }> = [];
    const unsubscribe = sessionLiveBus.subscribe(sessionId, (event) => {
      events.push(event);
    });

    forwardChunkToLiveBus(sessionId, {
      type: 'message_delta',
      runId: 'run-1',
      stepId: 'step-1',
      delta: 'hello',
    });

    expect(events).toEqual([{ type: 'message_delta', stepId: 'step-1', delta: 'hello' }]);
    unsubscribe();
    sessionLiveBus.cleanup(sessionId);
  });
});
