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

function makeClient(): RuntimeSidecarClient | null {
  const socketPath = process.env.SYNAX_RUNTIME_SIDECAR_SOCKET;
  const token = process.env.SYNAX_RUNTIME_SIDECAR_TOKEN;
  if (!socketPath || !token) return null;
  return new RuntimeSidecarClient({ socketPath, token });
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

  async shadowAdmit(input: ShadowAdmissionInput): Promise<void> {
    if (this.mode() !== 'shadow') return;
    const client = this.clientFactory();
    if (!client) return;
    try {
      const admission = await client.admitRun({
        sessionId: input.sessionId,
        requestId: input.runtime.requestId,
        bodyHash: input.runtime.inputHash,
        runId: input.run.id,
        epoch: 1,
        revision: 0,
      });
      if (admission.runId !== input.run.id) {
        logger.error(
          {
            sessionId: input.sessionId,
            localRunId: input.run.id,
            sidecarRunId: admission.runId,
            requestId: input.runtime.requestId,
          },
          '[runtime-sidecar] shadow admission identity mismatch',
        );
      }
    } catch (error) {
      const details = error instanceof RuntimeSidecarError
        ? { code: error.code, expected: error.expected, actual: error.actual }
        : {};
      logger.warn(
        { ...details, sessionId: input.sessionId, runId: input.run.id, requestId: input.runtime.requestId, error },
        '[runtime-sidecar] shadow admission failed',
      );
    } finally {
      client.close();
    }
  }

  async appendStreamAuthoritative(input: ShadowStreamInput): Promise<void> {
    if (streamMode() !== 'authoritative') return;
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
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
    } finally {
      client.close();
    }
  }

  async replayAuthoritative(
    sessionId: string,
    after: number,
    runId?: string,
  ): Promise<Array<{ sequence: number; runId: string; payload: Uint8Array }>> {
    if (streamMode() !== 'authoritative') return [];
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    try {
      const response = await client.replay(sessionId, after);
      return response.events
        .filter((event) => !runId || event.runId === runId)
        .map((event) => ({ sequence: event.sequence, runId: event.runId, payload: event.payload }));
    } finally {
      client.close();
    }
  }

  async snapshotAuthoritative(sessionId: string) {
    if (streamMode() !== 'authoritative') return null;
    const client = this.clientFactory();
    if (!client) throw new Error('Runtime sidecar client is not configured.');
    try {
      return await client.snapshot(sessionId);
    } finally {
      client.close();
    }
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
    } finally {
      client.close();
    }
  }
}

export const runtimeFacade = new RuntimeFacade();
