import { describe, expect, it } from 'vitest';
import { sessionLiveBus } from '../session-live-bus.js';

describe('sessionLiveBus', () => {
  it('buffers events until the first subscriber connects', () => {
    const sessionId = 'sess-buffer-test';
    sessionLiveBus.cleanup(sessionId);

    sessionLiveBus.emit(sessionId, { type: 'thought_delta', stepId: 'step-1', delta: 'hello' });
    sessionLiveBus.emit(sessionId, { type: 'thought_delta', stepId: 'step-1', delta: ' world' });

    const received: string[] = [];
    const unsubscribe = sessionLiveBus.subscribe(sessionId, (event) => {
      if (event.type === 'thought_delta') received.push(event.delta);
    });

    expect(received).toEqual(['hello', ' world']);

    sessionLiveBus.emit(sessionId, { type: 'thought_delta', stepId: 'step-1', delta: '!' });
    expect(received).toEqual(['hello', ' world', '!']);

    unsubscribe();
    sessionLiveBus.cleanup(sessionId);
  });

  it('delivers live events directly when subscribers are present', () => {
    const sessionId = 'sess-live-test';
    sessionLiveBus.cleanup(sessionId);

    const received: string[] = [];
    const unsubscribe = sessionLiveBus.subscribe(sessionId, (event) => {
      if (event.type === 'message_delta') received.push(event.delta);
    });

    sessionLiveBus.emit(sessionId, { type: 'message_delta', stepId: 'step-1', delta: 'live' });
    expect(received).toEqual(['live']);

    unsubscribe();
    sessionLiveBus.cleanup(sessionId);
  });
});
