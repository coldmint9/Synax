import type { StreamTurnRequest } from '../contracts.js';
import { isAcpProviderId } from '../../../lib/config/acp-provider-ids.js';
import { resolveSessionBackend, resolveBackendModel } from '../backends/backend-binding.js';

export const resolveSessionEngineModel = resolveBackendModel;

export function shouldUseAcpEngine(sessionId: string, input: StreamTurnRequest): boolean {
  resolveBackendModel(sessionId, input);
  return isAcpProviderId(resolveSessionBackend(sessionId).id);
}

export function sessionUsesAcpEngine(sessionId: string): boolean {
  return isAcpProviderId(resolveSessionBackend(sessionId).id);
}
