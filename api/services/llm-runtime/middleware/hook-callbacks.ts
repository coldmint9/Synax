import type { GenerateTextEndEvent, GenerateTextStartEvent, GenerateTextStepEndEvent, GenerateTextStepStartEvent, ToolExecutionEndEvent, ToolExecutionStartEvent, ToolSet } from 'ai'
import type { LlmGatewayRequest } from '../types.js'
import { llmHooks } from '../llm-hooks.js'

function normalizeUsage(usage: unknown): { promptTokens?: number; completionTokens?: number; totalTokens?: number; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cachedInputTokens?: number } | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const inputDetails = u.inputTokenDetails as Record<string, unknown> | undefined
  const outputDetails = u.outputTokenDetails as Record<string, unknown> | undefined
  const inputTokens = typeof u.inputTokens === 'number'
    ? u.inputTokens
    : typeof u.promptTokens === 'number' ? u.promptTokens : undefined
  const outputTokens = typeof u.outputTokens === 'number'
    ? u.outputTokens
    : typeof u.completionTokens === 'number' ? u.completionTokens : undefined
  return {
    promptTokens: typeof u.promptTokens === 'number' ? u.promptTokens : inputTokens,
    completionTokens: typeof u.completionTokens === 'number' ? u.completionTokens : outputTokens,
    totalTokens: typeof u.totalTokens === 'number' ? u.totalTokens : undefined,
    inputTokens: typeof inputTokens === 'number' ? inputTokens : undefined,
    outputTokens: typeof outputTokens === 'number' ? outputTokens : undefined,
    reasoningTokens: typeof outputDetails?.reasoningTokens === 'number' ? outputDetails.reasoningTokens : typeof u.reasoningTokens === 'number' ? u.reasoningTokens : undefined,
    cachedInputTokens: typeof inputDetails?.cacheReadTokens === 'number' ? inputDetails.cacheReadTokens : typeof u.cachedInputTokens === 'number' ? u.cachedInputTokens : undefined,
  }
}

export function buildHookCallbacks(request: LlmGatewayRequest) {
  const ctx = request.hookContext
  const genStart = Date.now()
  let stepNumber: number | undefined

  return {
    onStart: (event: GenerateTextStartEvent<ToolSet>) => {
      llmHooks.emit({ type: 'generation:start', modelId: event.modelId, provider: event.provider, purpose: request.purpose, context: ctx })
    },
    onStepStart: (event: GenerateTextStepStartEvent<ToolSet>) => {
      stepNumber = event.stepNumber
      llmHooks.emit({ type: 'step:start', stepNumber: event.stepNumber, modelId: event.modelId, provider: event.provider, purpose: request.purpose, context: ctx })
    },
    onToolExecutionStart: (event: ToolExecutionStartEvent<ToolSet>) => {
      llmHooks.emit({ type: 'tool_call:start', toolName: event.toolCall.toolName, toolCallId: event.toolCall.toolCallId, stepNumber, context: ctx })
    },
    onToolExecutionEnd: (event: ToolExecutionEndEvent<ToolSet>) => {
      llmHooks.emit({ type: 'tool_call:end', toolName: event.toolCall.toolName, toolCallId: event.toolCall.toolCallId, durationMs: event.toolExecutionMs, success: event.toolOutput.type === 'tool-result', error: event.toolOutput.type === 'tool-error' ? String(event.toolOutput.error) : undefined, context: ctx })
    },
    onStepEnd: (event: GenerateTextStepEndEvent<ToolSet>) => {
      llmHooks.emit({ type: 'step:finish', stepNumber: event.stepNumber, finishReason: event.finishReason ?? 'unknown', usage: normalizeUsage(event.usage), providerMetadata: event.providerMetadata as Record<string, unknown> | undefined, modelId: event.model.modelId, provider: event.model.provider, context: ctx })
    },
    onEnd: (event: GenerateTextEndEvent<ToolSet>) => {
      llmHooks.emit({ type: 'generation:finish', totalSteps: event.steps?.length ?? 1, totalUsage: normalizeUsage(event.totalUsage), providerMetadata: event.providerMetadata as Record<string, unknown> | undefined, durationMs: Date.now() - genStart, context: ctx })
    },
  }
}
