import type { ResolvedModelSelection, RuntimeModel } from '../types.js'
import { resolvePromptCaching } from '../cache-policy.js'

export interface ProviderStrategy {
  needsReasoningMiddleware(model: RuntimeModel): boolean
  supportsCacheControl(selection: ResolvedModelSelection): boolean
  modelOptions(mode: { kind: string }): Record<string, unknown> | undefined
}

const defaultStrategy: ProviderStrategy = {
  needsReasoningMiddleware: (model) => Boolean(model.reasoning),
  supportsCacheControl: (selection) => {
    resolvePromptCaching(selection.config.options?.promptCaching)
    return false
  },
  modelOptions: () => undefined,
}

/** OpenAI-compatible chat APIs need structuredOutputs (not responseFormat) for Output.object(). */
function objectModeModelOptions(mode: { kind: string }): Record<string, unknown> | undefined {
  return mode.kind === 'object' ? { structuredOutputs: true } : undefined
}

const nativeReasoningStrategy: ProviderStrategy = {
  ...defaultStrategy,
  needsReasoningMiddleware: () => false,
}

const anthropicStrategy: ProviderStrategy = {
  ...nativeReasoningStrategy,
  supportsCacheControl: (sel) => {
    const policy = resolvePromptCaching(sel.config.options?.promptCaching)
    return policy !== 'off' && sel.apiFormat === 'anthropic' && sel.provider.npm === '@ai-sdk/anthropic'
  },
}

const openaiStrategy: ProviderStrategy = {
  ...nativeReasoningStrategy,
  modelOptions: objectModeModelOptions,
}

const openaiCompatibleStrategy: ProviderStrategy = {
  ...nativeReasoningStrategy,
  modelOptions: objectModeModelOptions,
}

/** Native DeepSeek SDK parses reasoning_content; thinking is enabled via providerOptions. */
const deepseekStrategy: ProviderStrategy = {
  ...nativeReasoningStrategy,
  modelOptions: objectModeModelOptions,
}

const strategies = new Map<string, ProviderStrategy>([
  ['@ai-sdk/anthropic', anthropicStrategy],
  ['@ai-sdk/openai', openaiStrategy],
  ['@ai-sdk/openai-compatible', openaiCompatibleStrategy],
  ['@ai-sdk/deepseek', deepseekStrategy],
  ['@ai-sdk/google', nativeReasoningStrategy],
  ['@ai-sdk/xai', nativeReasoningStrategy],
  ['@ai-sdk/groq', openaiCompatibleStrategy],
])

export function getStrategy(npm: string | undefined): ProviderStrategy {
  if (!npm) return defaultStrategy
  return strategies.get(npm) ?? defaultStrategy
}
