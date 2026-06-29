const ACP_PROVIDER_PREFIXES = ['cursor-acp', 'opencode-acp'] as const;

export type AcpProviderId = (typeof ACP_PROVIDER_PREFIXES)[number];

export interface ParsedAcpModel {
  providerId: AcpProviderId;
  modelId: string;
}

export function isAcpModel(model: string | null | undefined): model is string {
  if (!model || !model.trim()) return false;
  const provider = model.split('/')[0];
  return ACP_PROVIDER_PREFIXES.includes(provider as AcpProviderId);
}

export function parseAcpModel(model: string): ParsedAcpModel {
  const slash = model.indexOf('/');
  if (slash <= 0) {
    throw new Error(`Invalid ACP model id: ${model}`);
  }
  const providerId = model.slice(0, slash) as AcpProviderId;
  const modelId = model.slice(slash + 1);
  if (!ACP_PROVIDER_PREFIXES.includes(providerId) || !modelId) {
    throw new Error(`Invalid ACP model id: ${model}`);
  }
  return { providerId, modelId };
}

export function resolveAcpProviderFromModel(model: string | null | undefined): AcpProviderId | null {
  if (!isAcpModel(model)) return null;
  return parseAcpModel(model!).providerId;
}
