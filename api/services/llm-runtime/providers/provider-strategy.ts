import type { RuntimeModel } from '../types.js'

export interface ProviderStrategy {
  needsReasoningMiddleware(model: RuntimeModel): boolean
  modelOptions(mode: { kind: string }): Record<string, unknown> | undefined
}

const defaultStrategy: ProviderStrategy = {
  needsReasoningMiddleware: (model) => Boolean(model.reasoning),
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
}

/** Prompt caching is resolved by the capability matrix in `../chat-cache.js`
 * and the Anthropic marker policy in `../cache-policy.js`, not per adapter. */

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
