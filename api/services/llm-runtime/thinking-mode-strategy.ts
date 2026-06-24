import type { ThinkingMode } from '../agent-runtime/contracts.js'
import {
  buildOpenAICompatibleProviderOptions,
  isOpenAICompatibleProvider,
  mergeProviderOptions,
  resolveProviderOptionsNamespace,
} from './custom-api-compat.js'
import type { LlmGatewayRequest, ResolvedModelSelection } from './types.js'

export type ReasoningEffort = NonNullable<LlmGatewayRequest['reasoningEffort']>

/** Per-request LLM call overrides derived from a thinking-mode strategy. */
export interface ThinkingStreamOptions {
  providerOptions?: Record<string, Record<string, unknown>>
  temperature?: number
}

/** Minimal provider context used to pick a thinking-mode strategy. */
export interface ThinkingModeContext {
  providerId: string
  baseUrl?: string
  npm?: string
  /** Catalog / runtime model capability flag. */
  reasoning?: boolean
}

export interface ThinkingModeStrategy {
  readonly id: string
  matches(ctx: ThinkingModeContext): boolean
  /**
   * When set, official endpoints may use a native SDK instead of openai-compatible.
   * Custom/proxy base URLs stay on openai-compatible with providerOptions passthrough.
   */
  preferredAdapter?: {
    npm: string
    api: string
    env: string[]
    /** Only upgrade when base URL matches (official API). */
    officialBaseUrl?: string
  }
  defaultReasoningCapability: boolean
  buildStreamOptions(
    ctx: ThinkingModeContext,
    request: Pick<LlmGatewayRequest, 'reasoningEffort' | 'temperature'>,
    selection: ResolvedModelSelection,
  ): ThinkingStreamOptions
}

export function mapThinkingModeToReasoningEffort(
  mode: ThinkingMode | undefined,
): ReasoningEffort {
  return mode === 'deep' ? 'max' : 'high'
}

function hostIncludes(baseUrl: string | undefined, fragment: string): boolean {
  if (!baseUrl?.trim()) return false
  try {
    const host = new URL(baseUrl.replace(/\/$/, '')).hostname.toLowerCase()
    return host.includes(fragment.toLowerCase())
  } catch {
    return baseUrl.toLowerCase().includes(fragment.toLowerCase())
  }
}

function isOfficialDeepSeekBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return false
  try {
    const host = new URL(baseUrl.replace(/\/$/, '')).hostname.toLowerCase()
    return host === 'api.deepseek.com'
  } catch {
    return false
  }
}

function providerIdIncludes(providerId: string, fragment: string): boolean {
  return providerId.toLowerCase().includes(fragment.toLowerCase())
}

function toContext(selection: ResolvedModelSelection): ThinkingModeContext {
  return {
    providerId: selection.providerId,
    baseUrl: selection.config.baseUrl ?? selection.provider.api,
    npm: selection.provider.npm,
    reasoning: selection.modelDef.reasoning,
  }
}

function toContextFromConnection(
  providerId: string,
  baseUrl?: string,
): ThinkingModeContext {
  return { providerId, baseUrl }
}

function buildDeepSeekThinkingOptions(
  selection: ResolvedModelSelection,
  effort: ReasoningEffort,
): ThinkingStreamOptions {
  // Native @ai-sdk/deepseek — providerOptions.deepseek (camelCase reasoningEffort)
  if (selection.provider.npm === '@ai-sdk/deepseek') {
    return {
      providerOptions: {
        deepseek: {
          thinking: { type: 'enabled' },
          reasoningEffort: effort,
        },
      },
      temperature: undefined,
    }
  }

  // AI SDK v6 openai-compatible — providerOptions[providerId] merges into request body
  const namespace = resolveProviderOptionsNamespace(selection)
  return {
    providerOptions: mergeProviderOptions(
      buildOpenAICompatibleProviderOptions(namespace, {
        thinking: { type: 'enabled' },
        reasoning_effort: effort,
      }),
      {
        openaiCompatible: {
          reasoningEffort: effort,
        },
      },
    ),
    temperature: undefined,
  }
}

const deepSeekThinkingStrategy: ThinkingModeStrategy = {
  id: 'deepseek',
  preferredAdapter: {
    npm: '@ai-sdk/deepseek',
    api: 'https://api.deepseek.com',
    env: ['DEEPSEEK_API_KEY'],
    officialBaseUrl: 'https://api.deepseek.com',
  },
  defaultReasoningCapability: true,
  matches(ctx) {
    return ctx.npm === '@ai-sdk/deepseek'
      || hostIncludes(ctx.baseUrl, 'deepseek.com')
      || providerIdIncludes(ctx.providerId, 'deepseek')
  },
  buildStreamOptions(_ctx, request, selection) {
    const effort = request.reasoningEffort ?? 'high'
    return buildDeepSeekThinkingOptions(selection, effort)
  },
}

const nativeReasoningModelStrategy: ThinkingModeStrategy = {
  id: 'native-reasoning-model',
  defaultReasoningCapability: true,
  matches(ctx) {
    if (!ctx.reasoning) return false
    if (deepSeekThinkingStrategy.matches(ctx)) return false
    return ctx.npm === '@ai-sdk/google'
      || ctx.npm === '@ai-sdk/anthropic'
      || ctx.npm === '@ai-sdk/openai'
      || ctx.npm === '@ai-sdk/xai'
  },
  buildStreamOptions(_ctx, request, selection) {
    const namespace = resolveProviderOptionsNamespace(selection)
    const effort = request.reasoningEffort
    if (effort && isOpenAICompatibleProvider(selection.provider.npm)) {
      return {
        providerOptions: mergeProviderOptions(
          buildOpenAICompatibleProviderOptions(namespace, {
            reasoning_effort: effort,
          }),
          { openaiCompatible: { reasoningEffort: effort } },
        ),
        temperature: request.temperature,
      }
    }
    return { temperature: request.temperature }
  },
}

const THINKING_MODE_STRATEGIES: ThinkingModeStrategy[] = [
  deepSeekThinkingStrategy,
  nativeReasoningModelStrategy,
]

export function resolveThinkingModeStrategy(
  ctx: ThinkingModeContext,
): ThinkingModeStrategy | null {
  return THINKING_MODE_STRATEGIES.find(strategy => strategy.matches(ctx)) ?? null
}

export function buildThinkingStreamOptions(
  selection: ResolvedModelSelection,
  request: Pick<LlmGatewayRequest, 'reasoningEffort' | 'temperature'>,
): ThinkingStreamOptions {
  const strategy = resolveThinkingModeStrategy(toContext(selection))
  if (!strategy) {
    return { temperature: request.temperature }
  }
  return strategy.buildStreamOptions(toContext(selection), request, selection)
}

/**
 * Prefer native SDK only for official API endpoints; custom/proxy URLs keep
 * openai-compatible with providerOptions passthrough (AI SDK v6).
 */
export function resolvePreferredProviderAdapter(input: {
  providerId: string
  baseUrl?: string
}): ThinkingModeStrategy['preferredAdapter'] | undefined {
  const strategy = resolveThinkingModeStrategy(toContextFromConnection(input.providerId, input.baseUrl))
  const adapter = strategy?.preferredAdapter
  if (!adapter) return undefined
  if (adapter.officialBaseUrl && !isOfficialDeepSeekBaseUrl(input.baseUrl)) {
    return undefined
  }
  return adapter
}

export function inferReasoningCapability(ctx: ThinkingModeContext): boolean {
  if (ctx.reasoning) return true
  const strategy = resolveThinkingModeStrategy(ctx)
  return strategy?.defaultReasoningCapability ?? false
}

/** @deprecated Use resolveThinkingModeStrategy. */
export function isDeepSeekHost(baseUrl?: string): boolean {
  return deepSeekThinkingStrategy.matches({ providerId: '', baseUrl })
}

/** @deprecated Use resolveThinkingModeStrategy. */
export function isDeepSeekProviderId(providerId: string): boolean {
  return deepSeekThinkingStrategy.matches({ providerId })
}

/** @deprecated Use resolveThinkingModeStrategy(toContext(selection)). */
export function isDeepSeekSelection(selection: ResolvedModelSelection): boolean {
  return deepSeekThinkingStrategy.matches(toContext(selection))
}
