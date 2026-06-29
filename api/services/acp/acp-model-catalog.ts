import type { ModelInfo, SessionModelState } from '@agentclientprotocol/sdk';

export interface AcpCatalogModel {
  id: string;
  label: string;
  description?: string | null;
}

export function mapSessionModels(state: SessionModelState | null | undefined): AcpCatalogModel[] {
  if (!state?.availableModels?.length) return [];
  return state.availableModels.map(mapModelInfo);
}

export function mapModelInfo(model: ModelInfo): AcpCatalogModel {
  return {
    id: model.modelId,
    label: model.name?.trim() || model.modelId,
    description: model.description ?? null,
  };
}
