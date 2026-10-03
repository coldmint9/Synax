import { getApiOrigin } from "./origin";
import { terminalApi, type TerminalSession } from "./terminal";
interface Callbacks {
  connected: () => void;
  disconnected: () => void;
  error: (message: string) => void;
  reset: (data: string, sequence: number, clear: boolean) => void;
  data: (data: string, sequence: number) => void;
  state: (terminal: TerminalSession) => void;
}
/** Output reconnects with a cursor. Keystrokes are never replayed after a dropped connection. */
export class TerminalConnection {
  private socket?: WebSocket;
  private stopped = false;
  private ready = false;
  private suspended: boolean;
  private sequence: number | undefined;
  private retry?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private generation = 0;
  constructor(
    private terminal: TerminalSession,
    private callbacks: Callbacks,
    active = true,
  ) {
    this.suspended = !active;
    if (active) void this.connect();
  }
  private async connect() {
    if (this.stopped || this.suspended) return;
    const generation = ++this.generation;
    try {
      const { ticket } = await terminalApi.connectionTicket(this.terminal);
      if (this.stopped || this.suspended || generation !== this.generation)
        return;
      const url = new URL(
        "/api/terminals/socket",
        getApiOrigin() || window.location.origin,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = (this.socket = new WebSocket(url.href));
      socket.onopen = () => {
        if (this.stopped || this.suspended || generation !== this.generation) {
          socket.close();
          return;
        }
        socket.send(
          JSON.stringify({ type: "attach", ticket, after: this.sequence }),
        );
      };
      socket.onmessage = (event) => {
        if (this.stopped || this.suspended || generation !== this.generation)
          return;
        try {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "ready") {
            this.ready = true;
            this.attempts = 0;
            this.callbacks.connected();
            const replay = frame.replay;
            this.sequence = replay.sequence;
            // Even a delta replay can contain expired terminal queries.
            this.callbacks.reset(
              replay.frames.map((item: { data: string }) => item.data).join(""),
              replay.sequence,
              replay.reset,
            );
            this.callbacks.state(frame.terminal);
          } else if (frame.type === "data") {
            this.sequence = frame.sequence;
            this.callbacks.data(frame.data, frame.sequence);
          } else if (frame.type === "state")
            this.callbacks.state(frame.terminal);
          else if (frame.type === "error") this.callbacks.error(frame.message);
        } catch {
          this.callbacks.error("Invalid terminal stream frame.");
          socket.close();
        }
      };
      socket.onclose = () => {
        if (
          !this.stopped &&
          !this.suspended &&
          generation === this.generation
        ) {
          this.ready = false;
          this.callbacks.disconnected();
          this.reconnect();
        }
      };
      socket.onerror = () => socket.close();
    } catch (error) {
      if (!this.stopped && !this.suspended && generation === this.generation) {
        this.callbacks.disconnected();
        this.callbacks.error(
          error instanceof Error ? error.message : String(error),
        );
        this.reconnect();
      }
    }
  }
  private reconnect() {
    if (this.stopped || this.suspended) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(
      () => {
        void this.connect();
      },
      Math.min(1000 * 2 ** this.attempts++, 10000),
    );
  }
  private send(frame: unknown) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN)
      throw new Error("Terminal disconnected; input was not sent.");
    this.socket.send(JSON.stringify(frame));
  }
  prepareInput(data: string) {
    const bytes =
      new TextEncoder().encode(JSON.stringify(data)).byteLength +
      Math.ceil(data.length / 16000) * 256;
    if ((this.socket?.bufferedAmount ?? 0) + bytes > 1024 * 1024)
      throw new Error(
        "Terminal input is backlogged. Wait before pasting more.",
      );
  }
  write(data: string, binary = false) {
    const frame = {
      type: "input",
      data,
      binary,
      requestId: crypto.randomUUID(),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
    if ((this.socket?.bufferedAmount ?? 0) + bytes > 1024 * 1024)
      throw new Error(
        "Terminal input is backlogged. Wait before pasting more.",
      );
    this.send(frame);
  }
  resize(cols: number, rows: number) {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN)
      this.send({ type: "resize", cols, rows });
  }
  redraw() {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN)
      this.send({ type: "redraw" });
  }
  acknowledge(sequence: number) {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN)
      this.send({ type: "ack", sequence });
  }
  pause() {
    if (this.stopped || this.suspended) return;
    this.suspended = true;
    this.ready = false;
    ++this.generation;
    clearTimeout(this.retry);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }
  resume() {
    if (this.stopped || !this.suspended) return;
    this.suspended = false;
    void this.connect();
  }
  close() {
    this.stopped = true;
    this.ready = false;
    ++this.generation;
    clearTimeout(this.retry);
    this.socket?.close();
  }
}
