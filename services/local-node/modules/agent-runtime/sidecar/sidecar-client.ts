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

/**
 * How long a successful execution-fence probe stays authoritative. Stream
 * chunks arrive in bursts, so this bounds the authorisation round trips to the
 * pre-stream check plus a few during long turns.
 */
const EXECUTION_LEASE_REVALIDATE_MS = 1_000;
export const NORMAL_REQUEST_LIMIT = 512;
const CRITICAL_REQUEST_LIMIT = 64;
const NORMAL_REQUEST_BYTES = 32 * 1024 * 1024;
const CRITICAL_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * Control operations that can close, replace or unpin a lease. A cached
 * "current" answer is only trusted until one of these runs.
 */
const LEASE_MUTATING_CONTROL_OPERATIONS = new Set([
  "execution_open",
  "execution_close",
  "stop_begin",
  "stop_cancel",
  "session_patch",
  "compaction_lock",
  "compaction_unlock",
]);

const CRITICAL_CONTROL_OPERATIONS = new Set([
  "execution_open", "execution_close", "stop_begin", "stop_cancel", "stop_unconfirmed", "resume",
]);
function criticalRequest(body: SidecarBody): boolean {
  return body.type === 'health' || (body.type === 'control_command' && CRITICAL_CONTROL_OPERATIONS.has(body.operation));
}


type ExecutionLeaseIdentity = {
  sessionId: string;
  runId: string;
  epoch: string;
  hostId: string;
};

function executionLeaseKey(context: ExecutionLeaseIdentity): string {
  return `${context.runId}/${context.epoch}/${context.hostId}`;
}

/**
 * Last successful execution-fence probe per session, for the lease it proved.
 *
 * Module-scoped on purpose: one process can hold several clients for the same
 * sidecar, and a lease revoked through one of them must not stay "proven" in
 * another. Only a fresh successful probe is ever cached, so a stale entry can
 * delay detection by at most one revalidation window.
 */
const executionLeaseChecks = new Map<string, { key: string; at: number }>();

export class RuntimeSidecarClient {
  private criticalClient?: RuntimeSidecarClient;
  private socket: net.Socket | undefined;
  private buffer = Buffer.alloc(0);
  private ready: Promise<Extract<SidecarBody, { type: 'ready' }>> | undefined;
  private readyResolve: ((value: Extract<SidecarBody, { type: 'ready' }>) => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private readonly operationTails = new Map<string, Promise<void>>();
  private operationCount = 0;
  private operationBytes = 0;
  private readonly lifetime = new AbortController();

  constructor(private readonly options: RuntimeSidecarClientOptions, private readonly lane: 'normal' | 'critical' = 'normal') {
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

  async workspaceIndexCommand(operation: 'register' | 'list' | 'status', payload: unknown): Promise<Uint8Array> {
    const ready = await this.connect();
    if (!ready.capabilities.includes('workspace_index')) throw new Error('Rust sidecar must be rebuilt with workspace_index support.');
    const envelope = await this.request({ type: 'workspace_index_command', operation,
      payload: new TextEncoder().encode(JSON.stringify(payload)) }, '', 0, 0);
    return this.expect(envelope, 'workspace_index_state').stateJson;
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
    queueItem?: unknown;
    runId: string;
    run?: unknown;
    epoch: number;
    revision: number;
  }): Promise<Extract<SidecarBody, { type: 'run_admission' }>> {
    return this.request({ type: 'admit_run', bodyHash: input.bodyHash, runId: input.runId,
      queueItemJson: input.queueItem ? new TextEncoder().encode(JSON.stringify(input.queueItem)) : undefined,
      runJson: input.run === undefined ? undefined : new TextEncoder().encode(JSON.stringify(input.run)) }, input.sessionId, input.epoch, input.revision, input.requestId)
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

  /** Compact actor-serialized authority read; UI state may already be terminal. */
  async assertExecutionLease(context: ExecutionLeaseIdentity): Promise<void> {
    // Called once per stream chunk. The lease can only be revoked by a state
    // change the writer observes anyway, so a short replay window is enough to
    // keep the fence honest without a round trip per token. Superseded answers
    // are never cached: the next check reads authority again.
    const key = executionLeaseKey(context);
    const checked = executionLeaseChecks.get(context.sessionId);
    if (checked?.key === key && Date.now() - checked.at < EXECUTION_LEASE_REVALIDATE_MS) return;
    await this.controlCommand({ sessionId: context.sessionId, requestId: randomUUID(),
      epoch: 0, revision: 0, operation: 'execution_check', payload: context });
    executionLeaseChecks.set(context.sessionId, { key, at: Date.now() });
  }

  async activateRun(input: { requestId?: string; sessionId: string; epoch: number; revision: number; run: unknown }): Promise<Extract<SidecarBody, { type: 'snapshot_response' }>> {
    return this.request({ type: 'activate_run', runJson: new TextEncoder().encode(JSON.stringify(input.run)) }, input.sessionId, input.epoch, input.revision, input.requestId)
      .then(envelope => this.expect(envelope, 'snapshot_response'));
  }

  async queueRead(sessionId: string): Promise<Uint8Array> {
    return this.request({ type: 'queue_read' }, sessionId, 0, 0).then(envelope => this.expect(envelope, 'queue_state').queueJson);
  }

  async queueMutation(input: { sessionId: string; requestId: string; epoch: number; revision: number; operation: string; payload: unknown }): Promise<Uint8Array> {
    return this.request({ type: 'queue_mutation', operation: input.operation,
      payload: new TextEncoder().encode(JSON.stringify(input.payload)) }, input.sessionId, input.epoch, input.revision, input.requestId)
      .then(envelope => this.expect(envelope, 'queue_state').queueJson);
  }

  async controlCommand(input: {
    sessionId: string;
    requestId: string;
    epoch: number;
    revision: number;
    operation: string;
    payload?: unknown;
  }): Promise<{ stateJson: Uint8Array; epoch: number; revision: number }> {
    const envelope = await this.request(
      {
        type: 'control_command',
        operation: input.operation,
        payload: new TextEncoder().encode(JSON.stringify(input.payload ?? null)),
      },
      input.sessionId,
      input.epoch,
      input.revision,
      input.requestId,
    );
    const body = this.expect(envelope, 'control_state');
    // Any fence-moving command may revoke a lease this client cached. Dropping
    // the entry makes the next token revalidate instead of trusting a stale
    // "current" answer.
    if (LEASE_MUTATING_CONTROL_OPERATIONS.has(input.operation)) executionLeaseChecks.clear();
    return { stateJson: body.stateJson, epoch: envelope.epoch, revision: envelope.revision };
  }

  async historyCommand(input: {
    sessionId: string;
    requestId: string;
    operation: string;
    payload?: unknown;
  }): Promise<Uint8Array> {
    // History cursors carry their own generation/revision. A read must not
    // open the execution actor merely to attach an unrelated runtime fence.
    if (["history_sync", "object_value_chunk", "list_checkpoints", "head_read", "message_content", "context_measure"].includes(input.operation)) {
      return this.historyCommandGlobal(input);
    }
    const snapshot = await this.snapshot(input.sessionId);
    const envelope = await this.request(
      {
        type: 'history_command',
        operation: input.operation,
        payload: new TextEncoder().encode(JSON.stringify(input.payload ?? null)),
      },
      input.sessionId,
      snapshot.epoch,
      snapshot.revision,
      input.requestId,
    );
    return this.expect(envelope, 'history_state').stateJson;
  }

  async historyCommandGlobal(input: {
    sessionId: string;
    requestId: string;
    operation: string;
    payload?: unknown;
  }): Promise<Uint8Array> {
    const envelope = await this.request(
      {
        type: 'history_command',
        operation: input.operation,
        payload: new TextEncoder().encode(JSON.stringify(input.payload ?? null)),
      },
      input.sessionId,
      0,
      0,
      input.requestId,
    );
    return this.expect(envelope, 'history_state').stateJson;
  }

  async sessionList(after?: string): Promise<Uint8Array> {
    const envelope = await this.request({ type: 'session_list', after }, '', 0, 0);
    return this.expect(envelope, 'session_list_response').sessionsJson;
  }

  async sessionSummary(id: string): Promise<Uint8Array> {
    const envelope = await this.request({ type: 'session_list', id }, '', 0, 0);
    return this.expect(envelope, 'session_list_response').sessionsJson;
  }

  async resetTestRuntime(): Promise<void> {
    await this.historyCommandGlobal({
      sessionId: "__test__",
      requestId: `test-reset:${randomUUID()}`,
      operation: "test_reset_runtime",
      payload: {},
    });
  }

  async importProjection(sessionId: string, snapshotJson: Uint8Array): Promise<Uint8Array> {
    const envelope = await this.request({ type: 'import_projection', snapshotJson }, sessionId, 0, 0, `import-projection:${sessionId}`);
    return this.expect(envelope, 'import_projection_response').snapshotJson;
  }

  async importStream(sessionId: string, eventsJson: Uint8Array): Promise<Uint8Array> {
    const envelope = await this.request({ type: 'import_stream', eventsJson }, sessionId, 0, 0, `import-stream:${sessionId}`);
    return this.expect(envelope, 'import_stream_response').snapshotJson;
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
    this.criticalClient?.close();
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
    if (this.lane === 'normal' && criticalRequest(body)) {
      this.criticalClient ??= new RuntimeSidecarClient(this.options, 'critical');
      return this.criticalClient.request(body, sessionId, epoch, revision, requestId);
    }
    if (this.operationCount >= (this.lane === 'critical' ? CRITICAL_REQUEST_LIMIT : NORMAL_REQUEST_LIMIT)) throw new Error('Runtime sidecar request queue is full.');
    const frame = this.encode({ requestId, sessionId, epoch, revision, body });
    if (this.operationBytes + frame.length > (this.lane === 'critical' ? CRITICAL_REQUEST_BYTES : NORMAL_REQUEST_BYTES)) throw new Error('Runtime sidecar request byte budget is full.');
    // Correlation IDs cannot be in flight twice on one socket. Serialize
    // identical IDs without coalescing their bodies: Rust still checks the
    // durable receipt and rejects conflicting retries.
    const previous = this.operationTails.get(requestId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.operationTails.set(requestId, tail);
    this.operationCount++; this.operationBytes += frame.length;
    const deadline = Date.now() + (this.options.retryTimeoutMs ?? 45_000);
    let attempt = 0;
    let lastFailure: unknown;
    try {
      await previous;
      if (this.lifetime.signal.aborted) throw new Error('Runtime sidecar client closed.');
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
    } finally {
      release();
      if (this.operationTails.get(requestId) === tail) this.operationTails.delete(requestId);
      this.operationCount--; this.operationBytes -= frame.length;
    }
  }

  private async attempt(frame: Buffer, requestId: string, append: boolean, deadline: number): Promise<SidecarEnvelope> {
    const ready = await bounded(this.connect(), deadline - Date.now());
    if (append && !ready.capabilities.includes('append_receipts')) throw new Error('Runtime sidecar does not support durable append receipts.');
    if (this.lifetime.signal.aborted) throw new Error('Runtime sidecar client closed.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A slow request must not invalidate unrelated in-flight requests on
        // the same socket. The request id is durable, so the retry path can
        // safely replay it and receive the original receipt.
        this.pending.delete(requestId);
        reject(new RuntimeSidecarTransportError(`Runtime sidecar request timed out: ${requestId}`));
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
    if (this.socket.writableLength + frame.length > (this.lane === 'critical' ? CRITICAL_REQUEST_BYTES : NORMAL_REQUEST_BYTES)) throw new Error('Runtime sidecar socket byte budget is full.');
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
