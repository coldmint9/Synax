export type ObservationNotice =
  | { type: "open" }
  | { type: "event"; event: string; data: string; lastEventId?: string }
  | { type: "error"; status?: number; message: string; retryable: boolean }
  | { type: "connecting" };
export interface ObservationHandler { (notice: ObservationNotice): void }
interface Binding { path: string; cursor?: string; notify: ObservationHandler; timer?: ReturnType<typeof setTimeout>; retries: number }
export interface ConnectionOptions {
  socketUrl: string;
  ticket: () => Promise<string>;
  socket?: (url: string) => WebSocket;
  now?: () => number;
  random?: () => number;
}

/** Used by both SharedWorker and the per-page fallback; no DOM or credentials stored. */
export class ObservationConnection {
  private readonly bindings = new Map<string, Binding>();
  private socket: WebSocket | null = null;
  private connecting = false;
  private ready = false;
  private epoch = 0;
  private retries = 0;
  private receivedAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private handshake?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  constructor(private readonly options: ConnectionOptions) { this.now = options.now ?? Date.now; }

  subscribe(id: string, path: string, notify: ObservationHandler, cursor?: string): () => void {
    if (this.bindings.has(id)) this.unsubscribe(id);
    clearTimeout(this.idle);
    this.bindings.set(id, { path, cursor, notify, retries: 0 });
    if (this.ready) this.start(id);
    else void this.connect();
    return () => this.unsubscribe(id);
  }
  private notify(binding: Binding, notice: ObservationNotice): void {
    // A buggy observer must not disconnect everyone sharing the physical socket.
    try { binding.notify(notice); } catch (error) { console.error("Realtime observer failed", error); }
  }
  private send(frame: object): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(frame));
  }
  private start(id: string): void {
    const binding = this.bindings.get(id);
    if (binding && this.ready) this.send({ type: "subscribe", id, path: binding.path, cursor: binding.cursor });
  }
  private unsubscribe(id: string): void {
    clearTimeout(this.bindings.get(id)?.timer);
    if (this.bindings.delete(id) && this.ready) this.send({ type: "unsubscribe", id });
    // StrictMode's unmount/remount should not create a second TCP handshake.
    if (!this.bindings.size) this.idle = setTimeout(() => this.disconnect(), 100);
  }
  private disconnect(): void {
    ++this.epoch;
    clearTimeout(this.timer); clearTimeout(this.handshake);
    clearInterval(this.watchdog);
    this.timer = undefined; this.handshake = undefined; this.watchdog = undefined;
    this.connecting = false; this.ready = false;
    const socket = this.socket; this.socket = null;
    socket?.close();
  }
  dispose(): void {
    for (const binding of this.bindings.values()) clearTimeout(binding.timer);
    this.bindings.clear(); clearTimeout(this.idle); this.disconnect();
  }
  /** Focus checks liveness; healthy connections and their subscriptions are untouched. */
  wake(): void {
    if (this.ready && this.now() - this.receivedAt > 75_000) {
      this.disconnect();
      for (const binding of this.bindings.values()) this.notify(binding, { type: "connecting" });
    }
    if (this.ready) this.send({ type: "ping" });
    else if (!this.connecting) { clearTimeout(this.timer); this.timer = undefined; void this.connect(); }
  }
  private retry(): void {
    if (!this.bindings.size || this.timer) return;
    const base = Math.min(1000 * 2 ** Math.min(this.retries++, 5), 30_000);
    const jitter = 0.8 + (this.options.random ?? Math.random)() * 0.4;
    this.timer = setTimeout(() => { this.timer = undefined; void this.connect(); }, base * jitter);
  }
  private async connect(): Promise<void> {
    if (!this.bindings.size || this.connecting || this.socket || this.timer) return;
    this.connecting = true;
    const epoch = ++this.epoch;
    try {
      const ticket = await this.options.ticket();
      if (epoch !== this.epoch || !this.bindings.size) { if (epoch === this.epoch) this.connecting = false; return; }
      const socket = (this.options.socket ?? (url => new WebSocket(url)))(this.options.socketUrl);
      this.socket = socket;
      const current = () => this.socket === socket && this.epoch === epoch;
      this.handshake = setTimeout(() => { if (current()) { this.disconnect(); this.retry(); } }, 10_000);
      socket.onopen = () => { if (current()) this.send({ type: "attach", ticket }); };
      socket.onmessage = event => {
        if (!current()) return;
        this.receivedAt = this.now();
        let frame: any;
        try { frame = JSON.parse(String(event.data)); } catch { socket.close(1002, "Invalid realtime frame."); return; }
        if (frame.type === "ready") {
          if (frame.protocol !== 1) { socket.close(1002, "Unsupported realtime protocol."); return; }
          clearTimeout(this.handshake);
          this.ready = true; this.connecting = false; this.retries = 0;
          for (const [id, binding] of this.bindings) { clearTimeout(binding.timer); binding.timer = undefined; this.start(id); }
          this.watchdog ??= setInterval(() => { if (this.now() - this.receivedAt > 75_000) this.wake(); }, 15_000);
          return;
        }
        if (frame.type === "heartbeat") return;
        const binding = this.bindings.get(frame.id);
        if (!binding) return;
        if (frame.type === "open") { binding.retries = 0; this.notify(binding, { type: "open" }); }
        if (frame.type === "event" && typeof frame.event === "string" && typeof frame.data === "string") {
          if (typeof frame.lastEventId === "string") binding.cursor = frame.lastEventId;
          this.notify(binding, { type: "event", event: frame.event, data: frame.data, lastEventId: binding.cursor });
        }
        if (frame.type === "error") {
          this.notify(binding, { type: "error", status: frame.status, message: frame.message ?? "Observation unavailable.", retryable: frame.retryable === true });
          if (frame.retryable === true && this.bindings.get(frame.id) === binding && !binding.timer) {
            binding.timer = setTimeout(() => { binding.timer = undefined; this.start(frame.id); }, Math.min(1000 * 2 ** Math.min(binding.retries++, 5), 30_000));
          }
        }
      };
      socket.onerror = () => { /* Native close (or handshake timeout) owns the one retry. */ };
      socket.onclose = () => {
        if (!current()) return;
        this.disconnect();
        for (const binding of this.bindings.values()) this.notify(binding, { type: "connecting" });
        this.retry();
      };
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.connecting = false;
      const status = (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode;
      const retryable = ![401, 403, 404].includes(status ?? 0);
      for (const binding of [...this.bindings.values()]) this.notify(binding, { type: "error", status, retryable, message: "Realtime connection unavailable." });
      if (retryable) this.retry();
    }
  }
}
