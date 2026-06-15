import { describe, expect, it } from 'vitest';
import { forwardChunkToLiveBus } from '../../../lib/ipc/agent-session-protocol.js';
import { sessionLiveBus } from '../session-live-bus.js';

describe('session live forwarding from stream chunks', () => {
  const sessionId = 'sess-chunk-live';

  it('maps stream chunks to sessionLiveBus events (agent child path)', () => {
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
