import type { ToolCallRecord } from '../../../lib/api/agentRuntime'
import type { ToolCallView, TurnContentBlock } from './buildInterleavedTurns'

export function toolCallRecordToView(tc: ToolCallRecord): ToolCallView {
  return {
    id: tc.id,
    toolId: tc.toolId,
    inputSummary: tc.inputSummary ?? '',
    outputSummary: tc.outputSummary ?? '',
    status: tc.status,
    category: tc.category,
    duration: tc.endedAt
      ? formatToolDuration(tc.startedAt, tc.endedAt)
      : null,
    mutability: tc.mutability,
  }
}

export function formatToolDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function flattenToolBlocks(blocks: TurnContentBlock[]): ToolCallView[] {
  const calls: ToolCallView[] = []
  for (const block of blocks) {
    if (block.type === 'tool_call') calls.push(block.call)
    if (block.type === 'tool_call_group') calls.push(...block.calls)
  }
  return calls
}

export function isToolBlock(block: TurnContentBlock): boolean {
  return block.type === 'tool_call' || block.type === 'tool_call_group'
}

export interface ToolCallBatch {
  toolId: string
  calls: ToolCallView[]
}

function splitParallelGroupByToolId(calls: ToolCallView[]): ToolCallBatch[] {
  const batches: ToolCallBatch[] = []
  for (const call of calls) {
    const last = batches[batches.length - 1]
    if (last && last.toolId === call.toolId) {
      last.calls.push(call)
    } else {
      batches.push({ toolId: call.toolId, calls: [call] })
    }
  }
  return batches
}

/** Each inner batch is one summary row; parallel same-tool calls share a row. */
export function toolBlocksToBatches(blocks: TurnContentBlock[]): ToolCallBatch[] {
  const batches: ToolCallBatch[] = []
  for (const block of blocks) {
    if (block.type === 'tool_call') {
      batches.push({ toolId: block.call.toolId, calls: [block.call] })
    } else if (block.type === 'tool_call_group') {
      batches.push(...splitParallelGroupByToolId(block.calls))
    }
  }
  return batches
}

export function isFinalTextBlock(blocks: TurnContentBlock[], index: number): boolean {
  if (blocks[index]?.type !== 'text') return false
  for (let j = index + 1; j < blocks.length; j++) {
    if (isToolBlock(blocks[j])) return false
  }
  return true
}

export type TurnRenderSegment =
  | { type: 'thinking'; content: string }
  | { type: 'tool_round'; toolBlocks: TurnContentBlock[] }
  | { type: 'text'; content: string; markdown: boolean }
  | { type: 'sub_session'; session: import('../../../lib/api/agentRuntime').AgentSession }
  | { type: 'context_compacted'; originalTokens: number; compressedTokens: number; messageCount: number }

export function buildTurnRenderSegments(blocks: TurnContentBlock[]): TurnRenderSegment[] {
  const segments: TurnRenderSegment[] = []
  let i = 0

  while (i < blocks.length) {
    const block = blocks[i]

    if (block.type === 'thinking') {
      segments.push({ type: 'thinking', content: block.content })
      i++
      const toolBlocks: TurnContentBlock[] = []
      while (i < blocks.length && isToolBlock(blocks[i])) {
        toolBlocks.push(blocks[i])
        i++
      }
      if (toolBlocks.length > 0) {
        segments.push({ type: 'tool_round', toolBlocks })
      }
      continue
    }

    if (isToolBlock(block)) {
      const toolBlocks: TurnContentBlock[] = []
      while (i < blocks.length && isToolBlock(blocks[i])) {
        toolBlocks.push(blocks[i])
        i++
      }
      segments.push({ type: 'tool_round', toolBlocks })
      continue
    }

    if (block.type === 'text') {
      segments.push({
        type: 'text',
        content: block.content,
        markdown: isFinalTextBlock(blocks, i),
      })
      i++
      continue
    }

    if (block.type === 'sub_session') {
      segments.push({ type: 'sub_session', session: block.session })
      i++
      continue
    }

    if (block.type === 'context_compacted') {
      segments.push({
        type: 'context_compacted',
        originalTokens: block.originalTokens,
        compressedTokens: block.compressedTokens,
        messageCount: block.messageCount,
      })
      i++
      continue
    }

    i++
  }

  return segments
}
