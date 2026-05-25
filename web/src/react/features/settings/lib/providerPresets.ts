import type { ApiFormat, GlobalConfig, ProviderConnection, ProviderDef } from '../../../../lib/contracts/config'

export const BUILTIN_API_PROVIDER_IDS = ['openai', 'anthropic'] as const
export const CUSTOM_API_PREFIX = 'custom-api:'

export type ProviderPreset = {
  providerId: string
  label: string
  description: string
  format: ApiFormat
  defaultBaseUrl: string
  defaultModel: string
  allowBaseUrlEdit: boolean
}

export type ApiProviderDraft = {
  id: string
  label: string
  description: string
  format: ApiFormat
  baseUrl: string
  apiKey: string
  apiKeyMasked: string
  model: string
  models: string[]
  custom: boolean
  status: 'live' | 'experimental' | 'inactive'
  showApiKey: boolean
  discoveringModels: boolean
  validating: boolean
  modelMessage: string | null
  validationMessage: string | null
}

export const API_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    providerId: 'openai',
    label: 'OpenAI',
    description: 'OpenAI API',
    format: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    allowBaseUrlEdit: false,
  },
  {
    providerId: 'anthropic',
    label: 'Anthropic',
    description: 'Anthropic Messages API',
    format: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-3-5-sonnet-latest',
    allowBaseUrlEdit: false,
  },
  {
    providerId: 'custom-api:deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek OpenAI-compatible API',
    format: 'openai',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    allowBaseUrlEdit: false,
  },
  {
    providerId: 'custom-api:openrouter',
    label: 'OpenRouter',
    description: 'OpenRouter OpenAI-compatible API',
    format: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    allowBaseUrlEdit: false,
  },
  {
    providerId: 'custom-api:xai',
    label: 'xAI',
    description: 'xAI OpenAI-compatible API',
    format: 'openai',
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-2-latest',
    allowBaseUrlEdit: false,
  },
]

export const PRESET_BY_PROVIDER_ID = new Map(API_PROVIDER_PRESETS.map(p => [p.providerId, p]))

export const PROVIDER_LOGO_ASSETS: Record<string, { src: string; invertOnDark?: boolean }> = {
  openai: { src: '/provider-logos/openai.svg', invertOnDark: true },
  anthropic: { src: '/provider-logos/anthropic.svg' },
  'custom-api:deepseek': { src: '/provider-logos/deepseek.png' },
  'custom-api:openrouter': { src: '/provider-logos/openrouter.svg', invertOnDark: true },
  'custom-api:xai': { src: '/provider-logos/xai.ico', invertOnDark: true },
}

export function defaultBaseUrl(format: ApiFormat) {
  return format === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'
}

export function defaultModel(format: ApiFormat) {
  return format === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4o-mini'
}

export function isBuiltinApiProviderId(id: string): boolean {
  return id === 'openai' || id === 'anthropic'
}

export function isConfiguredProvider(draft: ApiProviderDraft): boolean {
  return Boolean(draft.apiKey.trim() || draft.apiKeyMasked.trim())
}

export function normalizeModelList(models: string[], model: string): string[] {
  const merged = [...models]
  if (model && !merged.includes(model)) merged.unshift(model)
  return Array.from(new Set(merged.map(s => s.trim()).filter(Boolean)))
}

export function resolveFormat(providerId: string, connection?: ProviderConnection): ApiFormat {
  const raw = connection?.extra?.apiFormat
  if (raw === 'anthropic') return 'anthropic'
  if (raw === 'openai-responses') return 'openai-responses'
  if (raw === 'openai') return 'openai'
  return PRESET_BY_PROVIDER_ID.get(providerId)?.format ?? (providerId === 'anthropic' ? 'anthropic' : 'openai')
}

export function resolveModel(provider: ProviderDef, connection: ProviderConnection | undefined, format: ApiFormat): string {
  const model = typeof connection?.extra?.model === 'string' ? connection.extra.model.trim() : ''
  if (model) return model
  const presetModel = PRESET_BY_PROVIDER_ID.get(provider.id)?.defaultModel
  if (presetModel) return presetModel
  const defaultProviderModel = provider.models.find(m => m.isDefault)?.id ?? provider.models[0]?.id
  return defaultProviderModel ?? defaultModel(format)
}

export function fallbackBuiltinApiProvider(providerId: 'openai' | 'anthropic'): ProviderDef {
  const preset = PRESET_BY_PROVIDER_ID.get(providerId)
  const format: ApiFormat = preset?.format ?? (providerId === 'anthropic' ? 'anthropic' : 'openai')
  const model = preset?.defaultModel ?? defaultModel(format)
  return {
    id: providerId,
    label: preset?.label ?? providerId,
    description: preset?.description,
    status: 'live',
    kind: 'api',
    caps: { canFollowUp: true, canCancel: true },
    models: [{ id: model, label: model, isDefault: true }],
  }
}

export function buildApiDrafts(globalConfig: GlobalConfig, providers: ProviderDef[]): ApiProviderDraft[] {
  const providerMap = new Map<string, ProviderDef>()
  for (const provider of providers) {
    if (provider.kind === 'api') providerMap.set(provider.id, provider)
  }
  for (const id of BUILTIN_API_PROVIDER_IDS) {
    if (!providerMap.has(id)) providerMap.set(id, fallbackBuiltinApiProvider(id))
  }
  const sorted = Array.from(providerMap.values()).sort((a, b) => {
    const ap = PRESET_BY_PROVIDER_ID.has(a.id)
    const bp = PRESET_BY_PROVIDER_ID.has(b.id)
    if (ap && !bp) return -1
    if (!ap && bp) return 1
    return a.label.localeCompare(b.label)
  })
  return sorted.map(provider => {
    const preset = PRESET_BY_PROVIDER_ID.get(provider.id)
    const connection = globalConfig.providerConnections[provider.id]
    const format = resolveFormat(provider.id, connection)
    const model = resolveModel(provider, connection, format)
    return {
      id: provider.id,
      label: provider.label || preset?.label || provider.id,
      description: provider.description ?? preset?.description ?? '',
      format,
      baseUrl: connection?.baseUrl ?? preset?.defaultBaseUrl ?? defaultBaseUrl(format),
      apiKey: '',
      apiKeyMasked: connection?.apiKeyMasked ?? '',
      model,
      models: normalizeModelList(provider.models.map(m => m.id), model),
      custom: !preset,
      status: provider.status,
      showApiKey: false,
      discoveringModels: false,
      validating: false,
      modelMessage: null,
      validationMessage: null,
    }
  })
}

export function createDraftFromPreset(preset: ProviderPreset): ApiProviderDraft {
  return {
    id: preset.providerId,
    label: preset.label,
    description: preset.description,
    format: preset.format,
    baseUrl: preset.defaultBaseUrl,
    apiKey: '',
    apiKeyMasked: '',
    model: preset.defaultModel,
    models: [preset.defaultModel],
    custom: false,
    status: 'live',
    showApiKey: false,
    discoveringModels: false,
    validating: false,
    modelMessage: null,
    validationMessage: null,
  }
}

export function createCustomDraft(existing: ApiProviderDraft[]): ApiProviderDraft {
  const count = existing.filter(d => d.custom).length + 1
  return {
    id: `${CUSTOM_API_PREFIX}${Date.now()}`,
    label: `Custom API ${count}`,
    description: '',
    format: 'openai',
    baseUrl: '',
    apiKey: '',
    apiKeyMasked: '',
    model: defaultModel('openai'),
    models: [defaultModel('openai')],
    custom: true,
    status: 'live',
    showApiKey: false,
    discoveringModels: false,
    validating: false,
    modelMessage: null,
    validationMessage: null,
  }
}

export function draftToProviderDef(draft: ApiProviderDraft): ProviderDef {
  return {
    id: draft.id,
    label: draft.label.trim() || draft.id,
    description: draft.description.trim() || undefined,
    status: draft.status,
    kind: 'api',
    caps: { canFollowUp: true, canCancel: true },
    models: normalizeModelList(draft.models, draft.model).map(id => ({
      id,
      label: id,
      isDefault: id === draft.model,
    })),
  }
}

export function draftToConnection(draft: ApiProviderDraft): ProviderConnection {
  return {
    providerId: draft.id,
    baseUrl: draft.baseUrl || undefined,
    apiKey: draft.apiKey || undefined,
    apiKeyMasked: draft.apiKey ? undefined : draft.apiKeyMasked || undefined,
    extra: {
      kind: 'api',
      apiFormat: draft.format,
      model: draft.model || undefined,
    },
  }
}

export function upsertDraft(drafts: ApiProviderDraft[], draft: ApiProviderDraft): ApiProviderDraft[] {
  const normalized = {
    ...draft,
    label: draft.label.trim() || draft.id,
    model: draft.model.trim(),
    models: normalizeModelList(draft.models, draft.model.trim()),
  }
  if (drafts.some(d => d.id === normalized.id)) {
    return drafts.map(d => (d.id === normalized.id ? normalized : d))
  }
  return [...drafts, normalized]
}