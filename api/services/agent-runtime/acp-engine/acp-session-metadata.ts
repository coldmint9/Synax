import type { AgentCapabilities } from '@agentclientprotocol/sdk';
import type { AgentSession } from '../contracts.js';
import type { AcpProviderId } from './acp-model.js';

export interface AcpSessionMetadata {
  providerId: AcpProviderId;
  acpSessionId: string;
  capabilities?: AgentCapabilities;
  mode?: string | null;
  engineModel?: string | null;
}

const METADATA_KEY = 'acp';

function readRoot(session: AgentSession): Record<string, unknown> {
  return session.sessionMetadata && typeof session.sessionMetadata === 'object'
    ? { ...session.sessionMetadata }
    : {};
}

export function getAcpSessionMetadata(session: AgentSession): AcpSessionMetadata | null {
  const root = session.sessionMetadata;
  if (!root || typeof root !== 'object') return null;
  const acp = (root as Record<string, unknown>)[METADATA_KEY];
  if (!acp || typeof acp !== 'object') return null;
  const record = acp as Record<string, unknown>;
  const providerId = record.providerId;
  const acpSessionId = record.acpSessionId;
  if (typeof providerId !== 'string' || typeof acpSessionId !== 'string') return null;
  return {
    providerId: providerId as AcpProviderId,
    acpSessionId,
    capabilities: record.capabilities as AgentCapabilities | undefined,
    mode: typeof record.mode === 'string' ? record.mode : null,
    engineModel: typeof record.engineModel === 'string' ? record.engineModel : null,
  };
}

export function mergeAcpSessionMetadata(
  session: AgentSession,
  patch: Partial<AcpSessionMetadata>,
): Record<string, unknown> {
  const root = readRoot(session);
  const current = getAcpSessionMetadata(session) ?? {};
  root[METADATA_KEY] = {
    ...current,
    ...patch,
  };
  return root;
}
