import { decodeEnvelope, encodeEnvelope, type SidecarBody, type SidecarEnvelope } from '../../../../packages/runtime-protocol/wire';
import { decodeRuntimePayload, decodeUiSnapshot } from '../../../../packages/runtime-protocol/stream';
import type { RuntimeSnapshot, RuntimeStreamRecord } from './runtimeStream';

export interface RuntimeTicket {
  url: string; token: string; expiresAtMs: number;
  clientId: string; sessionId: string; protocol: 'synax.runtime.v2';
}
export type RuntimeBootstrap = { transport: 'node' } | { transport: 'rust'; ticket: RuntimeTicket };
export type RuntimeConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export interface RustConnectionOptions {
  sessionId: string;
  bootstrap: (needsSnapshot: boolean, signal: AbortSignal) => Promise<RuntimeBootstrap>;
  snapshot: (value: RuntimeSnapshot) => void;
  record: (value: RuntimeStreamRecord) => void | Promise<void>;
  state?: (value: RuntimeConnectionState) => void;
  fallback: () => void;
  error?: (error: Error) => void;
  socket?: (url: string) => WebSocket;
}

/** One direct, credit-controlled stream per observed desktop session. No Node data fallback after selection. */
export class RustRuntimeConnection {
  private socket?: WebSocket;
  private controller?: AbortController;
  private cursor?: number;
  private generation = 0;
  private stopped = false;
  private selected = false;
  private attempts = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private handshake?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private lastAck = 0;
  private receivedAt = 0;
  private subscriptionId = '';

  constructor(private readonly options: RustConnectionOptions) {}
  start(): void { if (!this.stopped && !this.controller) void this.connect(); }
  wake(): void { if (!this.stopped) { this.disconnect(); clearTimeout(this.retry); void this.connect(); } }
  close(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.disconnect();
    this.options.state?.('closed');
  }
  private disconnect(): void {
    this.generation++;
    this.controller?.abort(); this.controller = undefined;
    clearTimeout(this.handshake); clearTimeout(this.ackTimer); clearInterval(this.heartbeat);
    this.handshake = undefined; this.ackTimer = undefined; this.heartbeat = undefined;
    const socket = this.socket; this.socket = undefined;
    socket?.close();
  }
  private recover(error: unknown, reset = false): void {
    if (this.stopped) return;
    if (reset) this.cursor = undefined;
    this.disconnect();
    this.options.state?.('reconnecting');
    this.options.error?.(error instanceof Error ? error : new Error(String(error)));
    clearTimeout(this.retry);
    this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, Math.min(500 * 2 ** Math.min(this.attempts++, 5), 10_000));
  }
  private async connect(): Promise<void> {
    if (this.stopped) return;
    const generation = ++this.generation;
    const current = () => !this.stopped && generation === this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.options.state?.(this.selected ? 'reconnecting' : 'connecting');
    this.handshake = setTimeout(() => { if (current()) this.recover(new Error('Runtime connection timed out.')); }, 10_000);
    try {
      const bootstrap = await this.options.bootstrap(this.cursor === undefined, controller.signal);
      if (!current()) return;
      if (bootstrap.transport === 'node') {
        if (this.selected) throw new Error('Rust runtime transport changed during a session.');
        this.close(); this.options.fallback(); return;
      }
      const { ticket } = bootstrap;
      const url = new URL(ticket.url);
      if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/runtime' || url.search || url.hash || url.username || url.password ||
          ticket.sessionId !== this.options.sessionId || ticket.protocol !== 'synax.runtime.v2' || !ticket.token || !ticket.clientId || ticket.expiresAtMs <= Date.now()) {
        throw new Error('Invalid Rust runtime ticket.');
      }
      this.selected = true;
      this.lastAck = this.cursor ?? 0;
      this.subscriptionId = crypto.randomUUID();
      const socket = (this.options.socket ?? (url => new WebSocket(url)))(ticket.url);
      this.socket = socket;
      socket.binaryType = 'arraybuffer';
      let ready = false;
      let subscribed = false;
      let incoming = Promise.resolve();
      const fail = (error: unknown, reset = false) => { if (current()) this.recover(error, reset); };
      socket.onopen = () => {
        if (current()) this.send({ type: 'hello', token: ticket.token, clientId: ticket.clientId }, '');
      };
      socket.onmessage = event => {
        // Credits are sent after applying records, so this queue is bounded by the server window.
        incoming = incoming.then(async () => {
          if (!current()) return;
          if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > 1024 * 1024) throw new Error('Invalid runtime binary frame.');
          const frame = decodeEnvelope(new Uint8Array(event.data));
          this.receivedAt = Date.now();
          if (frame.body.type === 'error') {
            const reset = ['RESYNC_REQUIRED', 'CURSOR_EXPIRED', 'BACKPRESSURE'].includes(frame.body.code);
            fail(new Error(`${frame.body.code}: ${frame.body.message}`), reset); return;
          }
          if (!ready) {
            if (frame.body.type !== 'ready' || frame.body.protocol !== 'synax.runtime.v2' || (!frame.body.capabilities.includes('credit_window') || !frame.body.capabilities.includes('ui_projection'))) throw new Error('Unsupported Rust runtime handshake.');
            ready = true;
            this.send(this.cursor === undefined ? { type: 'ui_snapshot' } : { type: 'subscribe', after: this.cursor });
            return;
          }
          if (frame.body.type === 'pong') return;
          if (frame.sessionId !== this.options.sessionId || frame.requestId !== this.subscriptionId) throw new Error('Runtime subscription identity mismatch.');
          if (frame.body.type === 'ui_snapshot_response') {
            if (subscribed || this.cursor !== undefined) throw new Error('Unexpected UI snapshot response.');
            const snapshot = decodeUiSnapshot(frame.body.snapshotJson, this.options.sessionId) as RuntimeSnapshot;
            this.options.snapshot(snapshot);
            this.cursor = snapshot.cursor;
            this.lastAck = snapshot.cursor;
            this.send({ type: 'subscribe', after: this.cursor });
            return;
          }
          if (frame.body.type === 'snapshot_response') {
            if (this.cursor === undefined || subscribed || frame.body.cursor < this.cursor! || frame.body.retainedFrom > this.cursor! + 1) {
              fail(new Error('Runtime cursor requires resynchronization.'), true); return;
            }
            subscribed = true;
            // This is the replay high-water mark, NOT an acknowledgement of replay consumption.
            clearTimeout(this.handshake); this.handshake = undefined;
            this.attempts = 0;
            this.options.state?.('connected');
            this.heartbeat = setInterval(() => {
              if (!current()) return;
              if (Date.now() - this.receivedAt > 35_000) fail(new Error('Runtime heartbeat timed out.'));
              else this.send({ type: 'ping' });
            }, 10_000);
            return;
          }
          if (!subscribed || frame.body.type !== 'event_batch') throw new Error('Unexpected runtime stream response.');
          for (const event of frame.body.events) {
            if (!current()) return;
            if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error('Invalid runtime event cursor.');
            if (event.sequence <= this.cursor!) continue;
            if (event.sequence !== this.cursor! + 1) { fail(new Error('Runtime stream sequence gap.'), true); return; }
            const payload = decodeRuntimePayload(event.payload);
            await this.options.record({ sequence: event.sequence, sessionId: this.options.sessionId, runId: event.runId,
              chunk: payload.chunk as RuntimeStreamRecord['chunk'], state: payload.state as RuntimeStreamRecord['state'] });
            if (!current()) return;
            this.cursor = event.sequence;
          }
          if (this.cursor! - this.lastAck >= 16) this.ack();
          else if (!this.ackTimer) this.ackTimer = setTimeout(() => { this.ackTimer = undefined; if (current()) this.ack(); }, 25);
        }).catch(error => fail(error, true));
      };
      socket.onerror = () => fail(new Error('Runtime WebSocket failed.'));
      socket.onclose = event => fail(new Error(`Runtime WebSocket closed: ${event.reason || event.code}`), event.reason === 'RESYNC_REQUIRED');
    } catch (error) { if (current()) this.recover(error); }
  }
  private ack(): void {
    clearTimeout(this.ackTimer); this.ackTimer = undefined;
    if (this.cursor === undefined || this.cursor <= this.lastAck) return;
    this.send({ type: 'credit', throughSequence: this.cursor });
    this.lastAck = this.cursor;
  }
  private send(body: SidecarBody, requestId = this.subscriptionId): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const envelope: SidecarEnvelope = { requestId, sessionId: this.options.sessionId, epoch: 0, revision: 0, body };
    const bytes = encodeEnvelope(envelope);
    try { this.socket.send(bytes); }
    catch (error) { this.recover(error); }
  }
}
