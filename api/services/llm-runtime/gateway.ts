import type { GenerateTextResult, Output } from 'ai'
import { generateText } from 'ai'
import type { ModelMessage } from '@ai-sdk/provider-utils'
import type { ZodType } from 'zod'
import { getGlobalConfigForRuntime, getProjectConfigForRuntime } from '../../lib/config/config-store.js'
import { getRuntimeCatalog } from './catalog.js'
import { resolveLlmSelection, resolveProviderModelRef, resolveRuntimeProvider } from './resolver.js'
import type { LlmGatewayRequest, ResolvedModelSelection, ValidateLlmRequest } from './types.js'
import { executePipeline, hasConfiguredApiKey, missingApiKeyMessage } from './pipeline.js'
import type { ExecutionMode } from './pipeline.js'
import { withRetry } from './middleware/retry.js'
import { withRateLimit, withStreamRateLimit } from './middleware/rate-limiter.js'
import { instantiateProvider, selectLanguageModel } from './providers/provider-registry.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGenerateTextResult = GenerateTextResult<any, any>

export interface GatewayObjectResult<T> {
  object: T
  result: AnyGenerateTextResult
}

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
    // Latency-sensitive purposes route to the fast/small model tier.
    useSmallModel: request.purpose === 'context-signal',
  })
}

export async function createGatewayStream(
  request: LlmGatewayRequest,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  const selection = await resolveGatewaySelection(request)
  return withRetry(() => withStreamRateLimit(selection.providerId, selection.modelId, request.maxTokens ?? 4096, () => executePipeline(request, selection, {
    kind: 'stream',
    tools: request.tools,
    toolChoice: request.toolChoice,
    activeTools: request.activeTools,
    repairToolCall: request.repairToolCall,
    maxRetries: request.maxRetries,
  }, abortSignal)))
}

export async function generateGatewayTextResult(
  request: LlmGatewayRequest,
  abortSignal?: AbortSignal,
): Promise<AnyGenerateTextResult> {
  const selection = await resolveGatewaySelection(request)
  return withRetry(() => withRateLimit(selection.providerId, selection.modelId, request.maxTokens ?? 4096, () => executePipeline(request, selection, { kind: 'text' }, abortSignal))) as Promise<AnyGenerateTextResult>
}

export async function generateGatewayObjectResult<T>(
  request: LlmGatewayRequest,
  schema: ZodType<T>,
  abortSignal?: AbortSignal,
): Promise<GatewayObjectResult<T>> {
  const selection = await resolveGatewaySelection(request)
  const result = await withRetry(() => withRateLimit(selection.providerId, selection.modelId, request.maxTokens ?? 4096, () => executePipeline(request, selection, { kind: 'object', schema }, abortSignal))) as AnyGenerateTextResult
  return {
    object: (result as unknown as { output: T }).output,
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
    return { ok: false, error: `Provider '${parsed.providerId}' is unsupported in Synax runtime` }
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
      model: model as Parameters<typeof generateText>[0]['model'],
      messages: [{ role: 'user', content: 'ping' }] satisfies ModelMessage[],
      maxOutputTokens: 1,
    })
    return { ok: true, message: `${parsed.providerId}/${parsed.modelId} validated` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
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
