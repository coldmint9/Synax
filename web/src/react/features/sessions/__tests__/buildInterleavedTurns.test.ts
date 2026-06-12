import { describe, it, expect } from 'vitest'
import { buildInterleavedTurns } from '../buildInterleavedTurns'
import type { AgentRunStep, AgentRuntimeMessage, ToolCallRecord } from '../../../../lib/api/agentRuntime'

const SESSION_ID = 'sess-1'
const RUN_ID = 'run-1'
const STEP_ID = 'step-1'

function makeStep(partial: Partial<AgentRunStep> = {}): AgentRunStep {
  return {
    id: STEP_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    index: 1,
    status: 'completed',
    model: 'test-model',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:05.000Z',
    finishReason: 'tool-calls',
    metadata: {},
    ...partial,
  }
}

function makeMessage(partial: Partial<AgentRuntimeMessage>): AgentRuntimeMessage {
  return {
    id: 'msg-1',
    sessionId: SESSION_ID,
    runId: RUN_ID,
    stepId: STEP_ID,
    role: 'assistant',
    content: '',
    metadata: {},
    createdAt: '2026-01-01T00:00:01.000Z',
    ...partial,
  }
}

function makeToolCall(partial: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'tc-1',
    sessionId: SESSION_ID,
    runId: RUN_ID,
    stepId: STEP_ID,
    toolId: 'file.read',
    category: 'read',
    mutability: 'read',
    inputSummary: 'path/to/file',
    outputSummary: 'file contents',
    status: 'completed',
    startedAt: '2026-01-01T00:00:02.000Z',
    endedAt: '2026-01-01T00:00:03.000Z',
    error: null,
    ...partial,
  }
}

describe('buildInterleavedTurns', () => {
  it('places thinking before tool calls when thinking timestamp is earlier', () => {
    const turns = buildInterleavedTurns(
      [makeStep()],
      [makeToolCall({ id: 'tc-1', startedAt: '2026-01-01T00:00:02.000Z' })],
      [
        makeMessage({
          id: 'msg-thinking',
          content: 'Let me read the file first.',
          metadata: { type: 'thinking' },
          createdAt: '2026-01-01T00:00:01.000Z',
        }),
      ],
    )

    expect(turns).toHaveLength(1)
    expect(turns[0].blocks.map(b => b.type)).toEqual(['thinking', 'tool_call'])
    if (turns[0].blocks[0].type === 'thinking') {
      expect(turns[0].blocks[0].content).toBe('Let me read the file first.')
    }
  })

  it('orders thinking, text, and tool calls by timestamp', () => {
    const turns = buildInterleavedTurns(
      [makeStep()],
      [makeToolCall({ id: 'tc-1', startedAt: '2026-01-01T00:00:03.000Z' })],
      [
        makeMessage({
          id: 'msg-thinking',
          content: 'Planning next step.',
          metadata: { kind: 'thought' },
          createdAt: '2026-01-01T00:00:01.000Z',
        }),
        makeMessage({
          id: 'msg-text',
          content: 'I will inspect the file.',
          metadata: {},
          createdAt: '2026-01-01T00:00:02.000Z',
        }),
      ],
    )

    expect(turns[0].blocks.map(b => b.type)).toEqual(['thinking', 'text', 'tool_call'])
  })

  it('groups parallel tool calls without affecting thinking order', () => {
    const turns = buildInterleavedTurns(
      [makeStep()],
      [
        makeToolCall({ id: 'tc-1', toolId: 'file.read', startedAt: '2026-01-01T00:00:02.000Z' }),
        makeToolCall({ id: 'tc-2', toolId: 'grep.search', startedAt: '2026-01-01T00:00:02.100Z' }),
      ],
      [
        makeMessage({
          id: 'msg-thinking',
          content: 'Search and read in parallel.',
          metadata: { type: 'thinking' },
          createdAt: '2026-01-01T00:00:01.000Z',
        }),
      ],
    )

    expect(turns[0].blocks.map(b => b.type)).toEqual(['thinking', 'tool_call_group'])
    if (turns[0].blocks[1].type === 'tool_call_group') {
      expect(turns[0].blocks[1].calls).toHaveLength(2)
    }
  })
})
