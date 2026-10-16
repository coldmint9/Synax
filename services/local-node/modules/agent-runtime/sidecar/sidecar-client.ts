import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import {
  decodeEnvelope,
  encodeEnvelope,
  type SidecarBody,
  type SidecarEnvelope,
} from './sidecar-protocol.js';

export interface RuntimeSidecarClientOptions {
  socketPath: string;
  token: string;
  requestTimeoutMs?: number;
  retryTimeoutMs?: number;
}

export class RuntimeSidecarError extends Error {
  readonly code: string;
  readonly expected?: number;
  readonly actual?: number;

  constructor(body: Extract<SidecarBody, { type: 'error' }>) {
    super(body.message);
    this.name = 'RuntimeSidecarError';
    this.code = body.code;
    this.expected = body.expected;
    this.actual = body.actual;
  }
}

export class RuntimeSidecarTransportError extends Error {
  constructor(message: string) { super(message); this.name = 'RuntimeSidecarTransportError'; }
}

function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RuntimeSidecarTransportError('Runtime sidecar handshake deadline exceeded.')), Math.max(1, milliseconds));
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

type PendingRequest = {
  resolve: (envelope: SidecarEnvelope) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RuntimeSidecarClient {
  private socket: net.Socket | undefined;
  private buffer = Buffer.alloc(0);
  private ready: Promise<Extract<SidecarBody, { type: 'ready' }>> | undefined;
  private readyResolve: ((value: Extract<SidecarBody, { type: 'ready' }>) => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private readonly operationIds = new Set<string>();
  private operationBytes = 0;
  private readonly lifetime = new AbortController();

  constructor(private readonly options: RuntimeSidecarClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  connect(): Promise<Extract<SidecarBody, { type: 'ready' }>> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('Runtime sidecar client closed.'));
    if (this.ready) return this.ready;
    const ready = new Promise<Extract<SidecarBody, { type: 'ready' }>>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.ready = ready;
    const socket = net.createConnection(this.options.socketPath);
    this.socket = socket;
    socket.unref();
    const fail = (error: Error) => { if (this.socket === socket) this.fail(error); };
    this.handshakeTimer = setTimeout(() => fail(new RuntimeSidecarTransportError('Runtime sidecar handshake timed out.')), this.requestTimeoutMs);
    socket.on('data', chunk => { if (this.socket === socket) this.onData(chunk); });
    socket.on('error', error => fail(new RuntimeSidecarTransportError(error.message)));
    socket.on('close', () => fail(new RuntimeSidecarTransportError('Runtime sidecar connection closed.')));
    socket.once('connect', () => {
      try {
        this.send({ requestId: '', sessionId: '', epoch: 0, revision: 0, body: { type: 'hello', token: this.options.token } });
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    return ready;
  }

  async health(): Promise<Extract<SidecarBody, { type: 'health_response' }>> {
    return this.request({ type: 'health' }, '', 0, 0).then((envelope) => this.expect(envelope, 'health_response'));
  }

  async issueTicket(sessionId: string, clientId: string): Promise<Extract<SidecarBody, { type: 'ticket' }>> {
    return this.request({ type: 'issue_ticket', clientId }, sessionId, 0, 0)
      .then(envelope => this.expect(envelope, 'ticket'));
  }

  async admitRun(input: {
    sessionId: string;
    requestId: string;
    bodyHash: string;
    runId: string;
    epoch: number;
    revision: number;
  }): Promise<Extract<SidecarBody, { type: 'run_admission' }>> {
    return this.request({ type: 'admit_run', bodyHash: input.bodyHash, runId: input.runId }, input.sessionId, input.epoch, input.revision, input.requestId)
      .then((envelope) => this.expect(envelope, 'run_admission'));
  }

  async finishRun(input: {
    sessionId: string; requestId: string; runId: string;
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'blocked';
    epoch: number; revision: number; run?: unknown;
  }): Promise<Extract<SidecarBody, { type: 'snapshot_response' }>> {
    return this.request({ type: 'finish_run', runId: input.runId, status: input.status, runJson: input.run === undefined ? undefined : new TextEncoder().encode(JSON.stringify(input.run)) },
      input.sessionId, input.epoch, input.revision, input.requestId)
      .then(envelope => this.expect(envelope, 'snapshot_response'));
  }

  async appendStream(input: {
    sessionId: string;
    runId: string;
    producerId: string;
    producerSequence: number;
    epoch: number;
    revision: number;
    events: Array<{ kind: string; payload: Uint8Array }>;
    durability?: 'sync' | 'group_commit' | 'ephemeral';
  }): Promise<Extract<SidecarBody, { type: 'ack' }>> {
    const { sessionId, runId, producerId, producerSequence, epoch, revision, events, durability } = input;
    return this.request(
      { type: 'append_stream', runId, producerId, producerSequence, events, durability },
      sessionId,
      epoch,
      revision,
    ).then((envelope) => this.expect(envelope, 'ack'));
  }

  async uiSnapshot(sessionId: string): Promise<Uint8Array> {
    return this.request({ type: 'ui_snapshot' }, sessionId, 0, 0)
      .then(envelope => this.expect(envelope, 'ui_snapshot_response').snapshotJson);
  }

  async activateRun(input: { requestId?: string; sessionId: string; epoch: number; revision: number; run: unknown }): Promise<Extract<SidecarBody, { type: 'snapshot_response' }>> {
    return this.request({ type: 'activate_run', runJson: new TextEncoder().encode(JSON.stringify(input.run)) }, input.sessionId, input.epoch, input.revision, input.requestId)
      .then(envelope => this.expect(envelope, 'snapshot_response'));
  }

  async seedUi(sessionId: string, sessionJson: Uint8Array): Promise<Uint8Array> {
    return this.request({ type: 'seed_ui', sessionJson }, sessionId, 0, 0)
      .then(envelope => this.expect(envelope, 'ui_snapshot_response').snapshotJson);
  }

  async snapshot(sessionId: string, epoch = 0, revision = 0): Promise<Extract<SidecarBody, { type: 'snapshot_response' }>> {
    return this.request({ type: 'snapshot' }, sessionId, epoch, revision)
      .then((envelope) => this.expect(envelope, 'snapshot_response'));
  }

  async replay(sessionId: string, after: number): Promise<Extract<SidecarBody, { type: 'event_batch' }>> {
    return this.request({ type: 'replay', after }, sessionId, 0, 0)
      .then((envelope) => this.expect(envelope, 'event_batch'));
  }

  close(): void {
    this.lifetime.abort();
    this.fail(new Error('Runtime sidecar client closed.'));
  }

  private async request(
    body: SidecarBody,
    sessionId: string,
    epoch: number,
    revision: number,
    requestId: string = randomUUID(),
  ): Promise<SidecarEnvelope> {
    if (this.lifetime.signal.aborted) throw new Error('Runtime sidecar client closed.');
    if (this.operationIds.has(requestId)) throw new Error('A sidecar request with this ID is already in flight.');
    if (this.operationIds.size >= 128) throw new Error('Runtime sidecar request queue is full.');
    const frame = this.encode({ requestId, sessionId, epoch, revision, body });
    if (this.operationBytes + frame.length > 8 * 1024 * 1024) throw new Error('Runtime sidecar request byte budget is full.');
    this.operationIds.add(requestId); this.operationBytes += frame.length;
    const deadline = Date.now() + (this.options.retryTimeoutMs ?? 45_000);
    let attempt = 0;
    let lastFailure: unknown;
    try {
      for (;;) {
        if (Date.now() >= deadline) throw lastFailure ?? new RuntimeSidecarTransportError('Runtime retry deadline exceeded.');
        try {
          const response = await this.attempt(frame, requestId, body.type === 'append_stream', Math.min(deadline, Date.now() + this.requestTimeoutMs));
          if (response.body.type === 'error' && ['BACKPRESSURE', 'DURABILITY_UNKNOWN'].includes(response.body.code)) throw new RuntimeSidecarError(response.body);
          return response;
        } catch (error) {
          lastFailure = error;
          const retryable = error instanceof RuntimeSidecarTransportError ||
            (error instanceof RuntimeSidecarError && ['BACKPRESSURE', 'DURABILITY_UNKNOWN'].includes(error.code));
          if (!retryable || this.lifetime.signal.aborted || Date.now() >= deadline) throw error;
          await delay(Math.min(100 * 2 ** Math.min(attempt++, 4), 1000, deadline - Date.now()), undefined, { signal: this.lifetime.signal });
        }
      }
    } finally { this.operationIds.delete(requestId); this.operationBytes -= frame.length; }
  }

  private async attempt(frame: Buffer, requestId: string, append: boolean, deadline: number): Promise<SidecarEnvelope> {
    const ready = await bounded(this.connect(), deadline - Date.now());
    if (append && !ready.capabilities.includes('append_receipts')) throw new Error('Runtime sidecar does not support durable append receipts.');
    if (this.lifetime.signal.aborted) throw new Error('Runtime sidecar client closed.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Closing also bounds queued socket bytes; accepted writes can be retried from receipts.
        this.fail(new RuntimeSidecarTransportError(`Runtime sidecar request timed out: ${requestId}`));
      }, Math.max(1, deadline - Date.now()));
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write(frame); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private expect<T extends SidecarBody['type']>(envelope: SidecarEnvelope, type: T): Extract<SidecarBody, { type: T }> {
    if (envelope.body.type === 'error') throw new RuntimeSidecarError(envelope.body);
    if (envelope.body.type !== type) throw new Error(`Expected sidecar ${type}, received ${envelope.body.type}.`);
    return envelope.body as Extract<SidecarBody, { type: T }>;
  }

  private encode(envelope: SidecarEnvelope): Buffer {
    const body = Buffer.from(encodeEnvelope(envelope));
    if (body.length > 1024 * 1024) throw new Error('Runtime sidecar frame exceeds the client limit.');
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
    return Buffer.concat([header, body]);
  }
  private send(envelope: SidecarEnvelope): void { this.write(this.encode(envelope)); }
  private write(frame: Buffer): void {
    if (!this.socket || this.socket.destroyed) throw new RuntimeSidecarTransportError('Runtime sidecar is not connected.');
    if (this.socket.writableLength + frame.length > 8 * 1024 * 1024) throw new Error('Runtime sidecar socket byte budget is full.');
    this.socket.write(frame);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0);
      if (size === 0 || size > 1024 * 1024) {
        this.fail(new Error('Runtime sidecar frame exceeds the client limit.'));
        return;
      }
      if (this.buffer.length < size + 4) return;
      const frame = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);
      try {
        this.onEnvelope(decodeEnvelope(frame));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  private onEnvelope(envelope: SidecarEnvelope): void {
    if (envelope.body.type === 'ready' && this.readyResolve) {
      if (envelope.body.protocol !== 'synax.runtime.v2') {
        this.fail(new Error(`Unsupported runtime sidecar protocol: ${envelope.body.protocol}`));
        return;
      }
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      this.readyResolve(envelope.body);
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    if (envelope.body.type === 'error' && envelope.requestId === '') {
      this.fail(new RuntimeSidecarError(envelope.body));
      return;
    }
    const pending = this.pending.get(envelope.requestId);
    if (!pending) return;
    this.pending.delete(envelope.requestId);
    clearTimeout(pending.timer);
    pending.resolve(envelope);
  }

  private fail(error: Error): void {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.ready = undefined;
    this.buffer = Buffer.alloc(0);
    socket?.destroy();
    this.readyReject?.(error);
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
