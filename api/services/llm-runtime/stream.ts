import { generateText, Output, streamText } from 'ai'
import type { ZodType } from 'zod'
import type { GenerateTextResult } from 'ai'
import type { ModelMessage } from '@ai-sdk/provider-utils'
import { getGlobalConfigForRuntime, getProjectConfigForRuntime } from '../../lib/config/config-store.js'
import { instantiateProvider, selectLanguageModel } from './registry.js'
import { getRuntimeCatalog } from './catalog.js'
import { resolveLlmSelection, resolveProviderModelRef, resolveRuntimeProvider } from './resolver.js'
import type { LlmGatewayRequest, ResolvedModelSelection, ValidateLlmRequest } from './types.js'

export interface GatewayObjectResult<T> {
  object: T
  result: GenerateTextResult<any, any>
}

const JSON_OBJECT_RESPONSE_FORMAT_INSTRUCTION = 'Return only valid json that matches the requested schema.'

export async function resolveGatewaySelection(
  request: Pick<LlmGatewayRequest, 'projectId' | 'purpose' | 'model'>,
): Promise<ResolvedModelSelection> {
  const catalog = await getRuntimeCatalog()
  const globalConfig = getGlobalConfigForRuntime()
  return resolveLlmSelection({
    catalog,
    globalConfig,
    projectConfig: request.projectId ? getProjectConfigForRuntime(request.projectId) : null,
    purpose: request.purpose,
    modelOverride: request.model,
    useSmallModel: shouldUseSmallModel(request.purpose),
  })
}

export async function createGatewayStream(
  request: LlmGatewayRequest,
  abortSignal?: AbortSignal,
): Promise<any> {
  const selection = await resolveGatewaySelection(request)
  if (!hasConfiguredApiKey(selection.config, selection.provider.env)) {
    throw new Error(missingApiKeyMessage(selection.providerId, selection.provider.env))
  }
  const client = await instantiateProvider(selection.provider, selection.config)
  const model = selectLanguageModel(client, selection.modelId)

  const { system, messages } = toModelPrompt(request.messages)

  return streamText({
    model: model as any,
    system,
    messages,
    tools: request.tools as any,
    toolChoice: request.toolChoice as any,
    activeTools: request.activeTools as any,
    experimental_repairToolCall: request.repairToolCall as any,
    temperature: request.temperature,
    maxOutputTokens: request.maxTokens,
    stopSequences: request.stop,
    maxRetries: request.maxRetries,
    abortSignal,
  })
}

export async function generateGatewayTextResult(
  request: LlmGatewayRequest,
  abortSignal?: AbortSignal,
): Promise<GenerateTextResult<any, any>> {
  const selection = await resolveGatewaySelection(request)
  if (!hasConfiguredApiKey(selection.config, selection.provider.env)) {
    throw new Error(missingApiKeyMessage(selection.providerId, selection.provider.env))
  }
  const client = await instantiateProvider(selection.provider, selection.config)
  const model = selectLanguageModel(client, selection.modelId)

  const { system, messages } = toModelPrompt(request.messages)

  return generateText({
    model: model as any,
    system,
    messages,
    temperature: request.temperature,
    maxOutputTokens: request.maxTokens,
    stopSequences: request.stop,
    abortSignal,
  })
}

export async function validateGatewayModel(input: ValidateLlmRequest): Promise<{ ok: boolean; message?: string; error?: string }> {
  const parsed = resolveValidationTarget(input)
  const catalog = await getRuntimeCatalog()
  const globalConfig = getGlobalConfigForRuntime()
  const provider = resolveRuntimeProvider(parsed.providerId, {
    catalog,
    globalConfig,
    projectConfig: null,
    purpose: 'validate',
  })
  if (!provider) {
    return { ok: false, error: `Unknown provider: ${parsed.providerId}` }
  }
  if (!provider.supported) {
    return { ok: false, error: `Provider '${parsed.providerId}' is unsupported in Synapse runtime` }
  }

  try {
    const config = {
      providerId: parsed.providerId,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      options: input.options,
    }
    if (!hasConfiguredApiKey(config, provider.env)) {
      return { ok: false, error: missingApiKeyMessage(parsed.providerId, provider.env) }
    }
    const client = await instantiateProvider(provider, config)
    const model = selectLanguageModel(client, parsed.modelId)
    await generateText({
      model: model as any,
      messages: [{ role: 'user', content: 'ping' }] satisfies ModelMessage[],
      maxOutputTokens: 1,
    })
    return { ok: true, message: `${parsed.providerId}/${parsed.modelId} validated` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

const OFFICIAL_API_BASE_URLS = new Set([
  'https://api.anthropic.com/v1',
  'https://api.openai.com/v1',
])

function hasConfiguredApiKey(
  config: { apiKey?: string; baseUrl?: string; options?: Record<string, unknown> },
  envNames: string[] = [],
): boolean {
  if (config.apiKey?.trim()) return true
  const optionApiKey = config.options?.apiKey
  if (typeof optionApiKey === 'string' && optionApiKey.trim().length > 0) return true
  if (envNames.some((name) => Boolean(process.env[name]?.trim()))) return true
  // Custom baseUrl = user-managed endpoint; auth is their responsibility
  const baseUrl = config.baseUrl?.replace(/\/$/, '')
  if (baseUrl && !OFFICIAL_API_BASE_URLS.has(baseUrl)) return true
  return false
}

function missingApiKeyMessage(providerId: string, envNames: string[]): string {
  const envHint = envNames.length > 0 ? ` or set ${envNames.join(' or ')}` : ''
  return `Missing API key for provider '${providerId}'. Configure one in Synapse settings${envHint}.`
}

function toModelPrompt(messages: LlmGatewayRequest['messages']): { system?: string; messages: ModelMessage[] } {
  const systemMessages = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean)
  return {
    ...(systemMessages.length > 0 ? { system: systemMessages.join('\n\n') } : {}),
    messages: toModelMessages(messages.filter(isConversationMessage)),
  }
}

function isConversationMessage(message: LlmGatewayRequest['messages'][number]): message is LlmGatewayRequest['messages'][number] & { role: 'user' | 'assistant' | 'tool' } {
  return message.role !== 'system'
}

function toModelMessages(messages: Array<LlmGatewayRequest['messages'][number] & { role: 'user' | 'assistant' | 'tool' }>): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: message.content,
      } satisfies ModelMessage
    }
    if (message.role === 'user') {
      return {
        role: 'user',
        content: message.content,
      } satisfies ModelMessage
    }
    return {
      role: 'assistant',
      content: message.content,
    } satisfies ModelMessage
  })
}

export async function generateGatewayObjectResult<T>(
  request: LlmGatewayRequest,
  schema: ZodType<T>,
  abortSignal?: AbortSignal,
): Promise<GatewayObjectResult<T>> {
  const selection = await resolveGatewaySelection(request)
  if (!hasConfiguredApiKey(selection.config, selection.provider.env)) {
    throw new Error(missingApiKeyMessage(selection.providerId, selection.provider.env))
  }
  const client = await instantiateProvider(selection.provider, selection.config)
  const model = selectLanguageModel(client, selection.modelId, { structuredOutputs: true })

  const { system, messages } = toModelPrompt(ensureJsonObjectResponseFormatInstruction(request.messages))

  const result = await generateText({
    model: model as any,
    output: Output.object({ schema }),
    system,
    messages,
    temperature: request.temperature,
    maxOutputTokens: request.maxTokens,
    abortSignal,
  })

  return {
    object: result.output,
    result,
  }
}

export async function generateGatewayObject<T>(
  request: LlmGatewayRequest,
  schema: ZodType<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  const result = await generateGatewayObjectResult(request, schema, abortSignal)
  return result.object
}

export function ensureJsonObjectResponseFormatInstruction(
  messages: LlmGatewayRequest['messages'],
): LlmGatewayRequest['messages'] {
  if (messages.some((message) => contentContainsLowercaseJson(message.content))) {
    return messages
  }

  const lastSystemIndex = messages.findLastIndex((message) => message.role === 'system')
  if (lastSystemIndex >= 0) {
    return messages.map((message, index) => {
      if (index !== lastSystemIndex || message.role !== 'system') return message
      return {
        ...message,
        content: `${message.content.trim()}\n\n${JSON_OBJECT_RESPONSE_FORMAT_INSTRUCTION}`,
      }
    })
  }

  return [
    { role: 'system', content: JSON_OBJECT_RESPONSE_FORMAT_INSTRUCTION },
    ...messages,
  ]
}

function contentContainsLowercaseJson(value: unknown): boolean {
  if (typeof value === 'string') return /\bjson\b/.test(value)
  if (Array.isArray(value)) return value.some((item) => contentContainsLowercaseJson(item))
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => contentContainsLowercaseJson(item))
  }
  return false
}

function shouldUseSmallModel(purpose: string): boolean {
  return purpose === 'context-signal'
}

function resolveValidationTarget(input: ValidateLlmRequest): { providerId: string; modelId: string } {
  if (input.providerId) {
    return { providerId: input.providerId, modelId: input.model }
  }
  const parsed = resolveProviderModelRef(input.model)
  if (!parsed) {
    throw new Error('Validation requires either providerId + model, or model in provider/model format')
  }
  return parsed
}
