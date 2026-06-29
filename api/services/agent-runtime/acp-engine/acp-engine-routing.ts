import type { StreamTurnRequest } from '../contracts.js';
import { agentRuntimeStore } from '../session-store.js';
import { isAcpModel } from './acp-model.js';
import { getAcpSessionMetadata } from './acp-session-metadata.js';

export function resolveSessionEngineModel(
  sessionId: string,
  input: StreamTurnRequest,
): string | null {
  if (input.model) return input.model;
  const session = agentRuntimeStore.getSession(sessionId);
  const meta = getAcpSessionMetadata(session);
  if (meta?.engineModel) return meta.engineModel;
  const runs = agentRuntimeStore.listRuns(sessionId);
  return runs[0]?.model ?? null;
}

export function shouldUseAcpEngine(sessionId: string, input: StreamTurnRequest): boolean {
  return isAcpModel(resolveSessionEngineModel(sessionId, input));
}

export function sessionUsesAcpEngine(sessionId: string): boolean {
  const session = agentRuntimeStore.getSession(sessionId);
  const meta = getAcpSessionMetadata(session);
  if (meta?.engineModel && isAcpModel(meta.engineModel)) return true;
  const runs = agentRuntimeStore.listRuns(sessionId);
  return runs.some((run) => isAcpModel(run.model));
}
