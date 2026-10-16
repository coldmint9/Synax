import { decodeUiSnapshot, type RuntimeRecordState } from '../../../../../packages/runtime-protocol/stream.js';
import { RuntimeSidecarClient, RuntimeSidecarError } from './sidecar-client.js';
import type { AcceptedRuntimeInput } from '../run-admission.js';
import type { AgentRun, AgentSession, AgentRunStreamChunk } from '../contracts.js';
import { logger } from '../../../infrastructure/runtime/logger.js';

export type RuntimeSidecarAdmissionMode = 'disabled' | 'shadow';
export type RuntimeSidecarStreamMode = 'disabled' | 'shadow' | 'authoritative';

function streamMode(): RuntimeSidecarStreamMode {
  if (process.env.SYNAX_RUNTIME_SIDECAR_STREAM === 'authoritative') return 'authoritative';
  return process.env.SYNAX_RUNTIME_SIDECAR_STREAM === 'shadow'
    ? 'shadow'
    : 'disabled';
}

function admissionMode(): RuntimeSidecarAdmissionMode {
  return process.env.SYNAX_RUNTIME_SIDECAR_ADMISSION === 'shadow'
    ? 'shadow'
    : 'disabled';
}

let connection: { socketPath: string; token: string; client: RuntimeSidecarClient } | undefined;
function makeClient(): RuntimeSidecarClient | null {
  const socketPath = process.env.SYNAX_RUNTIME_SIDECAR_SOCKET;
  const token = process.env.SYNAX_RUNTIME_SIDECAR_TOKEN;
  if (!socketPath || !token) {
    connection?.client.close();
    connection = undefined;
    return null;
  }
  if (!connection || connection.socketPath !== socketPath || connection.token !== token) {
    connection?.client.close();
    connection = { socketPath, token, client: new RuntimeSidecarClient({ socketPath, token }) };
  }
  return connection.client;
}

export interface ShadowAdmissionInput {
  sessionId: string;
  run: AgentRun;
  runtime: AcceptedRuntimeInput;
}

export interface ShadowStreamInput {
  sessionId: string;
  runId: string;
  producerId: string;
  producerSequence: number;
  epoch: number;
  revision: number;
  chunks: unknown[];
  state: RuntimeRecordState;
}

export class RuntimeFacade {
  constructor(
    private readonly clientFactory: () => RuntimeSidecarClient | null = makeClient,
    private readonly mode: () => RuntimeSidecarAdmissionMode = admissionMode,
  ) {}

  streamMode(): RuntimeSidecarStreamMode {
    return streamMode();
  }

  enabled(): boolean {
    return this.mode() !== 'disabled' && this.clientFactory() !== null;
  }

  /** Admission is awaited before starting provider/tool execution. */
  async admitExecution(input: ShadowAdmissionInput): Promise<void> {
    const authoritative = streamMode() === 'authoritative';
    if (!authoritative && this.mode() !== 'shadow' && streamMode() !== 'shadow') return;
    const client = this.clientFactory();
    if (!client) {
      if (authoritative) throw new Error('Runtime sidecar client is not configured.');
      return;
    }
    try {
      if (authoritative) await this.ensureUiProjection(input.sessionId);
      let admission: Awaited<ReturnType<RuntimeSidecarClient['admitRun']>>;
      for (let attempt = 0; ; attempt++) {
        const state = await client.snapshot(input.sessionId);
        try {
          admission = await client.admitRun({ sessionId: input.sessionId, requestId: input.runtime.requestId,
            bodyHash: input.runtime.inputHash, runId: input.run.id, epoch: state.epoch, revision: state.revision, queueItem: input.runtime.queueItem });
          break;
        } catch (error) {
          if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 7) throw error;
        }
      }
      if (admission.runId !== input.run.id) throw new Error('Runtime admission returned a different run identity.');
      if (authoritative && input.run.status === 'queued') {
        for (let attempt = 0; ; attempt++) {
          const fence = await client.snapshot(input.sessionId);
          if (fence.activeRunId !== input.run.id || fence.epoch !== admission.epoch) throw new Error('Runtime activation fence changed.');
          try {
            const activated = await client.activateRun({ requestId: `${input.runtime.requestId}:activate`, sessionId: input.sessionId,
              epoch: fence.epoch, revision: fence.revision, run: input.run });
            if (activated.activeRunId !== input.run.id || activated.epoch !== admission.epoch) throw new Error('Runtime activation returned an invalid run fence.');
            break;
          } catch (error) {
            if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 7) throw error;
          }
        }
      }
      const current = await client.snapshot(input.sessionId);
      if (current.activeRunId !== input.run.id || current.epoch !== admission.epoch)
        throw new Error('Cannot relaunch a completed or superseded run.');
    } catch (error) {
      if (authoritative) throw error;
      logger.warn({ sessionId: input.sessionId, runId: input.run.id, error }, '[runtime-sidecar] shadow admission failed');
    }
  }

  async finishExecution(sessionId: string, run: AgentRun): Promise<void> {
    const authoritative = streamMode() === 'authoritative';
    if (!authoritative && this.mode() !== 'shadow' && streamMode() !== 'shadow') return;
    const status = run.status;
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'interrupted' && status !== 'blocked') return;
    const client = this.clientFactory();
    if (!client) {
      if (authoritative) throw new Error('Runtime sidecar client is not configured.');
      return;
    }
    try {
      for (let attempt = 0; ; attempt++) {
        const state = await client.snapshot(sessionId);
        try { await client.finishRun({ sessionId, runId: run.id, requestId: `finish:${run.id}`, status, epoch: state.epoch, revision: state.revision, run }); break; }
        catch (error) { if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 7) throw error; }
      }
      await this.persistRunHistory(run);
    } catch (error) {
      if (authoritative) throw error;
      logger.warn({ sessionId, runId: run.id, error }, '[runtime-sidecar] shadow completion failed');
    }
  }

  /** Seed only an empty Rust session during cutover. Existing projections never read SQL. */
  async ensureUiProjection(sessionId: string): Promise<void> {
    await this.uiSnapshotAuthoritative(sessionId);
  }

  async queueMutation(input: {
    sessionId: string; requestId: string;
    operation: 'enqueue' | 'remove' | 'move' | 'force' | 'clear_force' | 'consume' | 'ack_consume'; payload?: unknown;
  }): Promise<Uint8Array | null> {
    if (streamMode() !== 'authoritative') return null;
    await this.ensureUiProjection(input.sessionId);
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    for (let attempt = 0; ; attempt++) {
      const snapshot = await client.snapshot(input.sessionId);
      try { return await client.queueMutation({ ...input, epoch: snapshot.epoch, revision: snapshot.revision, payload: input.payload ?? null }); }
      catch (error) {
        // No write occurred on revision conflict; retry the same semantic command against fresh state.
        if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 7) throw error;
      }
    }
  }
  async queueSnapshot(sessionId: string): Promise<unknown> {
    if (streamMode() !== 'authoritative') throw new Error('Runtime sidecar queue is not authoritative.');
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    try { return JSON.parse(Buffer.from(await client.queueRead(sessionId)).toString('utf8')); }
    catch (error) {
      if (!(error instanceof RuntimeSidecarError) || error.code !== 'PROJECTION_MISSING') throw error;
      await this.ensureUiProjection(sessionId);
      return JSON.parse(Buffer.from(await client.queueRead(sessionId)).toString('utf8'));
    }
  }

  async controlState(sessionId: string): Promise<unknown> {
    if (streamMode() !== 'authoritative') throw new Error('Runtime sidecar controls are not authoritative.');
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    await this.ensureUiProjection(sessionId);
    for (let attempt = 0; ; attempt++) {
      const snapshot = await client.snapshot(sessionId);
      try {
        const result = await client.controlCommand({
          sessionId,
          requestId: `control-read:${sessionId}:${snapshot.epoch}:${snapshot.revision}`,
          epoch: snapshot.epoch,
          revision: snapshot.revision,
          operation: 'read',
        });
        return JSON.parse(Buffer.from(result.stateJson).toString('utf8'));
      } catch (error) {
        if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 7) throw error;
      }
    }
  }

  async controlCommand(input: {
    sessionId: string;
    requestId: string;
    operation: string;
    payload?: unknown;
  }): Promise<unknown> {
    if (streamMode() !== 'authoritative') return null;
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    await this.ensureUiProjection(input.sessionId);
    for (let attempt = 0; ; attempt++) {
      const snapshot = await client.snapshot(input.sessionId);
      try {
        const result = await client.controlCommand({
          ...input,
          epoch: snapshot.epoch,
          revision: snapshot.revision,
        });
        return JSON.parse(Buffer.from(result.stateJson).toString('utf8'));
      } catch (error) {
        if (!(error instanceof RuntimeSidecarError) || error.code !== 'REVISION_CONFLICT' || attempt >= 7) throw error;
      }
    }
  }

  async historyCommand(input: {
    sessionId: string;
    requestId: string;
    operation: string;
    payload?: unknown;
  }): Promise<unknown> {
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    const bytes = await client.historyCommand(input);
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  }

  async persistRunHistory(run: unknown & { id?: string; sessionId?: string }): Promise<void> {
    const sessionId = typeof run.sessionId === 'string' ? run.sessionId : undefined;
    const runId = typeof run.id === 'string' ? run.id : undefined;
    if (!sessionId || !runId) return;
    await this.historyCommand({
      sessionId,
      requestId: `history-run:${runId}`,
      operation: 'put_object',
      payload: { kind: 'runtime.run', value: run },
    });
  }

  async listRunHistory(sessionId: string): Promise<unknown[]> {
    const state = await this.historyCommand({
      sessionId,
      requestId: `history-list-runs:${sessionId}`,
      operation: 'list_runs',
      payload: {},
    }) as { items?: unknown[] };
    return state.items ?? [];
  }

  async uiSnapshotAuthoritative(sessionId: string): Promise<{
    session: AgentSession; run: AgentRun | null; cursor: number;
    liveChunks: AgentRunStreamChunk[]; completedStepIds: string[]; queuedInputs?: unknown[]; forceInjectItemId?: string | null;
  }> {
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    let bytes: Uint8Array;
    try { bytes = await client.uiSnapshot(sessionId); }
    catch (error) {
      if (!(error instanceof RuntimeSidecarError) || error.code !== 'PROJECTION_MISSING') throw error;
      const { agentRuntimeStore } = await import('../session-store.js');
      const session = agentRuntimeStore.getSession(sessionId);
      if (agentRuntimeStore.listRuns(sessionId).some(run => run.status !== 'queued')) {
        throw new RuntimeSidecarError({ type: 'error', code: 'PROJECTION_MIGRATION_REQUIRED',
          message: 'Existing executed runs require offline projection migration.' });
      }
      // Seed is create-if-absent, serialized by the session actor. It cannot overwrite
      // live data; pre-existing runs without a projection require offline migration.
      bytes = await client.seedUi(sessionId, Buffer.from(JSON.stringify(session)));
    }
    return decodeUiSnapshot(bytes, sessionId);
  }

  async uiTicket(sessionId: string, clientId: string) {
    if (streamMode() !== 'authoritative') return null;
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar discovery is not ready.');
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = Number(process.env.SYNAX_RUNTIME_SIDECAR_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Runtime sidecar discovery is not ready.');
      const ticket = await client.issueTicket(sessionId, clientId);
      if (Number(process.env.SYNAX_RUNTIME_SIDECAR_PORT) !== port) continue;
      return { url: `ws://127.0.0.1:${port}/runtime`, token: ticket.token,
        expiresAtMs: ticket.expiresAtMs, clientId, sessionId, protocol: 'synax.runtime.v2' as const };
    }
    throw new Error('Runtime sidecar restarted during ticket issuance.');
  }

  async streamFence(sessionId: string, runId: string): Promise<{ epoch: number; revision: number }> {
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    const snapshot = await client.snapshot(sessionId);
    if (snapshot.activeRunId !== runId) throw new Error('Runtime stream run is not active.');
    return { epoch: snapshot.epoch, revision: snapshot.revision };
  }

  async appendStreamAuthoritative(input: ShadowStreamInput): Promise<void> {
    if (streamMode() !== 'authoritative') return;
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    await client.appendStream({
      sessionId: input.sessionId,
      runId: input.runId,
      producerId: input.producerId,
      producerSequence: input.producerSequence,
      epoch: input.epoch,
      revision: input.revision,
      durability: 'group_commit',
      events: input.chunks.map((chunk) => ({
        kind: typeof chunk === 'object' && chunk && 'type' in chunk
          ? String((chunk as { type: unknown }).type)
          : 'runtime_chunk',
        payload: Buffer.from(JSON.stringify({ schema: 1, chunk, state: input.state })),
      })),
    });
  }

  async replayAuthoritative(
    sessionId: string,
    after: number,
    runId?: string,
  ): Promise<Array<{ sequence: number; runId: string; payload: Uint8Array }>> {
    if (streamMode() !== 'authoritative') return [];
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    const response = await client.replay(sessionId, after);
    return response.events
      .filter((event) => !runId || event.runId === runId)
      .map((event) => ({ sequence: event.sequence, runId: event.runId, payload: event.payload }));
  }

  async snapshotAuthoritative(sessionId: string) {
    if (streamMode() !== 'authoritative') return null;
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    return await client.snapshot(sessionId);
  }

  async shadowAppendStream(input: ShadowStreamInput): Promise<void> {
    if (streamMode() !== 'shadow') return;
    const client = this.clientFactory();
    if (!client) return;
    try {
      await client.appendStream({
        sessionId: input.sessionId,
        runId: input.runId,
        producerId: input.producerId,
        producerSequence: input.producerSequence,
        epoch: input.epoch,
        revision: input.revision,
        durability: 'group_commit',
        events: input.chunks.map((chunk) => ({
          kind: typeof chunk === 'object' && chunk && 'type' in chunk
            ? String((chunk as { type: unknown }).type)
            : 'runtime_chunk',
          payload: Buffer.from(JSON.stringify({ schema: 1, chunk, state: input.state })),
        })),
      });
    } catch (error) {
      const details = error instanceof RuntimeSidecarError
        ? { code: error.code, expected: error.expected, actual: error.actual }
        : {};
      logger.warn(
        { ...details, sessionId: input.sessionId, runId: input.runId, producerSequence: input.producerSequence, error },
        '[runtime-sidecar] shadow stream append failed',
      );
      throw error;
    }
  }
}

export const runtimeFacade = new RuntimeFacade();
