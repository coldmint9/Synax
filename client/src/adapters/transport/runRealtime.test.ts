import { afterEach, expect, it, vi } from 'vitest';
const sources = vi.hoisted(() => [] as any[]);
vi.mock('./authenticatedEventSource', () => ({ AuthenticatedEventSource: class {
  static CLOSED = 2;
  readyState = 1; onmessage: any; onerror: any; handlers = new Map();
  close = vi.fn();
  constructor(readonly url: string, readonly options?: { cursor?: string }) { sources.push(this); }
  addEventListener(type: string, handler: any) { this.handlers.set(type, handler); }
} }));
import { observeRunRealtime, captureRunRealtimeCheckpoint } from './runRealtime';
afterEach(() => { sources.length = 0; vi.restoreAllMocks(); });
it('receives current run text once, without waiting for session hydration, and detects gaps', () => {
  const events = vi.fn(), recover = vi.fn();
  const stop = observeRunRealtime('s', 'r', events, recover);
  const source = sources[0];
  const send = (sequence: number, chunk: unknown) => source.onmessage({ data: JSON.stringify({ sequence, sessionId: 's', runId: 'r', chunk,
    state: { status: 'running', activeRunId: 'r' } }) });
  send(1, { type: 'step_started', step: { id: 'step', runId: 'r', sessionId: 's', index: 1 } });
  send(2, { type: 'message_delta', stepId: 'step', delta: 'first' });
  send(2, { type: 'message_delta', stepId: 'step', delta: 'first' });
  expect(events.mock.calls.filter(([event]) => event.type === 'message_delta')).toHaveLength(1);
  send(4, { type: 'message_delta', stepId: 'step', delta: 'gap' });
  expect(recover).toHaveBeenCalledOnce();
  stop();
});
it('handles terminal replay and recovery responses without reconnecting forever', () => {
  const recover = vi.fn();
  observeRunRealtime('s', 'r', vi.fn(), recover);
  sources[0].handlers.get('realtime_reset')();
  expect(recover).toHaveBeenCalledOnce();
  expect(sources[0].close).toHaveBeenCalledOnce();
});

it('resumes from the cached cursor and step without replaying prior calls or text', () => {
  const receive = vi.fn(), recover = vi.fn();
  const stop = observeRunRealtime('s', 'resume', receive, recover);
  const record = (sequence: number, chunk: unknown) => ({ data: JSON.stringify({
    sequence, sessionId: 's', runId: 'resume', chunk, state: { status: 'running', activeRunId: 'resume' },
  }) });
  sources[0].onmessage(record(1, { type: 'step_started', step: { id: 'step', index: 1 } }));
  sources[0].onmessage(record(2, { type: 'tool_call', stepId: 'step', toolCall: { id: 'call', status: 'running' } }));
  sources[0].onmessage(record(3, { type: 'thought_delta', stepId: 'step', delta: 'cached' }));
  const cached = captureRunRealtimeCheckpoint('s');
  stop();
  expect(captureRunRealtimeCheckpoint('s')).toBeUndefined();
  receive.mockClear();
  const resumed = observeRunRealtime('s', 'resume', receive, recover, cached);
  expect(sources[1].options).toEqual({ cursor: '3' });
  sources[1].onmessage(record(3, { type: 'thought_delta', stepId: 'step', delta: 'cached' }));
  sources[1].onmessage(record(4, { type: 'tool_result', stepId: 'step', toolCall: { id: 'call', status: 'completed' } }));
  sources[1].onmessage(record(5, { type: 'message_delta', stepId: 'step', delta: 'new' }));
  expect(receive.mock.calls.map(([event]) => event.type)).toEqual(['tool_result', 'message_delta']);
  expect(recover).not.toHaveBeenCalled();
  resumed();
});

it('does not reuse a cursor for a different run and falls back when a resumed cursor expires', () => {
  const recover = vi.fn();
  const checkpoint = { sessionId: 's', runId: 'old', projection: { cursor: 12, stepId: 'step', completedSteps: [], stateKey: '' } };
  const stop = observeRunRealtime('s', 'new', vi.fn(), recover, checkpoint);
  expect(sources[0].options).toBeUndefined();
  stop();
  observeRunRealtime('s', 'old', vi.fn(), recover, checkpoint);
  expect(sources[1].options).toEqual({ cursor: '12' });
  sources[1].handlers.get('realtime_reset')();
  expect(recover).toHaveBeenCalledOnce();
  expect(captureRunRealtimeCheckpoint('s')).toBeUndefined();
});
