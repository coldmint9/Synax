import { afterEach, expect, it, vi } from 'vitest';

const sources = vi.hoisted(() => [] as any[]);
vi.mock('./authenticatedEventSource', () => ({ AuthenticatedEventSource: class {
  static CLOSED = 2;
  readyState = 1;
  onmessage: any;
  onerror: any;
  close = vi.fn(() => { this.readyState = 2; });
  constructor(readonly url: string) { sources.push(this); }
} }));

import { agentRuntimeApi } from './agentRuntime';

afterEach(() => { sources.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('uses the run realtime channel for the legacy streamTurn adapter too', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ run: { id: 'run-1' }, reused: false }),
    { headers: { 'Content-Type': 'application/json' } },
  )));
  const received = vi.fn();
  const pending = agentRuntimeApi.streamTurn('session-1', { message: 'hello' }, received);
  await vi.waitFor(() => expect(sources).toHaveLength(1));
  expect(sources[0].url).toBe('/api/agent-runtime/sessions/session-1/runs/run-1/stream?realtime=1');
  sources[0].onmessage({
    data: JSON.stringify({ sequence: 1, sessionId: 'session-1', runId: 'run-1', chunk: { type: 'message_delta', delta: 'hello' } }),
    lastEventId: '1',
  });
  sources[0].onmessage({ data: '[DONE]', lastEventId: '1' });
  await pending;
  expect(received).toHaveBeenCalledWith({ type: 'message_delta', delta: 'hello' });
});
