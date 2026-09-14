import type { ApiFormat, ProviderConnection, ProviderDef } from '../../lib/config/config-types.js'
import { isProviderSupported } from './providers/provider-registry.js'
import { inferReasoningCapability, resolvePreferredProviderAdapter } from './thinking-mode-strategy.js'
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

  throw new Error('No LLM provider configured. Please configure one in Settings.')
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
    apiFormat: resolveProviderApiFormat({
      providerId: parsed.providerId,
      apiFormat: config.apiFormat,
      modelId: parsed.modelId,
      modelReasoning: modelDef.reasoning,
    }),
    provider,
    modelDef,
    config,
  }
}

/**
 * Resolve the wire protocol for a provider connection.
 * Explicit `extra.apiFormat` wins. OpenAI reasoning/GPT-5 class models use
 * Responses by default; older/general OpenAI-compatible models retain Chat
 * Completions unless the connection explicitly opts into Responses.
 */
export function resolveProviderApiFormat(input: {
  providerId?: string
  connection?: ProviderConnection | null
  apiFormat?: unknown
  modelId?: string
  modelReasoning?: boolean
}): ApiFormat {
  const format = input.apiFormat ?? toRecord(input.connection?.extra)?.apiFormat
  if (format === 'anthropic' || format === 'openai-responses' || format === 'openai') {
    return format
  }
  if (input.providerId === 'openai' && isResponsesFirstModel(input.modelId, input.modelReasoning)) {
    return 'openai-responses'
  }
  return input.providerId === 'anthropic' ? 'anthropic' : 'openai'
}

function isResponsesFirstModel(modelId?: string, reasoning?: boolean): boolean {
  if (reasoning) return true
  if (!modelId) return false
  return /^(?:gpt-5(?:[.-]|$)|o1(?:[.-]|$)|o3(?:[.-]|$)|o4(?:[.-]|$))/i.test(modelId)
}

function findModel(provider: RuntimeProvider, modelId: string, config: ResolvedProviderConfig): RuntimeModel | null {
  const fromCatalog = provider.models.find((model) => model.id === modelId)
  if (fromCatalog) return fromCatalog
  const override = config.models?.[modelId]
  if (!override) return null
  const reasoningCapable = inferReasoningCapability({ providerId: provider.id, baseUrl: config.baseUrl })
  return {
    id: modelId,
    label: override.label || modelId,
    ...(reasoningCapable ? { reasoning: true, toolCall: true } : {}),
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
  const apiFormat = resolveProviderApiFormat({ providerId, connection })

  if (apiFormat === 'anthropic') {
    return {
      npm: '@ai-sdk/anthropic',
      api: connection?.baseUrl ?? (providerId === 'anthropic' ? 'https://api.anthropic.com/v1' : undefined),
      env: providerId === 'anthropic' ? ['ANTHROPIC_API_KEY'] : [],
    }
  }

  // The Responses protocol needs the native OpenAI provider: `@ai-sdk/openai-compatible`
  // only speaks Chat Completions, while `@ai-sdk/openai` exposes `.responses()` and
  // still honours baseURL/apiKey/header overrides for proxies and gateways.
  if (apiFormat === 'openai-responses' || providerId === 'openai') {
    return {
      npm: '@ai-sdk/openai',
      api: connection?.baseUrl ?? 'https://api.openai.com/v1',
      env: providerId === 'openai' ? ['OPENAI_API_KEY'] : [],
    }
  }

  const preferredAdapter = resolvePreferredProviderAdapter({
    providerId,
    baseUrl: connection?.baseUrl,
  })
  if (preferredAdapter) {
    return {
      npm: preferredAdapter.npm,
      api: connection?.baseUrl ?? preferredAdapter.api,
      env: preferredAdapter.env,
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
  const reasoningCapable = inferReasoningCapability({ providerId: provider.id, baseUrl: connection?.baseUrl })
  const baseModels = provider.models.map((model) => ({
    id: model.id,
    label: model.label,
    isDefault: model.isDefault,
    maxTokens: model.maxTokens,
    ...(typeof model.contextLimit === 'number' ? { contextLimit: model.contextLimit } : {}),
    ...(reasoningCapable ? { reasoning: true, toolCall: true } : {}),
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
      ...(reasoningCapable ? { reasoning: true, toolCall: true } : {}),
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
  // Only an explicitly stored protocol is carried here: the provider-id default is applied later.
  const storedApiFormat = extra?.apiFormat
  const apiFormat: ApiFormat | undefined =
    storedApiFormat === 'openai' || storedApiFormat === 'openai-responses' || storedApiFormat === 'anthropic'
      ? storedApiFormat
      : undefined

  return {
    ...(apiFormat ? { apiFormat } : {}),
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
