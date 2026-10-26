import { afterEach, expect, it, vi } from 'vitest';
const sources = vi.hoisted(() => [] as any[]);
vi.mock('./authenticatedEventSource', () => ({ AuthenticatedEventSource: class {
  static CLOSED = 2;
  readyState = 1; onmessage: any; onerror: any; handlers = new Map();
  close = vi.fn();
  constructor(readonly url: string) { sources.push(this); }
  addEventListener(type: string, handler: any) { this.handlers.set(type, handler); }
} }));
import { observeRunRealtime } from './runRealtime';
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
