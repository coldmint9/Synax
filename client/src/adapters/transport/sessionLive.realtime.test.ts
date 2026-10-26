import { afterEach, expect, it, vi } from 'vitest';
const sources = vi.hoisted(() => [] as any[]);
vi.mock('./authenticatedEventSource', () => ({ AuthenticatedEventSource: class {
  static CLOSED = 2;
  readyState = 1; onmessage: any; onerror: any; onopen: any; handlers = new Map();
  close = vi.fn();
  constructor(readonly url: string) { sources.push(this); }
  addEventListener(type: string, handler: any) { this.handlers.set(type, handler); }
} }));
import { sessionLiveStream } from './sessionLive';
import { announceRunObservation, hasRunRealtimeObservation } from './runRealtime';
afterEach(() => { sources.length = 0; vi.restoreAllMocks(); });
const run = { id: 'r', sessionId: 's', status: 'running' };
const state = { status: 'running', activeRunId: 'r' };
const step = { id: 'step', runId: 'r', sessionId: 's', index: 1 };
it('gives run realtime sole projection ownership, then restores the durable snapshot on expiry', () => {
  const events = vi.fn();
  const close = sessionLiveStream('s', events);
  announceRunObservation('s', 'r');
  const [durable, realtime] = sources;
  const record = (sequence: number, chunk: unknown) => ({ sequence, sessionId: 's', runId: 'r', state, chunk });
  realtime.onmessage({ data: JSON.stringify(record(1, { type: 'step_started', step })) });
  realtime.onmessage({ data: JSON.stringify(record(2, { type: 'message_delta', stepId: 'step', delta: 'once' })) });
  durable.handlers.get('snapshot')({ data: JSON.stringify({ session: { id: 's', ...state }, run, cursor: 10,
    liveChunks: [{ type: 'step_started', step }], completedStepIds: [] }) });
  durable.handlers.get('chunk')({ data: JSON.stringify(record(11, { type: 'message_delta', stepId: 'step', delta: 'once' })) });
  expect(events.mock.calls.filter(([event]) => event.type === 'message_delta')).toHaveLength(1);
  expect(events.mock.calls.some(([event]) => event.type === 'runtime_snapshot')).toBe(false);
  realtime.handlers.get('realtime_reset')();
  expect(durable.close).toHaveBeenCalledOnce();
  expect(sources).toHaveLength(3);
  sources[2].handlers.get('snapshot')({ data: JSON.stringify({ session: { id: 's', ...state }, run,
    cursor: 12, liveChunks: [], completedStepIds: [] }) });
  expect(events.mock.calls.some(([event]) => event.type === 'runtime_snapshot')).toBe(true);
  expect(sources).toHaveLength(3);
  close();
});
it('does not attach an unrelated session or accept late events after closing', () => {
  const close = sessionLiveStream('s', vi.fn());
  announceRunObservation('other', 'r');
  expect(sources).toHaveLength(1);
  close();
  announceRunObservation('s', 'r');
  expect(sources).toHaveLength(1);
});

it('does not let delayed discovery of a finished run replace the current run stream', () => {
  const close = sessionLiveStream('s', vi.fn());
  announceRunObservation('s', 'r');
  announceRunObservation('s', 'r2');
  expect(sources).toHaveLength(3);
  sources[0].handlers.get('snapshot')({ data: JSON.stringify({ session: { id: 's', ...state }, run,
    cursor: 10, liveChunks: [], completedStepIds: [] }) });
  expect(sources).toHaveLength(3);
  expect(sources[2].close).not.toHaveBeenCalled();
  close();
});

it('forwards the durable terminal state after realtime ownership ends', () => {
  const events = vi.fn();
  const close = sessionLiveStream('s', events);
  announceRunObservation('s', 'r');
  const [durable, realtime] = sources;
  durable.handlers.get('snapshot')({ data: JSON.stringify({
    session: { id: 's', ...state },
    run,
    cursor: 0,
    liveChunks: [],
    completedStepIds: [],
  }) });

  const message = {
    id: 'm',
    sessionId: 's',
    runId: 'r',
    stepId: null,
    role: 'assistant',
    content: 'done',
    createdAt: '2026-10-25T00:00:00Z',
  } as never;
  durable.handlers.get('chunk')({ data: JSON.stringify({
    sequence: 1,
    sessionId: 's',
    runId: 'r',
    state: { status: 'completed', activeRunId: null },
    chunk: { type: 'run_completed', message },
  }) });

  expect(events.mock.calls.map(([event]) => event.type)).toEqual([
    'runtime_state',
    'message',
  ]);
  expect(hasRunRealtimeObservation('s')).toBe(false);
  expect(realtime.close).toHaveBeenCalledOnce();
  close();
});
