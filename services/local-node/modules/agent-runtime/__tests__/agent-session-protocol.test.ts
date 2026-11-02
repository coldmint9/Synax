import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitSessionLive, forwardChunkToLiveBus } from '../../../infrastructure/runtime/ipc/agent-session-protocol.js';
import { sessionLiveBus } from '../session-live-bus.js';

describe('emitSessionLive', () => {
  const sessionId = 'sess-live-forward';

  beforeEach(() => {
    sessionLiveBus.cleanup(sessionId);
  });

  afterEach(() => {
    delete process.env.SYNAX_AGENT_SESSION_CHILD;
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

  it('forwards tool_call start markers from agent child processes', () => {
    process.env.SYNAX_AGENT_SESSION_CHILD = '1';
    const sent: unknown[] = [];
    const originalSend = process.send;
    process.send = ((message: unknown) => {
      sent.push(message);
      return true;
    }) as typeof process.send;

    const toolCall = {
      id: 'tool-1', sessionId, runId: 'run-1', stepId: 'step-1',
      modelToolCallId: 'model-1', toolId: 'subagent.delegate', category: 'task',
      mutability: 'task', argsHash: 'hash', inputSummary: 'delegate', inputRef: {},
      outputSummary: null, outputRef: null, status: 'running',
      permissionDecisionId: null, startedAt: '2026-01-01T00:00:00.000Z', endedAt: null, error: null,
    } as never;
    emitSessionLive(sessionId, { type: 'tool_call', stepId: 'step-1', toolCall });

    expect(sent).toEqual([{ type: 'session:live', sessionId, event: { type: 'tool_call', stepId: 'step-1', toolCall } }]);
    process.send = originalSend;
  });
});

describe('forwardChunkToLiveBus', () => {
  const sessionId = 'sess-live-forward';

  beforeEach(() => {
    sessionLiveBus.cleanup(sessionId);
  });

  it('retains text and reasoning telemetry across the worker live bridge', () => {
    const events: unknown[] = [];
    const unsubscribe = sessionLiveBus.subscribe(sessionId, event => events.push(event));
    forwardChunkToLiveBus(sessionId, { type: 'message_delta', runId: 'r', stepId: 's', delta: 'answer', outputTokens: 7 });
    forwardChunkToLiveBus(sessionId, { type: 'thought_delta', runId: 'r', stepId: 's', delta: 'reasoning', thinkingTokens: 11 });
    expect(events).toEqual([
      { type: 'message_delta', stepId: 's', delta: 'answer', outputTokens: 7 },
      { type: 'thought_delta', stepId: 's', delta: 'reasoning', thinkingTokens: 11 },
    ]);
    unsubscribe();
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
