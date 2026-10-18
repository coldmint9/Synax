import { RuntimeSidecarError } from "./sidecar/sidecar-client.js";
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
  if (error instanceof RuntimeSidecarError) {
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
