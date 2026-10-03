import { describe, expect, it, vi } from 'vitest';
import { HttpRuntimeClient, SynaxRuntimeError } from '../runtime-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(frames: string): Response {
  return new Response(frames, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('HttpRuntimeClient', () => {
  it('uses the bearer token and idempotency key for run submission', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:3210/api/agent-runtime/sessions/s1/runs');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('request-1');
      expect(JSON.parse(String(init?.body))).toMatchObject({ requestId: 'request-1', mode: 'turn', message: 'hello' });
      return jsonResponse({ run: { id: 'r1', status: 'queued' }, reused: false }, 202);
    });
    const client = new HttpRuntimeClient({ baseUrl: 'http://127.0.0.1:3210', token: 'token', fetch: fetchMock });

    await expect(client.submitRun('s1', { message: 'hello' }, { requestId: 'request-1' })).resolves.toMatchObject({ run: { id: 'r1' } });
  });

  it('preserves unknown event payloads and reconnects from the latest sequence', async () => {
    let streamCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/runs/r1/stream?after=0')) {
        streamCalls++;
        return sseResponse('id: 7\ndata: {"type":"future_event","value":{"kept":true}}\n\n');
      }
      if (url.endsWith('/runs/r1')) return jsonResponse({ id: 'r1', sessionId: 's1', status: 'running' });
      if (url.endsWith('/runs/r1/stream?after=7')) {
        streamCalls++;
        return sseResponse('id: 8\ndata: {"type":"done","sessionId":"s1","runId":"r1"}\n\n');
      }
      throw new Error(`unexpected request ${url}`);
    });
    const client = new HttpRuntimeClient({ fetch: fetchMock, retryDelayMs: 0 });
    const events = [];
    for await (const event of client.observeRun('s1', 'r1', { maxReconnectAttempts: 2 })) events.push(event);

    expect(streamCalls).toBe(2);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ protocol: 'synax.runtime.v1', sequence: 7, type: 'future_event', payload: { value: { kept: true } } });
    expect(events[1]).toMatchObject({ sequence: 8, type: 'done' });
  });

  it('does not retry a non-retryable HTTP error while observing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'Missing run', code: 'NOT_FOUND' }, 404));
    const client = new HttpRuntimeClient({ fetch: fetchMock, retryDelayMs: 0 });

    await expect(async () => {
      for await (const _event of client.observeRun('s1', 'missing')) { /* expected to throw */ }
    }).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
