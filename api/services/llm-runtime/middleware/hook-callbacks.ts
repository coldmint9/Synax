import type { OnFinishEvent, OnStartEvent, OnStepFinishEvent, OnStepStartEvent, OnToolCallFinishEvent, OnToolCallStartEvent, ToolSet } from 'ai'
import type { LlmGatewayRequest } from '../types.js'
import { llmHooks } from '../llm-hooks.js'

function normalizeUsage(usage: unknown): { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  return {
    promptTokens: typeof u.promptTokens === 'number' ? u.promptTokens : undefined,
    completionTokens: typeof u.completionTokens === 'number' ? u.completionTokens : undefined,
    totalTokens: typeof u.totalTokens === 'number' ? u.totalTokens : undefined,
  }
}

export function buildHookCallbacks(request: LlmGatewayRequest) {
  const ctx = request.hookContext
  const genStart = Date.now()

  return {
    experimental_onStart: (event: OnStartEvent<ToolSet>) => {
      llmHooks.emit({ type: 'generation:start', modelId: event.model.modelId, provider: event.model.provider, purpose: request.purpose, context: ctx })
    },
    experimental_onStepStart: (event: OnStepStartEvent<ToolSet>) => {
      llmHooks.emit({ type: 'step:start', stepNumber: event.stepNumber, modelId: event.model.modelId, provider: event.model.provider, purpose: request.purpose, context: ctx })
    },
    experimental_onToolCallStart: (event: OnToolCallStartEvent<ToolSet>) => {
      llmHooks.emit({ type: 'tool_call:start', toolName: event.toolCall.toolName, toolCallId: event.toolCall.toolCallId, stepNumber: event.stepNumber ?? undefined, context: ctx })
    },
    experimental_onToolCallFinish: (event: OnToolCallFinishEvent<ToolSet>) => {
      llmHooks.emit({ type: 'tool_call:end', toolName: event.toolCall.toolName, toolCallId: event.toolCall.toolCallId, durationMs: event.durationMs, success: event.success, error: !event.success ? String(event.error) : undefined, context: ctx })
    },
    onStepFinish: (event: OnStepFinishEvent<ToolSet>) => {
      llmHooks.emit({ type: 'step:finish', stepNumber: event.stepNumber, finishReason: event.finishReason ?? 'unknown', usage: normalizeUsage(event.usage), modelId: event.model.modelId, provider: event.model.provider, context: ctx })
    },
    onFinish: (event: OnFinishEvent<ToolSet>) => {
      llmHooks.emit({ type: 'generation:finish', totalSteps: event.steps?.length ?? 1, totalUsage: normalizeUsage(event.totalUsage), durationMs: Date.now() - genStart, context: ctx })
    },
  }
}
