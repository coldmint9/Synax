/**
 * Synapse Context Manager
 *
 * Two-layer context compression, directly inspired by clawspring's compaction.py
 * and Claude Code's autoCompact + CONTEXT_COLLAPSE mechanisms.
 *
 * Layer 1: Snip — truncate old tool results in-place
 * Layer 2: Compact — summarize old messages via LLM, keep recent ones intact
 */

import type { Message, UserMessage, AssistantMessage, ToolResultMessage } from '../models/types.js'

// ─── Token Estimation ─────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 3.5

export function estimateTokens(messages: Message[]): number {
  let totalChars = 0
  for (const m of messages) {
    if ('content' in m && typeof m.content === 'string') {
      totalChars += m.content.length
    }
    if ('toolCalls' in m && m.toolCalls) {
      for (const tc of m.toolCalls) {
        totalChars += JSON.stringify(tc).length
      }
    }
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN)
}

export function getContextLimit(model: string): number {
  // Default limits by model family
  if (model.includes('claude')) return 200_000
  if (model.includes('gpt-4') || model.includes('o3')) return 128_000
  if (model.includes('gemini')) return 1_000_000
  if (model.includes('deepseek')) return 64_000
  return 128_000
}

// ─── Layer 1: Snip Old Tool Results ───────────────────────────────────────

export interface SnipOptions {
  maxChars?: number
  preserveLastNTurns?: number
}

export function snipOldToolResults(
  messages: Message[],
  options: SnipOptions = {},
): Message[] {
  const { maxChars = 2000, preserveLastNTurns = 6 } = options
  const cutoff = Math.max(0, messages.length - preserveLastNTurns)

  for (let i = 0; i < cutoff; i++) {
    const m = messages[i]
    if (m.role !== 'tool') continue
    if (typeof m.content !== 'string' || m.content.length <= maxChars) continue

    const firstHalf = m.content.slice(0, Math.floor(maxChars / 2))
    const lastQuarter = m.content.slice(-Math.floor(maxChars / 4))
    const snipped = m.content.length - firstHalf.length - lastQuarter.length

    // Mutate in place (same pattern as clawspring)
    ;(m as ToolResultMessage).content =
      `${firstHalf}\n[... ${snipped} chars snipped ...]\n${lastQuarter}`
  }

  return messages
}

// ─── Layer 2: Auto-Compact ────────────────────────────────────────────────

export function findSplitPoint(messages: Message[], keepRatio = 0.3): number {
  const total = estimateTokens(messages)
  const target = Math.floor(total * keepRatio)
  let running = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    running += estimateTokens([messages[i]])
    if (running >= target) return i
  }
  return 0
}

export interface CompactOptions {
  /** Custom summarizer function — in production this calls an LLM */
  summarize?: (oldMessages: Message[]) => Promise<string>
}

const DEFAULT_SUMMARIZER = async (oldMessages: Message[]): Promise<string> => {
  // In production, this calls an LLM API. For now, extract key content.
  const parts: string[] = []
  for (const m of oldMessages) {
    const role = m.role
    if ('content' in m && typeof m.content === 'string') {
      parts.push(`[${role}]: ${m.content.slice(0, 500)}`)
    } else if ('toolCalls' in m && m.toolCalls) {
      parts.push(`[${role}]: tool calls: ${m.toolCalls.map(tc => tc.name).join(', ')}`)
    }
  }
  return parts.join('\n')
}

export async function compactMessages(
  messages: Message[],
  options: CompactOptions = {},
): Promise<Message[]> {
  const summarize = options.summarize ?? DEFAULT_SUMMARIZER
  const split = findSplitPoint(messages)
  if (split <= 0) return messages

  const old = messages.slice(0, split)
  const recent = messages.slice(split)

  const summaryText = await summarize(old)

  const summaryMsg: UserMessage = {
    role: 'user',
    content: `[Previous conversation summary]\n${summaryText}`,
  }

  const ackMsg: AssistantMessage = {
    role: 'assistant',
    content: 'Understood. I have the context from the previous conversation. Let\'s continue.',
  }

  return [summaryMsg, ackMsg, ...recent]
}

// ─── Main Entry ───────────────────────────────────────────────────────────

export interface MaybeCompactOptions extends SnipOptions, CompactOptions {
  model?: string
  compactThreshold?: number // fraction of context limit (default 0.7)
}

export async function maybeCompact(
  messages: Message[],
  options: MaybeCompactOptions = {},
): Promise<{ messages: Message[]; compacted: boolean }> {
  const model = options.model ?? 'default'
  const limit = getContextLimit(model)
  const threshold = limit * (options.compactThreshold ?? 0.7)

  if (estimateTokens(messages) <= threshold) {
    return { messages, compacted: false }
  }

  // Layer 1: snip old tool results
  const snipped = snipOldToolResults(messages, options)

  if (estimateTokens(snipped) <= threshold) {
    return { messages: snipped, compacted: true }
  }

  // Layer 2: auto-compact
  const compacted = await compactMessages(snipped, options)
  return { messages: compacted, compacted: true }
}
