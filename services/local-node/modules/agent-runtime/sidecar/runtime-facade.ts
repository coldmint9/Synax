import { RuntimeSidecarClient, RuntimeSidecarError } from './sidecar-client.js';
import type { AcceptedRuntimeInput } from '../run-admission.js';
import type { AgentRun } from '../contracts.js';
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
      const state = await client.snapshot(input.sessionId);
      const admission = await client.admitRun({
        sessionId: input.sessionId,
        requestId: input.runtime.requestId,
        bodyHash: input.runtime.inputHash,
        runId: input.run.id,
        epoch: state.epoch,
        revision: state.revision,
      });
      if (admission.runId !== input.run.id) throw new Error('Runtime admission returned a different run identity.');
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
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'interrupted') return;
    const client = this.clientFactory();
    if (!client) {
      if (authoritative) throw new Error('Runtime sidecar client is not configured.');
      return;
    }
    try {
      const state = await client.snapshot(sessionId);
      await client.finishRun({ sessionId, runId: run.id, requestId: `finish:${run.id}`,
        status, epoch: state.epoch, revision: state.revision });
    } catch (error) {
      if (authoritative) throw error;
      logger.warn({ sessionId, runId: run.id, error }, '[runtime-sidecar] shadow completion failed');
    }
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
        payload: Buffer.from(JSON.stringify(chunk)),
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
          payload: Buffer.from(JSON.stringify(chunk)),
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
