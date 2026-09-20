import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalConnection } from '../../../../lib/api/terminalConnection';
import type { TerminalSession } from '../../../../lib/api/terminal';
vi.mock('../../../../lib/api/terminal', () => ({ terminalApi: { connectionTicket: vi.fn().mockResolvedValue({ ticket: 'one-use-ticket' }) } }));
vi.mock('../../../../lib/api/origin', () => ({ getApiOrigin: () => 'http://127.0.0.1:3210' }));
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0; bufferedAmount = 0; sent: any[] = [];
  onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: () => void; onerror?: () => void;
  constructor(public url: string) { Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
const session = { id: 't', projectId: 'p', state: 'active' } as TerminalSession;
let connection: TerminalConnection;
const callbacks = () => ({ connected: vi.fn(), disconnected: vi.fn(), error: vi.fn(), reset: vi.fn(), data: vi.fn(), state: vi.fn() });
beforeEach(() => { vi.useFakeTimers(); Socket.instances = []; vi.stubGlobal('WebSocket', Socket); });
afterEach(() => { connection?.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function start() { const cb = callbacks(); connection = new TerminalConnection(session, cb); await vi.advanceTimersByTimeAsync(0); const socket = Socket.instances[0]; socket.open(); return { cb, socket }; }
it('separates both full and delta history replay from live terminal output', async () => {
  const { cb, socket } = await start();
  socket.receive({ type: 'ready', terminal: session, replay: { reset: false, sequence: 9, frames: [{ sequence: 9, data: '\x1b]11;?\x07' }] } });
  expect(cb.reset).toHaveBeenCalledWith('\x1b]11;?\x07', 9, false);
  expect(cb.data).not.toHaveBeenCalled();
  socket.receive({ type: 'data', sequence: 10, data: 'live' });
  expect(cb.data).toHaveBeenCalledWith('live', 10);
});
it('reconnects output with a cursor without replaying unknown keystrokes or putting credentials in URLs', async () => {
  const { socket } = await start();
  socket.receive({ type: 'ready', terminal: session, replay: { reset: true, sequence: 2, frames: [{ sequence: 2, data: 'prompt' }] } });
  connection.write('echo once\r');
  socket.receive({ type: 'data', sequence: 3, data: 'output' });
  socket.close(); await vi.advanceTimersByTimeAsync(1000);
  const next = Socket.instances[1]; next.open();
  expect(next.url).toBe('ws://127.0.0.1:3210/api/terminals/socket');
  expect(next.sent).toEqual([{ type: 'attach', ticket: 'one-use-ticket', after: 3 }]);
  expect(next.sent.some(frame => frame.type === 'input')).toBe(false);
});
it('rejects an over-budget paste before sending a partial command', async () => {
  const { socket } = await start();
  socket.receive({ type: 'ready', terminal: session, replay: { reset: false, sequence: 0, frames: [] } });
  socket.bufferedAmount = 1024 * 1024 - 100;
  const count = socket.sent.length;
  expect(() => connection.prepareInput('x'.repeat(500))).toThrow(/backlogged/);
  expect(socket.sent).toHaveLength(count);
});
