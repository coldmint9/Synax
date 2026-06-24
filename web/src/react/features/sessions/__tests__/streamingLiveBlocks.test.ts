import { describe, expect, it } from 'vitest'
import {
  applyMessageDelta,
  applyThoughtDelta,
  applyToolCall,
  materializeLiveBlocks,
  snapshotStreamingBuffers,
} from '../streamingLiveBlocks'
import type { ToolCallRecord } from '../../../../lib/api/agentRuntime'

const toolCall = (id: string): ToolCallRecord => ({
  id,
  sessionId: 'sess-1',
  runId: 'run-1',
  stepId: 'step-1',
  toolId: 'grep.search',
  category: 'read',
  mutability: 'read',
  inputSummary: 'pattern',
  outputSummary: null,
  status: 'running',
  startedAt: '2026-01-01T00:00:02.000Z',
  endedAt: null,
  error: null,
})

describe('streamingLiveBlocks', () => {
  it('interleaves thinking, body text, and tool calls in order', () => {
    let state = applyThoughtDelta({ blocks: [], pendingThinking: '', pendingText: '', pendingToolCalls: [] }, 'plan')
    state = applyMessageDelta(state, 'I will inspect the file.')
    state = applyToolCall(state, toolCall('tc-1'))
    state = applyThoughtDelta(state, 'next')
    state = applyMessageDelta(state, 'Done.')

    const blocks = materializeLiveBlocks(state)
    expect(blocks.map(b => b.type)).toEqual([
      'thinking',
      'text',
      'tool_call',
      'thinking',
      'text',
    ])
  })

  it('snapshots flushed blocks when a step completes', () => {
    let state = applyThoughtDelta({ blocks: [], pendingThinking: '', pendingText: '', pendingToolCalls: [] }, 'plan')
    state = applyToolCall(state, toolCall('tc-1'))
    state = applyMessageDelta(state, 'status')

    const snapshot = snapshotStreamingBuffers(state)
    expect(snapshot.map(b => b.type)).toEqual(['thinking', 'tool_call', 'text'])
  })
})
