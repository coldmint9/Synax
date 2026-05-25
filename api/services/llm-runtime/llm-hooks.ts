import { logger } from '../../lib/logger.js'

// ── Event types ──────────────────────────────────────────────────────────────

export interface LlmUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export type LlmHookEvent =
  | { type: 'generation:start'; modelId: string; provider: string; purpose: string; context?: LlmHookContext }
  | { type: 'step:start'; stepNumber: number; modelId: string; provider: string; purpose: string; context?: LlmHookContext }
  | { type: 'tool_call:start'; toolName: string; toolCallId: string; stepNumber?: number; context?: LlmHookContext }
  | { type: 'tool_call:end'; toolName: string; toolCallId: string; durationMs: number; success: boolean; error?: string; context?: LlmHookContext }
  | { type: 'step:finish'; stepNumber: number; finishReason: string; usage?: LlmUsage; modelId: string; provider: string; context?: LlmHookContext }
  | { type: 'generation:finish'; totalSteps: number; totalUsage?: LlmUsage; durationMs: number; context?: LlmHookContext }

export type LlmHookEventType = LlmHookEvent['type']

// ── Hook context (caller-provided metadata) ─────────────────────────────────

export interface LlmHookContext {
  sessionId?: string
  runId?: string
  stepId?: string
  purpose?: string
}

// ── Hook interface ──────────────────────────────────────────────────────────

export interface LlmHookFilter {
  eventTypes?: LlmHookEventType[]
  purpose?: string
}

export interface LlmHook {
  id: string
  filter?: LlmHookFilter
  handler: (event: LlmHookEvent) => Promise<void> | void
}

// ── Registry ────────────────────────────────────────────────────────────────

export class LlmHookRegistry {
  private readonly hooks = new Map<string, LlmHook>()

  register(hook: LlmHook): void {
    this.hooks.set(hook.id, hook)
  }

  unregister(hookId: string): void {
    this.hooks.delete(hookId)
  }

  emit(event: LlmHookEvent): void {
    for (const hook of this.hooks.values()) {
      if (!this.matches(hook, event)) continue
      try {
        const result = hook.handler(event)
        if (result && typeof result === 'object' && 'catch' in result) {
          (result as Promise<void>).catch((err) => {
            logger.warn({ hookId: hook.id, eventType: event.type, err }, '[llm-hooks] async handler failed')
          })
        }
      } catch (err) {
        logger.warn({ hookId: hook.id, eventType: event.type, err }, '[llm-hooks] handler failed')
      }
    }
  }

  private matches(hook: LlmHook, event: LlmHookEvent): boolean {
    const f = hook.filter
    if (!f) return true
    if (f.eventTypes && !f.eventTypes.includes(event.type)) return false
    if (f.purpose && 'context' in event && event.context?.purpose !== f.purpose) return false
    return true
  }
}

export const llmHooks = new LlmHookRegistry()
