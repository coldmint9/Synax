import { logger } from '../../../lib/logger.js'
import type { ResolvedProviderConfig, RuntimeProvider } from '../types.js'
import { buildOpenAICompatibleClientSettings } from '../custom-api-compat.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProviderFactory = (options?: any) => unknown

const REGISTRY: Record<string, () => Promise<ProviderFactory>> = {
  '@ai-sdk/anthropic': async () => (await import('@ai-sdk/anthropic')).createAnthropic,
  '@ai-sdk/cerebras': async () => (await import('@ai-sdk/cerebras')).createCerebras,
  '@ai-sdk/cohere': async () => (await import('@ai-sdk/cohere')).createCohere,
  '@ai-sdk/deepinfra': async () => (await import('@ai-sdk/deepinfra')).createDeepInfra,
  '@ai-sdk/deepseek': async () => (await import('@ai-sdk/deepseek')).createDeepSeek,
  '@ai-sdk/google': async () => (await import('@ai-sdk/google')).createGoogleGenerativeAI,
  '@ai-sdk/groq': async () => (await import('@ai-sdk/groq')).createGroq,
  '@ai-sdk/mistral': async () => (await import('@ai-sdk/mistral')).createMistral,
  '@ai-sdk/openai': async () => (await import('@ai-sdk/openai')).createOpenAI,
  '@ai-sdk/openai-compatible': async () => (await import('@ai-sdk/openai-compatible')).createOpenAICompatible,
  '@ai-sdk/perplexity': async () => (await import('@ai-sdk/perplexity')).createPerplexity,
  '@ai-sdk/togetherai': async () => (await import('@ai-sdk/togetherai')).createTogetherAI,
  '@ai-sdk/xai': async () => (await import('@ai-sdk/xai')).createXai,
  '@openrouter/ai-sdk-provider': async () => (await import('@openrouter/ai-sdk-provider')).createOpenRouter,
}

const factoryCache = new Map<string, ProviderFactory>()

export function isProviderSupported(provider: Pick<RuntimeProvider, 'npm'>): boolean {
  return Boolean(provider.npm && REGISTRY[provider.npm])
}

export async function instantiateProvider(
  provider: Pick<RuntimeProvider, 'id' | 'label' | 'npm' | 'api'>,
  config: ResolvedProviderConfig,
): Promise<unknown> {
  if (!provider.npm || !REGISTRY[provider.npm]) {
    throw new Error(`Provider '${provider.id}' is unsupported in Synax runtime`)
  }

  const create = await getFactory(provider.npm)
  const headers = normalizeStringMap(config.options?.headers)
  const options = normalizeObject(config.options)
  const baseURL = config.baseUrl ?? provider.api

  if (provider.npm === '@ai-sdk/openai-compatible') {
    return create(buildOpenAICompatibleClientSettings(provider, config))
  }

  if (provider.npm === '@openrouter/ai-sdk-provider') {
    return create({
      baseURL,
      apiKey: config.apiKey,
      headers,
      ...options,
    })
  }

  return create({
    ...(baseURL ? { baseURL } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...options,
  })
}

export function selectLanguageModel(client: unknown, modelId: string, modelOptions?: Record<string, unknown>): unknown {
  if (!client) throw new Error('Provider client was not created')
  const c = client as Record<string, unknown>
  if (typeof client === 'function') return (client as Function)(modelId, modelOptions)
  if (typeof c.responses === 'function') return (c.responses as Function)(modelId, modelOptions)
  if (typeof c.messages === 'function') return (c.messages as Function)(modelId, modelOptions)
  if (typeof c.chat === 'function') return (c.chat as Function)(modelId, modelOptions)
  if (typeof c.languageModel === 'function') return (c.languageModel as Function)(modelId, modelOptions)
  logger.warn({ modelId }, '[llm-runtime] provider client has no language model selector')
  throw new Error(`Provider client cannot resolve model '${modelId}'`)
}

async function getFactory(npm: string): Promise<ProviderFactory> {
  const cached = factoryCache.get(npm)
  if (cached) return cached
  const loader = REGISTRY[npm]
  if (!loader) throw new Error(`No registry entry for '${npm}'`)
  const factory = await loader()
  factoryCache.set(npm, factory)
  return factory
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function normalizeStringMap(value: unknown): Record<string, string> {
  const input = normalizeObject(value)
  return Object.fromEntries(
    Object.entries(input)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0),
  )
}
