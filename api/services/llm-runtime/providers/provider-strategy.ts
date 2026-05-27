import type { ResolvedModelSelection, RuntimeModel } from '../types.js'

export interface ProviderStrategy {
  needsReasoningMiddleware(model: RuntimeModel): boolean
  supportsCacheControl(selection: ResolvedModelSelection): boolean
  modelOptions(mode: { kind: string }): Record<string, unknown> | undefined
}

const defaultStrategy: ProviderStrategy = {
  needsReasoningMiddleware: (model) => Boolean(model.reasoning),
  supportsCacheControl: () => false,
  modelOptions: () => undefined,
}

const nativeReasoningStrategy: ProviderStrategy = {
  ...defaultStrategy,
  needsReasoningMiddleware: () => false,
}

const anthropicStrategy: ProviderStrategy = {
  ...nativeReasoningStrategy,
  supportsCacheControl: (sel) => {
    if (sel.providerId === 'anthropic') return true
    return (sel.config.baseUrl ?? sel.provider.api ?? '').includes('anthropic.com')
  },
}

const openaiStrategy: ProviderStrategy = {
  ...nativeReasoningStrategy,
  modelOptions: (mode) => mode.kind === 'object' ? { structuredOutputs: true } : undefined,
}

const strategies = new Map<string, ProviderStrategy>([
  ['@ai-sdk/anthropic', anthropicStrategy],
  ['@ai-sdk/openai', openaiStrategy],
  ['@ai-sdk/deepseek', nativeReasoningStrategy],
  ['@ai-sdk/google', nativeReasoningStrategy],
  ['@ai-sdk/xai', nativeReasoningStrategy],
  ['@ai-sdk/groq', nativeReasoningStrategy],
  ['@ai-sdk/openai-compatible', nativeReasoningStrategy],
])

export function getStrategy(npm: string | undefined): ProviderStrategy {
  if (!npm) return defaultStrategy
  return strategies.get(npm) ?? defaultStrategy
}
