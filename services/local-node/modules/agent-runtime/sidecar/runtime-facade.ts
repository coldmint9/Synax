import { RuntimeSidecarClient, RuntimeSidecarError } from './sidecar-client.js';
import type { AcceptedRuntimeInput } from '../run-admission.js';
import type { AgentRun } from '../contracts.js';
import { logger } from '../../../infrastructure/runtime/logger.js';

export type RuntimeSidecarAdmissionMode = 'disabled' | 'shadow';

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

export class RuntimeFacade {
  constructor(
    private readonly clientFactory: () => RuntimeSidecarClient | null = makeClient,
    private readonly mode: () => RuntimeSidecarAdmissionMode = admissionMode,
  ) {}

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
}

export const runtimeFacade = new RuntimeFacade();
