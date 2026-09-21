import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalConnection } from "../../../../lib/api/terminalConnection";
import type { TerminalSession } from "../../../../lib/api/terminal";

vi.mock("../../../../lib/api/terminal", () => ({
  terminalApi: {
    connectionTicket: vi.fn().mockResolvedValue({ ticket: "one-use-ticket" }),
  },
}));
vi.mock("../../../../lib/api/origin", () => ({
  getApiOrigin: () => "http://127.0.0.1:3210",
}));

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: unknown[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;

  constructor(public url: string) {
    Socket.instances.push(this);
  }
  open() {
    this.readyState = Socket.OPEN;
    this.onopen?.();
  }
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const session = {
  id: "t",
  projectId: "p",
  state: "active",
} as TerminalSession;
const callbacks = () => ({
  connected: vi.fn(),
  disconnected: vi.fn(),
  error: vi.fn(),
  reset: vi.fn(),
  data: vi.fn(),
  state: vi.fn(),
});
let connection: TerminalConnection;

beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => {
  connection?.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("suspends hidden readers and resumes from the last output sequence", async () => {
  connection = new TerminalConnection(session, callbacks());
  await vi.advanceTimersByTimeAsync(0);
  const socket = Socket.instances[0];
  socket.open();
  socket.receive({
    type: "ready",
    terminal: session,
    replay: { reset: false, sequence: 4, frames: [] },
  });
  socket.receive({ type: "data", sequence: 5, data: "visible" });

  connection.pause();
  await vi.advanceTimersByTimeAsync(10000);
  expect(Socket.instances).toHaveLength(1);

  connection.resume();
  await vi.advanceTimersByTimeAsync(0);
  const resumed = Socket.instances[1];
  resumed.open();
  expect(resumed.sent).toEqual([
    { type: "attach", ticket: "one-use-ticket", after: 5 },
  ]);
});

it("does not connect an initially hidden terminal until it becomes visible", async () => {
  connection = new TerminalConnection(session, callbacks(), false);
  await vi.advanceTimersByTimeAsync(0);
  expect(Socket.instances).toHaveLength(0);

  connection.resume();
  await vi.advanceTimersByTimeAsync(0);
  expect(Socket.instances).toHaveLength(1);
});
