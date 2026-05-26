import type { ApiFormat, ProviderConnection, ProviderDef } from '../../lib/config/config-types.js'
import { isProviderSupported } from './registry.js'
import type {
  ModelOverrideConfig,
  ResolveLlmSelectionInput,
  ResolvedModelSelection,
  ResolvedProviderConfig,
  RuntimeCatalog,
  RuntimeModel,
  RuntimeProvider,
} from './types.js'

export function resolveLlmSelection(input: ResolveLlmSelectionInput): ResolvedModelSelection {
  const attempts = buildCandidateRefs(input)

  for (const candidate of attempts) {
    const resolved = tryResolveCandidate(input.catalog, input, candidate)
    if (resolved) return resolved
  }

  const fallback = firstAllowedProvider(input.catalog, input)
  if (!fallback) {
    throw new Error('No enabled API providers are available')
  }

  const fallbackConnection = input.globalConfig.providerConnections[fallback.id]
  const configuredFallbackModelId = resolveModelIdFromConnection(fallbackConnection)
  const modelDef = configuredFallbackModelId
    ? (fallback.models.find((model) => model.id === configuredFallbackModelId)
      ?? { id: configuredFallbackModelId, label: configuredFallbackModelId })
    : (fallback.models.find((model) => model.isDefault) ?? fallback.models[0])
  if (!modelDef) {
    throw new Error(`Provider '${fallback.id}' has no models`)
  }

  return {
    model: `${fallback.id}/${modelDef.id}`,
    providerId: fallback.id,
    modelId: modelDef.id,
    provider: fallback,
    modelDef,
    config: mergeProviderConfig(
      fallback.id,
      input.globalConfig.providerConnections[fallback.id],
      projectConnectionForProvider(input, fallback.id),
    ),
  }
}

export function resolveProviderModelRef(value: string | undefined | null): { providerId: string; modelId: string } | null {
  if (!value) return null
  const trimmed = value.trim()
  const sep = trimmed.indexOf('/')
  if (sep <= 0 || sep >= trimmed.length - 1) return null
  return {
    providerId: trimmed.slice(0, sep),
    modelId: trimmed.slice(sep + 1),
  }
}

export function mergeProviderConfig(
  providerId: string,
  globalConnection?: ProviderConnection,
  projectConnection?: ProviderConnection,
): ResolvedProviderConfig {
  const globalConfig = normalizeConnection(globalConnection)
  const projectConfig = normalizeConnection(projectConnection)
  const mergedOptions = mergeObject(globalConfig.options, projectConfig.options)
  const mergedModels = {
    ...(globalConfig.models ?? {}),
    ...(projectConfig.models ?? {}),
  }

  return {
    providerId,
    ...globalConfig,
    ...projectConfig,
    ...(mergedOptions ? { options: mergedOptions } : {}),
    ...(Object.keys(mergedModels).length > 0 ? { models: mergedModels } : {}),
    ...(projectConfig.whitelist
      ? { whitelist: projectConfig.whitelist }
      : globalConfig.whitelist
        ? { whitelist: globalConfig.whitelist }
        : {}),
    ...(projectConfig.blacklist
      ? { blacklist: projectConfig.blacklist }
      : globalConfig.blacklist
        ? { blacklist: globalConfig.blacklist }
        : {}),
  }
}

export function isProviderEnabled(providerId: string, catalog: RuntimeCatalog, input: ResolveLlmSelectionInput): boolean {
  const provider = resolveRuntimeProvider(providerId, input)
  if (!provider?.supported) return false
  return isApiProvider(providerId, input)
}

function tryResolveCandidate(
  catalog: RuntimeCatalog,
  input: ResolveLlmSelectionInput,
  candidate: string | undefined,
): ResolvedModelSelection | null {
  const parsed = resolveProviderModelRef(candidate)
  if (!parsed) return null
  if (!isProviderEnabled(parsed.providerId, catalog, input)) return null

  const provider = resolveRuntimeProvider(parsed.providerId, input)
  if (!provider) return null

  const config = mergeProviderConfig(
    parsed.providerId,
    input.globalConfig.providerConnections[parsed.providerId],
    projectConnectionForProvider(input, parsed.providerId),
  )
  if (!isModelAllowed(parsed.modelId, config)) return null

  const modelDef = findModel(provider, parsed.modelId, config)
  if (!modelDef) return null

  return {
    model: `${parsed.providerId}/${parsed.modelId}`,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    provider,
    modelDef,
    config,
  }
}

function findModel(provider: RuntimeProvider, modelId: string, config: ResolvedProviderConfig): RuntimeModel | null {
  const fromCatalog = provider.models.find((model) => model.id === modelId)
  if (fromCatalog) return fromCatalog
  const override = config.models?.[modelId]
  if (!override) return null
  return {
    id: modelId,
    label: override.label || modelId,
  }
}

function isModelAllowed(modelId: string, config: ResolvedProviderConfig): boolean {
  if (config.whitelist?.length && !config.whitelist.includes(modelId)) return false
  if (config.blacklist?.includes(modelId)) return false
  return true
}

function firstAllowedProvider(catalog: RuntimeCatalog, input: ResolveLlmSelectionInput): RuntimeProvider | null {
  for (const providerId of enabledApiProviderIds(input)) {
    if (!isProviderEnabled(providerId, catalog, input)) continue
    const provider = resolveRuntimeProvider(providerId, input)
    if (provider) return provider
  }
  return null
}

function buildCandidateRefs(input: ResolveLlmSelectionInput): string[] {
  const preferredProviderId = resolvePreferredProviderId(input)
  return unique([
    normalizeModelRef(input.modelOverride, preferredProviderId),
    resolveProjectModelRef(input),
    resolveDefaultApiModelRef(input),
  ])
}

function resolvePreferredProviderId(input: ResolveLlmSelectionInput): string {
  const projectProviderId = input.projectConfig?.providerId
  if (projectProviderId && isApiProvider(projectProviderId, input)) {
    return projectProviderId
  }
  return input.globalConfig.defaultApiProviderId
}

function resolveProjectModelRef(input: ResolveLlmSelectionInput): string | undefined {
  const project = input.projectConfig
  if (!project) return undefined

  const providerId = project.providerId
  if (providerId && isApiProvider(providerId, input)) {
    const modelId =
      project.modelId?.trim() ||
      resolveModelIdFromConnection(project.providerConnection)
    return modelId ? `${providerId}/${modelId}` : undefined
  }

  if (project.modelId?.trim()) {
    return `${input.globalConfig.defaultApiProviderId}/${project.modelId.trim()}`
  }

  return undefined
}

function resolveDefaultApiModelRef(input: ResolveLlmSelectionInput): string | undefined {
  const providerId = input.globalConfig.defaultApiProviderId
  const modelId =
    resolveModelIdFromConnection(input.globalConfig.providerConnections[providerId]) ||
    resolveDefaultModelFromProviderDef(input, providerId)

  return modelId ? `${providerId}/${modelId}` : undefined
}

function resolveDefaultModelFromProviderDef(input: ResolveLlmSelectionInput, providerId: string): string | undefined {
  const provider = input.globalConfig.providers.find((item) => item.id === providerId)
  if (!provider) return undefined
  return provider.models.find((model) => model.isDefault)?.id ?? provider.models[0]?.id
}

function projectConnectionForProvider(input: ResolveLlmSelectionInput, providerId: string): ProviderConnection | undefined {
  const projectConnection = input.projectConfig?.providerConnection
  if (!projectConnection) return undefined
  return projectConnection.providerId === providerId ? projectConnection : undefined
}

function isApiProvider(providerId: string, input: ResolveLlmSelectionInput): boolean {
  return input.globalConfig.providers.some((provider) => provider.id === providerId && provider.kind === 'api')
}

function enabledApiProviderIds(input: ResolveLlmSelectionInput): string[] {
  return unique([
    input.projectConfig?.providerId && isApiProvider(input.projectConfig.providerId, input)
      ? input.projectConfig.providerId
      : undefined,
    input.globalConfig.defaultApiProviderId,
    ...input.globalConfig.providers
      .filter((provider) => provider.kind === 'api')
      .map((provider) => provider.id),
  ])
}

export function resolveRuntimeProvider(providerId: string, input: ResolveLlmSelectionInput): RuntimeProvider | null {
  const fromCatalog = input.catalog.providers.find((provider) => provider.id === providerId)
  const providerDef = input.globalConfig.providers.find((provider) => provider.id === providerId)

  if (fromCatalog) {
    if (providerDef && providerDef.models.length > 0) {
      const connection = mergeConnectionMetadata(
        input.globalConfig.providerConnections[providerId],
        projectConnectionForProvider(input, providerId),
      )
      return {
        ...fromCatalog,
        models: toRuntimeModels(providerDef, connection),
      }
    }
    return fromCatalog
  }

  if (!providerDef || providerDef.kind !== 'api') return null

  return createConfiguredRuntimeProvider(
    providerDef,
    mergeConnectionMetadata(
      input.globalConfig.providerConnections[providerId],
      projectConnectionForProvider(input, providerId),
    ),
  )
}

function createConfiguredRuntimeProvider(provider: ProviderDef, connection?: ProviderConnection): RuntimeProvider {
  const { npm, api, env } = resolveConfiguredProviderAdapter(provider.id, connection)
  return {
    id: provider.id,
    label: provider.label,
    description: provider.description,
    npm,
    api,
    env,
    supported: isProviderSupported({ npm }),
    models: toRuntimeModels(provider, connection),
  }
}

const KNOWN_PROVIDER_ADAPTERS: Record<string, Pick<RuntimeProvider, 'npm' | 'api' | 'env'>> = {
  deepseek: { npm: '@ai-sdk/deepseek', api: 'https://api.deepseek.com', env: ['DEEPSEEK_API_KEY'] },
  groq: { npm: '@ai-sdk/groq', api: 'https://api.groq.com/openai/v1', env: ['GROQ_API_KEY'] },
  mistral: { npm: '@ai-sdk/mistral', api: 'https://api.mistral.ai/v1', env: ['MISTRAL_API_KEY'] },
  xai: { npm: '@ai-sdk/xai', api: 'https://api.x.ai/v1', env: ['XAI_API_KEY'] },
  perplexity: { npm: '@ai-sdk/perplexity', api: 'https://api.perplexity.ai', env: ['PERPLEXITY_API_KEY'] },
  google: { npm: '@ai-sdk/google', env: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'] },
  cohere: { npm: '@ai-sdk/cohere', env: ['COHERE_API_KEY'] },
  togetherai: { npm: '@ai-sdk/togetherai', env: ['TOGETHER_AI_API_KEY'] },
  cerebras: { npm: '@ai-sdk/cerebras', env: ['CEREBRAS_API_KEY'] },
  deepinfra: { npm: '@ai-sdk/deepinfra', env: ['DEEPINFRA_API_KEY'] },
}

function resolveConfiguredProviderAdapter(
  providerId: string,
  connection?: ProviderConnection,
): Pick<RuntimeProvider, 'npm' | 'api' | 'env'> {
  if (providerId === 'openai') {
    return {
      npm: '@ai-sdk/openai',
      api: connection?.baseUrl ?? 'https://api.openai.com/v1',
      env: ['OPENAI_API_KEY'],
    }
  }

  if (providerId === 'anthropic') {
    return {
      npm: '@ai-sdk/anthropic',
      api: connection?.baseUrl ?? 'https://api.anthropic.com/v1',
      env: ['ANTHROPIC_API_KEY'],
    }
  }

  const apiFormat = resolveApiFormat(connection)
  if (apiFormat === 'anthropic') {
    return {
      npm: '@ai-sdk/anthropic',
      api: connection?.baseUrl,
      env: [],
    }
  }

  // Use dedicated provider when available and no custom baseUrl override
  const known = KNOWN_PROVIDER_ADAPTERS[providerId]
  if (known && (!connection?.baseUrl || connection.baseUrl === known.api)) {
    return {
      npm: known.npm,
      api: connection?.baseUrl ?? known.api,
      env: known.env,
    }
  }

  return {
    npm: '@ai-sdk/openai-compatible',
    api: connection?.baseUrl,
    env: [],
  }
}

function toRuntimeModels(provider: ProviderDef, connection?: ProviderConnection): RuntimeModel[] {
  const configuredModelId = resolveModelIdFromConnection(connection)
  const baseModels = provider.models.map((model) => ({
    id: model.id,
    label: model.label,
    isDefault: model.isDefault,
    maxTokens: model.maxTokens,
  }))

  if (!configuredModelId) {
    return baseModels
  }

  const existing = baseModels.find((model) => model.id === configuredModelId)
  if (existing) {
    if (!baseModels.some((model) => model.isDefault)) {
      existing.isDefault = true
    }
    return baseModels
  }

  return [
    ...baseModels,
    {
      id: configuredModelId,
      label: configuredModelId,
      isDefault: !baseModels.some((model) => model.isDefault),
    },
  ]
}

function mergeConnectionMetadata(
  globalConnection?: ProviderConnection,
  projectConnection?: ProviderConnection,
): ProviderConnection | undefined {
  if (!globalConnection && !projectConnection) return undefined

  return {
    providerId: projectConnection?.providerId ?? globalConnection?.providerId ?? '',
    ...globalConnection,
    ...projectConnection,
    extra: {
      ...(toRecord(globalConnection?.extra) ?? {}),
      ...(toRecord(projectConnection?.extra) ?? {}),
    },
  }
}

function resolveApiFormat(connection?: ProviderConnection): ApiFormat {
  const extra = toRecord(connection?.extra)
  const format = extra?.apiFormat
  if (format === 'anthropic') return 'anthropic'
  if (format === 'openai-responses') return 'openai-responses'
  return 'openai'
}

function resolveModelIdFromConnection(connection?: ProviderConnection | null): string | undefined {
  const extra = toRecord(connection?.extra)
  const model = extra?.model
  return typeof model === 'string' && model.trim() ? model.trim() : undefined
}

function normalizeModelRef(value: string | undefined | null, fallbackProviderId: string): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.includes('/')) return trimmed
  return `${fallbackProviderId}/${trimmed}`
}

function normalizeConnection(connection?: ProviderConnection): Omit<ResolvedProviderConfig, 'providerId'> {
  if (!connection) return {}

  const extra = toRecord(connection.extra)
  const options = toRecord(extra?.options)
  const explicitHeaders = toStringRecord(extra?.headers)
  const optionHeaders = toStringRecord(options?.headers)
  const mergedHeaders = {
    ...optionHeaders,
    ...explicitHeaders,
  }

  const normalizedOptions = {
    ...(options ?? {}),
    ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
  }

  const whitelist = toStringArray(extra?.whitelist)
  const blacklist = toStringArray(extra?.blacklist)
  const models = toModelOverrideMap(extra?.models)

  return {
    ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
    ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
    ...(connection.apiKeyMasked ? { apiKeyMasked: connection.apiKeyMasked } : {}),
    ...(Object.keys(normalizedOptions).length > 0 ? { options: normalizedOptions } : {}),
    ...(whitelist ? { whitelist } : {}),
    ...(blacklist ? { blacklist } : {}),
    ...(models ? { models } : {}),
  }
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function toStringRecord(value: unknown): Record<string, string> {
  const input = toRecord(value)
  if (!input) return {}
  return Object.fromEntries(
    Object.entries(input)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0),
  )
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return normalized.length > 0 ? normalized : undefined
}

function toModelOverrideMap(value: unknown): Record<string, ModelOverrideConfig> | undefined {
  const input = toRecord(value)
  if (!input) return undefined

  const pairs = Object.entries(input).flatMap(([modelId, raw]) => {
    if (typeof raw === 'string') {
      return [[modelId, { label: raw }]] as const
    }
    const record = toRecord(raw)
    if (!record) return [] as const
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    return [[modelId, label ? { label } : {}]] as const
  })

  if (pairs.length === 0) return undefined
  return Object.fromEntries(pairs)
}

function mergeObject(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!left && !right) return undefined
  return {
    ...(left ?? {}),
    ...(right ?? {}),
  }
}

function unique(values: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}
