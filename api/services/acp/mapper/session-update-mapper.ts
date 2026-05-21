// ---------------------------------------------------------------------------
// session/update → CoordinatesRunEvent mapper
//
// Pure function; no side effects, no process/fs access. Keeps the business
// event schema decoupled from the raw ACP wire format so we can evolve
// either side independently.
//
// Input type comes straight from `@agentclientprotocol/sdk`'s generated
// schema — we benefit from TS discriminated-union narrowing in the switch.
// ---------------------------------------------------------------------------

import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { logger } from '../../../lib/logger.js'
import type { CoordinatesRunEvent } from '../contracts.js'

export interface MapperBase {
  runId: string
  clusterId: string
  intent: string
}

/** Extract plain text from SDK's ContentBlock (only text variant carries text). */
function extractText(content: { type: string; text?: string } | undefined): string {
  if (!content) return ''
  if (content.type === 'text') return content.text ?? ''
  return ''
}

/**
 * 从 ACP tool_call/tool_call_update 的 locations + content 里提取文件/行号，
 * 形成供 forest.links 写回的 SourceLinkHint。严格容错：任何字段缺失都用 optional。
 */
function extractSourceLinkHints(
  update: Extract<
    SessionUpdate,
    { sessionUpdate: 'tool_call' | 'tool_call_update' }
  >,
): CoordinatesRunEvent extends { payload?: infer P }
  ? P extends { sourceLinkHints?: infer H }
    ? H
    : never
  : never {
  type Hint = {
    path?: string
    startLine?: number
    endLine?: number
    symbol?: string
    confidence?: number
    createdBy?: 'agent' | 'analyzer' | 'human'
  }
  const hints: Hint[] = []
  const locations = (update as { locations?: Array<{ path?: string; line?: number }> }).locations
  if (Array.isArray(locations)) {
    for (const loc of locations) {
      if (!loc?.path) continue
      hints.push({
        path: loc.path,
        startLine: typeof loc.line === 'number' ? loc.line : undefined,
        createdBy: 'agent',
        confidence: 0.5,
      })
    }
  }
  const content = (update as { content?: Array<{ type?: string; path?: string }> }).content
  if (Array.isArray(content)) {
    for (const block of content) {
      const path = (block as { path?: string }).path
      if (typeof path === 'string' && path) {
        if (!hints.find((h) => h.path === path)) {
          hints.push({ path, createdBy: 'agent', confidence: 0.4 })
        }
      }
    }
  }
  return hints as unknown as ReturnType<typeof extractSourceLinkHints>
}

/**
 * Map a single ACP session/update notification into a business event.
 * Returns `null` when the update should be skipped (e.g. user echoes).
 */
export function mapSessionUpdate(
  base: MapperBase,
  ts: number,
  update: SessionUpdate,
): CoordinatesRunEvent | null {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      return {
        ...base,
        type: 'agent_message',
        ts,
        payload: { message: extractText(update.content) },
      }
    }

    case 'agent_thought_chunk': {
      return {
        ...base,
        type: 'agent_message',
        ts,
        payload: { message: `[thought] ${extractText(update.content)}` },
      }
    }

    case 'tool_call': {
      const title = update.title ?? update.kind ?? 'unknown'
      const status = update.status ?? 'pending'
      const sourceLinkHints = extractSourceLinkHints(update)
      return {
        ...base,
        type: 'artifact_proposed',
        ts,
        payload: {
          message: `Tool call: ${title} (${status})`,
          layer: 'artifact_op',
          ...(sourceLinkHints.length ? { sourceLinkHints } : {}),
        },
      }
    }

    case 'tool_call_update': {
      const isComplete = update.status === 'completed'
      const toolCallId = update.toolCallId ?? ''
      const status = update.status ?? 'unknown'
      const sourceLinkHints = extractSourceLinkHints(update)
      return {
        ...base,
        type: isComplete ? 'artifact_applied' : 'artifact_proposed',
        ts,
        payload: {
          message: `Tool ${toolCallId}: ${status}`,
          layer: 'artifact_op',
          ...(sourceLinkHints.length ? { sourceLinkHints } : {}),
        },
      }
    }

    case 'plan': {
      const planText = update.entries
        .map((e) => `[${e.status ?? '-'}] ${e.content}`)
        .join('\n')
      return {
        ...base,
        type: 'intent_interpreted',
        ts,
        payload: { message: planText },
      }
    }

    case 'user_message_chunk': {
      // Echoed user message — skip
      return null
    }

    default: {
      logger.debug(
        { updateType: update.sessionUpdate },
        '[Mapper] unmapped session update type',
      )
      return null
    }
  }
}
