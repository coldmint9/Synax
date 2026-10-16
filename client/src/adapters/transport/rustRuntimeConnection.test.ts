import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RustRuntimeConnection, type RustConnectionOptions } from './rustRuntimeConnection';
import { encodeEnvelope, decodeEnvelope, type SidecarEnvelope, type SidecarBody } from '../../../../packages/runtime-protocol/wire';
import type { RuntimeSnapshot } from './runtimeStream';

class Socket {
  static all: Socket[] = [];
  readyState = 0;
  binaryType = '';
  sent: SidecarEnvelope[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: ArrayBuffer }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onerror?: () => void;
  constructor(readonly url: string) { Socket.all.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(bytes: Uint8Array) { this.sent.push(decodeEnvelope(bytes)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  frame(body: SidecarBody, requestId = this.sent.find(frame => ['subscribe', 'ui_snapshot'].includes(frame.body.type))?.requestId ?? '', sessionId = 's') {
    const bytes = encodeEnvelope({ requestId, sessionId, epoch: 1, revision: 1, body });
    this.onmessage?.({ data: bytes.slice().buffer });
  }
}
const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
let connection: RustRuntimeConnection;
let initialCursor = 0;
const snapshot = (cursor: number) => ({ session: { id: 's', status: 'running' }, cursor, run: null, liveChunks: [], completedStepIds: [] }) as unknown as RuntimeSnapshot;
function setup(cursor = 0) {
  initialCursor = cursor;
  const options = {
    sessionId: 's', snapshot: vi.fn(), record: vi.fn(), state: vi.fn(), fallback: vi.fn(), error: vi.fn(),
    socket: (url: string) => new Socket(url) as unknown as WebSocket,
    bootstrap: vi.fn(async (needsSnapshot: boolean) => ({ transport: 'rust' as const,
      ticket: { url: 'ws://127.0.0.1:12345/runtime', token: 'short-ticket', clientId: 'window1', sessionId: 's', expiresAtMs: Date.now() + 30_000, protocol: 'synax.runtime.v2' as const } })),
  } satisfies RustConnectionOptions;
  connection = new RustRuntimeConnection(options); connection.start();
  return options;
}
async function attach(highWater = 0) {
  await settle();
  const socket = Socket.all.at(-1)!;
  socket.open();
  socket.frame({ type: 'ready', protocol: 'synax.runtime.v2', transport: 'websocket', capabilities: ['credit_window', 'ui_projection'] }, '');
  await settle();
  if (socket.sent.at(-1)?.body.type === 'ui_snapshot') {
    socket.frame({ type: 'ui_snapshot_response', snapshotJson: new TextEncoder().encode(JSON.stringify(snapshot(initialCursor))) });
    await settle();
  }
  socket.frame({ type: 'snapshot_response', epoch: 1, revision: 1, cursor: highWater, retainedFrom: 1 });
  await settle();
  return socket;
}
const event = (sequence: number) => ({ sequence, runId: 'r', kind: 'message_delta', payload: new TextEncoder().encode(JSON.stringify({ schema: 1,
  chunk: { type: 'message_delta', stepId: 'step', delta: String(sequence) },
  state: { status: 'running', activeRunId: 'r', pendingResumeToken: null, blockedReason: null, updatedAt: '2026-10-16T00:00:00Z' },
})) });
beforeEach(() => { vi.useFakeTimers(); Socket.all = []; });
afterEach(() => { connection?.close(); vi.useRealTimers(); });

describe('Rust runtime consumer', () => {
  it('waits for the Rust snapshot before applying state or subscribing', async () => {
    const options = setup(9); await settle();
    const socket = Socket.all.at(-1)!; socket.open();
    socket.frame({ type: 'ready', protocol: 'synax.runtime.v2', transport: 'websocket', capabilities: ['credit_window', 'ui_projection'] }, '');
    await settle();
    expect(options.snapshot).not.toHaveBeenCalled();
    expect(socket.sent.at(-1)?.body).toEqual({ type: 'ui_snapshot' });
    socket.frame({ type: 'ui_snapshot_response', snapshotJson: new TextEncoder().encode(JSON.stringify(snapshot(9))) });
    await settle();
    expect(options.snapshot).toHaveBeenCalledWith(snapshot(9));
    expect(socket.sent.at(-1)?.body).toEqual({ type: 'subscribe', after: 9 });
  });

  it('applies backlog before acknowledging it and resumes from the applied cursor', async () => {
    const options = setup(5);
    const socket = await attach(100);
    expect(socket.sent.find(frame => frame.body.type === 'subscribe')?.body).toEqual({ type: 'subscribe', after: 5 });
    let applied!: () => void;
    options.record.mockImplementationOnce(() => new Promise<void>(resolve => { applied = resolve; }));
    socket.frame({ type: 'event_batch', events: [event(6)] });
    await settle();
    await vi.advanceTimersByTimeAsync(25);
    expect(socket.sent.some(frame => frame.body.type === 'credit')).toBe(false);
    applied(); await settle(); await vi.advanceTimersByTimeAsync(25);
    expect(socket.sent.at(-1)?.body).toEqual({ type: 'credit', throughSequence: 6 });
    socket.close(); await vi.advanceTimersByTimeAsync(500); await settle();
    const resumed = await attach(100);
    expect(options.bootstrap.mock.calls[1][0]).toBe(false);
    expect(resumed.sent.find(frame => frame.body.type === 'subscribe')?.body).toEqual({ type: 'subscribe', after: 6 });
    expect(options.snapshot).toHaveBeenCalledTimes(1);
  });

  it('requests a fresh snapshot on a sequence gap, without applying the out-of-order event', async () => {
    const options = setup();
    const socket = await attach(2);
    socket.frame({ type: 'event_batch', events: [event(2)] });
    await settle();
    expect(options.record).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500); await settle();
    expect(options.bootstrap.mock.calls[1][0]).toBe(true);
    expect(options.fallback).not.toHaveBeenCalled();
  });

  it('uses the Node gateway only when Rust has not been selected', async () => {
    const fallback = vi.fn();
    const bootstrap = vi.fn(async () => ({ transport: 'node' as const }));
    connection = new RustRuntimeConnection({ sessionId: 's', bootstrap, snapshot: vi.fn(), record: vi.fn(), fallback });
    connection.start(); await settle(); await vi.advanceTimersByTimeAsync(20_000);
    expect(fallback).toHaveBeenCalledOnce();
    expect(Socket.all).toHaveLength(0); expect(bootstrap).toHaveBeenCalledOnce();
  });

  it('does not silently switch state sources after a Rust connection was established', async () => {
    const options = setup(); await attach();
    options.bootstrap.mockResolvedValueOnce({ transport: 'node' } as never);
    connection.wake(); await settle();
    expect(options.fallback).not.toHaveBeenCalled();
    expect(options.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Rust runtime transport changed during a session.' }));
  });

  it('honors a close-frame resync reason even if the last data frame was lost', async () => {
    const options = setup(4); const socket = await attach(4);
    socket.onclose?.({ code: 1008, reason: 'RESYNC_REQUIRED' });
    await settle(); await vi.advanceTimersByTimeAsync(500); await settle();
    expect(options.bootstrap.mock.calls[1][0]).toBe(true);
  });

  it('disposes an in-flight bootstrap without opening a socket later', async () => {
    const options = setup();
    connection.close(); await settle();
    expect(Socket.all).toHaveLength(0);
    expect(options.snapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(options.bootstrap).toHaveBeenCalledTimes(1);
  });

  it('rebuilds a snapshot on the server resync signal', async () => {
    const options = setup(10);
    const socket = await attach(10);
    socket.frame({ type: 'error', code: 'RESYNC_REQUIRED', message: 'slow consumer' });
    await settle(); await vi.advanceTimersByTimeAsync(500); await settle();
    expect(options.bootstrap.mock.calls[1][0]).toBe(true);
    expect(options.state).toHaveBeenCalledWith('reconnecting');
  });
});
