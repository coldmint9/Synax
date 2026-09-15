import { extractReasoningMiddleware, wrapLanguageModel } from 'ai'
import type { LanguageModelV4 } from '@ai-sdk/provider'

export function applyReasoningMiddleware(model: LanguageModelV4): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: extractReasoningMiddleware({ tagName: 'think', startWithReasoning: true }),
  })
}
