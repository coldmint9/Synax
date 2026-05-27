import { extractReasoningMiddleware, wrapLanguageModel } from 'ai'
import type { LanguageModelV3 } from '@ai-sdk/provider'

export function applyReasoningMiddleware(model: LanguageModelV3): LanguageModelV3 {
  return wrapLanguageModel({
    model,
    middleware: extractReasoningMiddleware({ tagName: 'think', startWithReasoning: true }),
  })
}
