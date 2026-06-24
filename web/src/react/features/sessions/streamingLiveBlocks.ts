import type { ToolCallRecord } from '../../../lib/api/agentRuntime'
import type { TurnContentBlock } from './buildInterleavedTurns'
import { toolCallRecordToView } from './toolCallUtils'

export interface StreamingLiveBuffers {
  blocks: TurnContentBlock[]
  pendingThinking: string
  pendingText: string
  pendingToolCalls: ToolCallRecord[]
}

export const EMPTY_STREAMING_BUFFERS: StreamingLiveBuffers = {
  blocks: [],
  pendingThinking: '',
  pendingText: '',
  pendingToolCalls: [],
}

function toolCallsToBlocks(toolCalls: ToolCallRecord[]): TurnContentBlock[] {
  if (toolCalls.length === 0) return []
  const views = toolCalls.map(toolCallRecordToView)
  if (views.length === 1) return [{ type: 'tool_call', call: views[0] }]
  return [{ type: 'tool_call_group', calls: views }]
}

function flushThinking(state: StreamingLiveBuffers): StreamingLiveBuffers {
  if (!state.pendingThinking.trim()) return state
  return {
    ...state,
    blocks: [...state.blocks, { type: 'thinking', content: state.pendingThinking }],
    pendingThinking: '',
  }
}

function flushText(state: StreamingLiveBuffers): StreamingLiveBuffers {
  if (!state.pendingText.trim()) return state
  return {
    ...state,
    blocks: [...state.blocks, { type: 'text', content: state.pendingText }],
    pendingText: '',
  }
}

function flushToolCalls(state: StreamingLiveBuffers): StreamingLiveBuffers {
  if (state.pendingToolCalls.length === 0) return state
  return {
    ...state,
    blocks: [...state.blocks, ...toolCallsToBlocks(state.pendingToolCalls)],
    pendingToolCalls: [],
  }
}

export function applyThoughtDelta(state: StreamingLiveBuffers, delta: string): StreamingLiveBuffers {
  if (!delta) return state
  let next = state
  if (next.pendingToolCalls.length > 0) {
    next = flushToolCalls(next)
  }
  return { ...next, pendingThinking: next.pendingThinking + delta }
}

export function applyMessageDelta(state: StreamingLiveBuffers, delta: string): StreamingLiveBuffers {
  if (!delta) return state
  let next = flushToolCalls(state)
  if (next.pendingThinking.trim()) {
    next = flushThinking(next)
  }
  return { ...next, pendingText: next.pendingText + delta }
}

export function applyToolCall(state: StreamingLiveBuffers, toolCall: ToolCallRecord): StreamingLiveBuffers {
  let next = state
  if (next.pendingThinking.trim()) next = flushThinking(next)
  if (next.pendingText.trim()) next = flushText(next)
  return {
    ...next,
    pendingToolCalls: [...next.pendingToolCalls, toolCall],
  }
}

export function applyToolResult(state: StreamingLiveBuffers, toolCall: ToolCallRecord): StreamingLiveBuffers {
  if (state.pendingToolCalls.length === 0) return state
  return {
    ...state,
    pendingToolCalls: state.pendingToolCalls.map(tc =>
      tc.id === toolCall.id ? toolCall : tc,
    ),
  }
}

export function snapshotStreamingBuffers(state: StreamingLiveBuffers): TurnContentBlock[] {
  let next = flushThinking(state)
  next = flushText(next)
  next = flushToolCalls(next)
  return next.blocks
}

export function hasStreamingContent(state: StreamingLiveBuffers): boolean {
  return state.blocks.length > 0
    || Boolean(state.pendingThinking)
    || Boolean(state.pendingText)
    || state.pendingToolCalls.length > 0
}

export function materializeLiveBlocks(state: StreamingLiveBuffers): TurnContentBlock[] {
  const blocks = [...state.blocks]
  if (state.pendingThinking.trim()) {
    blocks.push({ type: 'thinking', content: state.pendingThinking })
  }
  if (state.pendingToolCalls.length > 0) {
    blocks.push(...toolCallsToBlocks(state.pendingToolCalls))
  }
  if (state.pendingText.trim()) {
    blocks.push({ type: 'text', content: state.pendingText })
  }
  return blocks
}
