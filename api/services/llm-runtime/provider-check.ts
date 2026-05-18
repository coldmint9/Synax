import { getGlobalConfigForRuntime, getProjectConfigForRuntime } from '../../lib/config/config-store.js'
import { logger } from '../../lib/logger.js'
import { AgentProviderNotConfiguredError } from '../agent-runtime/runtime-errors.js'

const OFFICIAL_API_BASE_URLS = new Set([
  'https://api.anthropic.com/v1',
  'https://api.openai.com/v1',
])

export function assertLlmProviderConfigured(projectId?: string | null): void {
  const globalConfig = getGlobalConfigForRuntime()
  const apiProviders = globalConfig.providers.filter((p) => p.kind === 'api')

  if (apiProviders.length === 0) {
    logger.warn('[llm-provider-check] No API providers defined in global config')
    throw new AgentProviderNotConfiguredError()
  }

  const projectConfig = projectId ? getProjectConfigForRuntime(projectId) : null
  const candidateIds = new Set<string>()

  if (projectConfig?.providerId) {
    candidateIds.add(projectConfig.providerId)
  }
  if (globalConfig.defaultApiProviderId) {
    candidateIds.add(globalConfig.defaultApiProviderId)
  }
  for (const p of apiProviders) {
    candidateIds.add(p.id)
  }

  for (const providerId of candidateIds) {
    const connection = globalConfig.providerConnections[providerId]
    const projectConnection = projectConfig?.providerConnection
    const merged = projectConnection?.providerId === providerId
      ? { ...connection, ...projectConnection }
      : connection

    if (hasUsableCredentials(merged, providerId)) {
      return
    }
  }

  logger.warn(
    { candidateProviderIds: [...candidateIds] },
    '[llm-provider-check] No configured provider has a usable API key or custom endpoint',
  )
  throw new AgentProviderNotConfiguredError()
}

function hasUsableCredentials(
  connection: { apiKey?: string; baseUrl?: string; extra?: Record<string, unknown> } | undefined,
  providerId: string,
): boolean {
  if (!connection) {
    return hasEnvKey(providerId)
  }
  if (connection.apiKey?.trim()) return true
  const extra = connection.extra as Record<string, unknown> | undefined
  const options = extra?.options as Record<string, unknown> | undefined
  if (typeof options?.apiKey === 'string' && options.apiKey.trim()) return true
  if (hasEnvKey(providerId)) return true
  const baseUrl = connection.baseUrl?.replace(/\/$/, '')
  if (baseUrl && !OFFICIAL_API_BASE_URLS.has(baseUrl)) return true
  return false
}

function hasEnvKey(providerId: string): boolean {
  const envMap: Record<string, string[]> = {
    anthropic: ['ANTHROPIC_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    google: ['GOOGLE_GENERATIVE_AI_API_KEY'],
    groq: ['GROQ_API_KEY'],
    mistral: ['MISTRAL_API_KEY'],
    xai: ['XAI_API_KEY'],
    perplexity: ['PERPLEXITY_API_KEY'],
    togetherai: ['TOGETHER_AI_API_KEY'],
    cohere: ['COHERE_API_KEY'],
    deepinfra: ['DEEPINFRA_API_KEY'],
  }
  const envNames = envMap[providerId] ?? []
  return envNames.some((name) => Boolean(process.env[name]?.trim()))
}
