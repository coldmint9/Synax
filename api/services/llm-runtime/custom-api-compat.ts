import type { ResolvedModelSelection, ResolvedProviderConfig, RuntimeProvider } from './types.js'

/**
 * AI SDK v6 openai-compatible integration for Synax `custom-api:*` providers.
 *
 * @see https://github.com/vercel/ai/blob/main/content/providers/02-openai-compatible-providers/index.mdx
 * Provider-specific request fields must use `providerOptions[provider.name]` where
 * `name` matches `createOpenAICompatible({ name })`.
 */

/** Native AI SDK packages use fixed providerOptions namespaces. */
const NATIVE_PROVIDER_OPTIONS_KEYS: Record<string, string> = {
  '@ai-sdk/deepseek': 'deepseek',
  '@ai-sdk/google': 'google',
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/openai': 'openai',
  '@ai-sdk/xai': 'xai',
  '@ai-sdk/groq': 'groq',
  '@ai-sdk/mistral': 'mistral',
  '@ai-sdk/perplexity': 'perplexity',
  '@ai-sdk/cohere': 'cohere',
}

export function normalizeProviderBaseUrl(
  baseUrl: string | undefined,
  fallback = 'https://api.openai.com/v1',
): string {
  return (baseUrl?.trim() || fallback).replace(/\/+$/, '')
}

/** Must match `createOpenAICompatible({ name })` — we use Synax provider id. */
export function resolveOpenAICompatibleProviderName(providerId: string): string {
  return providerId
}

/**
 * Resolve the `providerOptions` key for a resolved model selection.
 * - openai-compatible: provider id (e.g. `custom-api:deepseek`)
 * - native SDK: package-specific key (e.g. `deepseek`)
 */
export function resolveProviderOptionsNamespace(selection: ResolvedModelSelection): string {
  if (selection.provider.npm === '@ai-sdk/openai-compatible') {
    return selection.providerId
  }
  return NATIVE_PROVIDER_OPTIONS_KEYS[selection.provider.npm ?? ''] ?? selection.providerId
}

export function isOpenAICompatibleProvider(npm: string | undefined): boolean {
  return npm === '@ai-sdk/openai-compatible'
}

export function buildOpenAICompatibleClientSettings(
  provider: Pick<RuntimeProvider, 'id' | 'api'>,
  config: ResolvedProviderConfig,
): {
  name: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  includeUsage: boolean
  supportsStructuredOutputs?: boolean
  queryParams?: Record<string, string>
} {
  const options = config.options ?? {}
  const headers = readStringRecord(options.headers)
  const queryParams = readStringRecord(options.queryParams)

  return {
    name: resolveOpenAICompatibleProviderName(provider.id),
    baseURL: normalizeProviderBaseUrl(config.baseUrl, provider.api ?? 'https://api.openai.com/v1'),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    includeUsage: options.includeUsage !== false,
    ...(options.supportsStructuredOutputs === true
      ? { supportsStructuredOutputs: true }
      : {}),
    ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
  }
}

/** Merge providerOptions layers (later wins per key). */
export function mergeProviderOptions(
  ...layers: Array<Record<string, Record<string, unknown>> | undefined>
): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const [namespace, values] of Object.entries(layer)) {
      if (!values || typeof values !== 'object') continue
      merged[namespace] = {
        ...(merged[namespace] ?? {}),
        ...values,
      }
    }
  }
  return merged
}

/**
 * Build providerOptions for openai-compatible custom APIs.
 * Unknown keys are merged into the HTTP body by @ai-sdk/openai-compatible.
 */
export function buildOpenAICompatibleProviderOptions(
  namespace: string,
  bodyFields: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  return { [namespace]: bodyFields }
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].trim().length > 0,
      ),
  )
}
