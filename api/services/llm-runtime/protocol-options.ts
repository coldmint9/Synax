import type { JSONValue, JSONObject, SharedV3ProviderOptions } from '@ai-sdk/provider'
import type { LlmGatewayRequest, ResolvedModelSelection } from './types.js'

const RESPONSE_OPTION_KEYS = [
  'conversation',
  'include',
  'instructions',
  'metadata',
  'maxToolCalls',
  'parallelToolCalls',
  'previousResponseId',
  'promptCacheKey',
  'promptCacheRetention',
  'reasoningSummary',
  'forceReasoning',
  'serviceTier',
  'store',
  'truncation',
] as const

/**
 * Build provider-native options for the selected wire protocol.
 *
 * Responses options intentionally do not go through the openai-compatible
 * passthrough namespace. That namespace is for Chat Completions body fields;
 * using it for Responses would silently drop or misname native controls.
 */
export function buildProtocolProviderOptions(
  selection: ResolvedModelSelection,
  request: Pick<LlmGatewayRequest, 'reasoningEffort' | 'responseOptions'>,
): SharedV3ProviderOptions | undefined {
  if (selection.apiFormat !== 'openai-responses') return undefined

  const options = request.responseOptions
  const openai: JSONObject = {}
  if (request.reasoningEffort) openai.reasoningEffort = request.reasoningEffort
  if (options?.forceReasoning ?? selection.modelDef.reasoning) {
    openai.forceReasoning = true
  }

  if (options) {
    for (const key of RESPONSE_OPTION_KEYS) {
      const value = options[key] as JSONValue | undefined
      if (value !== undefined) openai[key] = value
    }
  }

  return Object.keys(openai).length > 0 ? { openai } : undefined
}
