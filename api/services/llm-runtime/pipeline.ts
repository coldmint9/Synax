import { generateText, Output, streamText } from 'ai'
import type { GenerateTextResult, ToolSet, ToolChoice, ToolCallRepairFunction } from 'ai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import type { ModelMessage, SystemModelMessage } from '@ai-sdk/provider-utils'
import type { ZodType } from 'zod'
import type { LlmGatewayRequest, ResolvedModelSelection } from './types.js'
import { getOrCreateClient } from './providers/provider-cache.js'
import { selectLanguageModel } from './providers/provider-registry.js'
import { getStrategy } from './providers/provider-strategy.js'
import { applyReasoningMiddleware } from './middleware/reasoning.js'
import { buildHookCallbacks } from './middleware/hook-callbacks.js'
import { toModelPrompt, ensureJsonObjectResponseFormatInstruction } from './prompt.js'

export type ExecutionMode =
  | {
      kind: 'stream'
      tools?: ToolSet
      toolChoice?: ToolChoice<ToolSet>
      activeTools?: string[]
      repairToolCall?: ToolCallRepairFunction<ToolSet>
      maxRetries?: number
    }
  | { kind: 'text' }
  | { kind: 'object'; schema: ZodType<unknown> }

const OFFICIAL_API_BASE_URLS = new Set([
  'https://api.anthropic.com/v1',
  'https://api.openai.com/v1',
])

export function hasConfiguredApiKey(
  config: { apiKey?: string; baseUrl?: string; options?: Record<string, unknown> },
  envNames: string[] = [],
): boolean {
  if (config.apiKey?.trim()) return true
  const optionApiKey = config.options?.apiKey
  if (typeof optionApiKey === 'string' && optionApiKey.trim().length > 0) return true
  if (envNames.some((name) => Boolean(process.env[name]?.trim()))) return true
  const baseUrl = config.baseUrl?.replace(/\/$/, '')
  if (baseUrl && !OFFICIAL_API_BASE_URLS.has(baseUrl)) return true
  return false
}

export function missingApiKeyMessage(providerId: string, envNames: string[]): string {
  const envHint = envNames.length > 0 ? ` or set ${envNames.join(' or ')}` : ''
  return `Missing API key for provider '${providerId}'. Configure one in Synapse settings${envHint}.`
}

function assertApiKey(selection: ResolvedModelSelection): void {
  if (!hasConfiguredApiKey(selection.config, selection.provider.env)) {
    throw new Error(missingApiKeyMessage(selection.providerId, selection.provider.env))
  }
}

export async function executePipeline(
  request: LlmGatewayRequest,
  selection: ResolvedModelSelection,
  mode: ExecutionMode,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  assertApiKey(selection)

  const client = await getOrCreateClient(selection)
  const strategy = getStrategy(selection.provider.npm)
  const modelOptions = strategy.modelOptions(mode)
  let model = selectLanguageModel(client, selection.modelId, modelOptions) as LanguageModelV3

  if (strategy.needsReasoningMiddleware(selection.modelDef)) {
    model = applyReasoningMiddleware(model)
  }

  const enableCache = strategy.supportsCacheControl(selection) && request.cacheControl
  const callbacks = buildHookCallbacks(request)

  switch (mode.kind) {
    case 'stream':
      return dispatchStream(model, request, mode, callbacks, enableCache, abortSignal)
    case 'text':
      return dispatchText(model, request, callbacks, enableCache, abortSignal)
    case 'object':
      return dispatchObject(model, request, mode.schema, callbacks, abortSignal)
  }
}

function dispatchStream(
  model: LanguageModelV3,
  request: LlmGatewayRequest,
  mode: Extract<ExecutionMode, { kind: 'stream' }>,
  callbacks: ReturnType<typeof buildHookCallbacks>,
  enableCache: boolean | undefined,
  abortSignal?: AbortSignal,
) {
  const { system, messages } = toModelPrompt(request.messages, enableCache)
  return streamText({
    model,
    system,
    messages,
    tools: mode.tools,
    toolChoice: mode.toolChoice,
    activeTools: mode.activeTools,
    experimental_repairToolCall: mode.repairToolCall,
    temperature: request.temperature,
    maxOutputTokens: request.maxTokens,
    stopSequences: request.stop,
    maxRetries: mode.maxRetries,
    abortSignal,
    ...callbacks,
  })
}

function dispatchText(
  model: LanguageModelV3,
  request: LlmGatewayRequest,
  callbacks: ReturnType<typeof buildHookCallbacks>,
  enableCache: boolean | undefined,
  abortSignal?: AbortSignal,
) {
  const { system, messages } = toModelPrompt(request.messages, enableCache)
  return generateText({
    model,
    system,
    messages,
    temperature: request.temperature,
    maxOutputTokens: request.maxTokens,
    stopSequences: request.stop,
    abortSignal,
    ...callbacks,
  })
}

function dispatchObject(
  model: LanguageModelV3,
  request: LlmGatewayRequest,
  schema: ZodType<unknown>,
  callbacks: ReturnType<typeof buildHookCallbacks>,
  abortSignal?: AbortSignal,
) {
  const { system, messages } = toModelPrompt(ensureJsonObjectResponseFormatInstruction(request.messages))
  return generateText({
    model,
    output: Output.object({ schema }),
    system,
    messages,
    temperature: request.temperature,
    maxOutputTokens: request.maxTokens,
    abortSignal,
    ...callbacks,
  })
}
