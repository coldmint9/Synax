import { describe, it, expect } from 'vitest'
import {
  buildTurnRenderSegments,
  isFinalTextBlock,
  toolBlocksToBatches,
} from '../toolCallUtils'
import type { TurnContentBlock } from '../buildInterleavedTurns'

const bashCall = (id: string) => ({
  id,
  toolId: 'bash',
  inputSummary: `cmd-${id}`,
  outputSummary: `out-${id}`,
  status: 'completed',
  category: 'shell',
  duration: '10ms',
  mutability: 'read' as const,
})

describe('toolCallUtils', () => {
  it('groups parallel same-tool calls into one batch row', () => {
    const blocks: TurnContentBlock[] = [{
      type: 'tool_call_group',
      calls: [bashCall('1'), bashCall('2'), bashCall('3'), bashCall('4')],
    }]

    const batches = toolBlocksToBatches(blocks)
    expect(batches).toHaveLength(1)
    expect(batches[0].toolId).toBe('bash')
    expect(batches[0].calls).toHaveLength(4)
  })

  it('keeps sequential same-tool calls as separate rows', () => {
    const blocks: TurnContentBlock[] = [
      { type: 'tool_call', call: bashCall('1') },
      { type: 'tool_call', call: bashCall('2') },
    ]

    const batches = toolBlocksToBatches(blocks)
    expect(batches).toHaveLength(2)
    expect(batches.every(b => b.calls.length === 1)).toBe(true)
  })

  it('places tool calls after thinking into a tool_round segment', () => {
    const blocks: TurnContentBlock[] = [
      { type: 'thinking', content: 'plan' },
      { type: 'tool_call_group', calls: [bashCall('1'), bashCall('2')] },
      { type: 'text', content: 'done' },
    ]

    const segments = buildTurnRenderSegments(blocks)
    expect(segments.map(s => s.type)).toEqual(['thinking', 'tool_round', 'text'])
  })

  it('marks trailing text as markdown when no tool calls follow', () => {
    const blocks: TurnContentBlock[] = [
      { type: 'thinking', content: 'plan' },
      { type: 'tool_call', call: bashCall('1') },
      { type: 'text', content: '# Final answer' },
    ]

    expect(isFinalTextBlock(blocks, 2)).toBe(true)

    const segments = buildTurnRenderSegments(blocks)
    const textSegment = segments.find(s => s.type === 'text')
    expect(textSegment).toMatchObject({ markdown: true })
  })
})
