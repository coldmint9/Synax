import type { SessionConfigOption } from '@agentclientprotocol/sdk';

export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string | null;
}

export interface SessionModelState {
  currentModelId: string;
  availableModels: ModelInfo[];
  configId?: string;
}

export function readSessionModels(response: {
  configOptions?: SessionConfigOption[] | null;
  models?: SessionModelState | null;
}): SessionModelState | null {
  const option = response.configOptions?.find(option =>
    option.type === 'select' && (option.category === 'model' || option.id === 'model'),
  );
  // Older ACP agents still return the former experimental models field.
  if (option?.type !== 'select') return response.models ?? null;
  const values = option.options.flatMap(value => 'options' in value ? value.options : [value]);
  return {
    currentModelId: option.currentValue,
    configId: option.id,
    availableModels: values.map(value => ({
      modelId: value.value,
      name: value.name,
      description: value.description,
    })),
  };
}

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
