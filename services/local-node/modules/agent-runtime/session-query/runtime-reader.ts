import type { AgentRuntimeMessage, AgentSession } from '../contracts.js';
import { AgentProjectionUnavailableError } from '../runtime-errors.js';
import { runtimeFacade } from '../sidecar/runtime-facade.js';
import {
  RuntimeSidecarError,
  RuntimeSidecarTransportError,
} from '../sidecar/sidecar-client.js';
import type { SessionReader } from './contracts.js';
import { SessionQueryError } from './errors.js';

/** The subset of RuntimeFacade this read model depends on. */
export interface RuntimeSessionSource {
  listSessionProjection(): Promise<unknown[]>;
  sessionSummaryAuthoritative(sessionId: string): Promise<AgentSession>;
  listMessageHistory(sessionId: string): Promise<unknown[]>;
}

function transportFailure(error: unknown): SessionQueryError | null {
  if (
    error instanceof RuntimeSidecarError ||
    error instanceof RuntimeSidecarTransportError ||
    error instanceof AgentProjectionUnavailableError
  )
    return new SessionQueryError(
      'RUNTIME_UNAVAILABLE',
      `Agent runtime history is unavailable: ${error.message}`,
    );
  // Facade calls fail this way when the process has no sidecar connection.
  if (
    error instanceof Error &&
    error.message === 'Runtime sidecar client is not configured.'
  )
    return new SessionQueryError(
      'RUNTIME_UNAVAILABLE',
      'Agent runtime history is unavailable in this process.',
    );
  return null;
}

function missingSession(sessionId: string): SessionQueryError {
  return new SessionQueryError(
    'SESSION_NOT_FOUND',
    `Session ${sessionId} was not found.`,
  );
}

/**
 * Authoritative reads over the Rust runtime. The in-process session store only
 * mirrors a working set, so a cross-session list or transcript must come from
 * the sidecar index instead.
 */
export function createRuntimeSessionReader(
  source: RuntimeSessionSource = runtimeFacade,
): SessionReader {
  return {
    async listSessions() {
      try {
        const items = await source.listSessionProjection();
        return items.filter(
          (item): item is AgentSession =>
            Boolean(item) &&
            typeof item === 'object' &&
            typeof (item as { id?: unknown }).id === 'string',
        );
      } catch (error) {
        throw transportFailure(error) ?? error;
      }
    },
    async getSession(sessionId) {
      try {
        return await source.sessionSummaryAuthoritative(sessionId);
      } catch (error) {
        if (
          error instanceof RuntimeSidecarError &&
          error.code === 'PROJECTION_MISSING'
        )
          throw missingSession(sessionId);
        throw transportFailure(error) ?? error;
      }
    },
    async listMessages(sessionId) {
      try {
        const items = await source.listMessageHistory(sessionId);
        return items.filter(
          (item): item is AgentRuntimeMessage =>
            Boolean(item) &&
            typeof item === 'object' &&
            typeof (item as { id?: unknown }).id === 'string',
        );
      } catch (error) {
        throw transportFailure(error) ?? error;
      }
    },
  };
}
