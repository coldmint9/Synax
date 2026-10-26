import {
  RuntimeSidecarError,
  RuntimeSidecarTransportError,
} from "./sidecar/sidecar-client.js";
import { VersionStoreError } from "./validation/limits.js";
export class AgentRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code = 'AGENT_RUNTIME_ERROR',
    public readonly status = 500,
  ) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

export class AgentNotFoundError extends AgentRuntimeError {
  constructor(id: string) {
    super(`Agent runtime resource not found: ${id}`, 'NOT_FOUND', 404);
  }
}

/** A model can request a stale or invented tool name. This is a tool result,
 * not evidence that its session (or any durable runtime resource) was lost. */
export class AgentToolNotFoundError extends AgentRuntimeError {
  constructor(public readonly toolId: string) {
    super(
      `Tool not found: ${toolId}. Use the exact names and argument schemas from the current tool definitions.`,
      'TOOL_NOT_FOUND',
      422,
    );
  }
}

export function isToolResolutionError(error: unknown): error is AgentToolNotFoundError | AgentPermissionError {
  return error instanceof AgentToolNotFoundError || error instanceof AgentPermissionError;
}

/**
 * The session exists but its UI projection cannot be served right now (a
 * repair or migration is required). This is retryable and must never be
 * reported as a missing session: the projection is a cache, while the durable
 * session row decides whether the id exists.
 */
export class AgentProjectionUnavailableError extends AgentRuntimeError {
  constructor(id: string, code = 'PROJECTION_RECOVERING') {
    super(
      `Agent runtime projection is recovering: ${id}`,
      code,
      503,
    );
  }
}

export class AgentValidationError extends AgentRuntimeError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

export class AgentPermissionError extends AgentRuntimeError {
  constructor(message: string, status = 403) {
    super(message, 'PERMISSION_ERROR', status);
  }
}

export class AgentProviderNotConfiguredError extends AgentRuntimeError {
  constructor(message = 'No LLM provider configured. Please configure a provider in Settings.') {
    super(message, 'LLM_PROVIDER_NOT_CONFIGURED', 422);
  }
}

export function toRuntimeError(error: unknown): AgentRuntimeError {
  if (error instanceof AgentRuntimeError) return error;
  if (error instanceof RuntimeSidecarTransportError)
    return new AgentRuntimeError(
      error.message,
      "RUNTIME_TRANSPORT_UNAVAILABLE",
      503,
    );
  if (error instanceof RuntimeSidecarError) {
    if (error.code === 'NOT_FOUND') return new AgentRuntimeError(error.message, error.code, 404);
    if (error.message.includes('entity exceeds history page byte budget'))
      return new AgentRuntimeError(error.message, 'HISTORY_ENTITY_TOO_LARGE', 413);
    if (error.code === 'HISTORY_NOT_FOUND') return new AgentRuntimeError(error.message, error.code, 404);
    if (error.code === 'HISTORY_ERROR') return new AgentRuntimeError(error.message, error.code, 500);
    const status = error.code === 'INVALID_COMMAND' ? 400 : ['STORAGE_UNAVAILABLE','DISK_FULL','DURABILITY_UNKNOWN','BACKPRESSURE'].includes(error.code) ? 503 : 409;
    return new AgentRuntimeError(error.message, error.code, status);
  }
  if(error instanceof VersionStoreError){
    const status=error.code.includes("BUDGET")||error.code.includes("SIZE")?413:error.code.includes("MISSING")||error.code.includes("NOT_FOUND")?404:409;
    return new AgentRuntimeError(error.message,error.code,status);
  }
  if (error instanceof Error) return new AgentRuntimeError(error.message);
  return new AgentRuntimeError(String(error));
}

export function toHttpError(error: unknown): { status: number; body: { error: string; code: string } } {
  const runtimeError = toRuntimeError(error);
  return {
    status: runtimeError.status,
    body: {
      error: runtimeError.message,
      code: runtimeError.code,
    },
  };
}
