import { describe, expect, it } from 'vitest'
import { groupActivityEntries } from '../groupActivityEntries'
import type { ConversationTimelineEntry } from '../buildConversationTimeline'
import type { TurnContentBlock } from '../buildInterleavedTurns'

function entry(id: string, blocks: TurnContentBlock[]): ConversationTimelineEntry {
  return { id, kind: 'agent', createdAt: '', label: '', turn: { stepId: id, index: 0, status: 'completed', duration: null, blocks } }
}
const tool = (id: string): TurnContentBlock => ({ type: 'tool_call', call: {
  id, toolId: 'file.read', inputSummary: id, outputSummary: '', status: 'completed', category: 'read', mutability: 'read', duration: null,
} })

describe('groupActivityEntries', () => {
  it('keeps one stable group across model steps without changing source blocks', () => {
    const first = entry('one', [tool('a')])
    const initial = groupActivityEntries([first])
    const result = groupActivityEntries([first, entry('two', [{ type: 'thinking', content: 'next' }, tool('b')])])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(initial[0].id)
    expect(result[0].kind === 'agent' && result[0].turn.blocks).toHaveLength(3)
    expect(first.kind === 'agent' && first.turn.blocks).toHaveLength(1)
  })
  it('ends a group at reply output and starts another after it', () => {
    const result = groupActivityEntries([entry('one', [tool('a')]), entry('two', [tool('b'), { type: 'text', content: 'Reply' }, tool('c')])])
    expect(result).toHaveLength(3)
    expect(result.map(row => row.kind === 'agent' ? row.turn.blocks.map(block => block.type) : [])).toEqual([
      ['tool_call', 'tool_call'], ['text'], ['tool_call'],
    ])
  })
  it('does not merge across user messages and ignores empty text', () => {
    const user: ConversationTimelineEntry = { id: 'user', kind: 'user', createdAt: '', label: '', content: 'Continue' }
    const result = groupActivityEntries([entry('one', [tool('a'), { type: 'text', content: '  ' }, tool('b')]), user, entry('two', [tool('c')])])
    expect(result).toHaveLength(3)
    expect(result[1]).toBe(user)
  })
})
