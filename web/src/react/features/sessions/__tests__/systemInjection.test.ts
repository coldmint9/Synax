import { describe, expect, it } from 'vitest'
import type { AgentRuntimeMessage } from '../../../../lib/api/agentRuntime'
import { isSystemInjectedMessage, buildUserMessageEntries } from '../buildConversationTimeline'

function message(overrides: Partial<AgentRuntimeMessage> = {}): AgentRuntimeMessage {
  return {
    id: 'msg-1',
    sessionId: 'sess-1',
    runId: null,
    stepId: null,
    role: 'user',
    content: 'hello',
    metadata: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as AgentRuntimeMessage
}

const COMPOSED = [
  '## Language Output Directive',
  'Think and process internally in English.',
  '',
  '## User Goal',
  'Add a spinner',
].join('\n')

describe('system prompt injection detection', () => {
  it('detects the explicit messageSource marker', () => {
    expect(isSystemInjectedMessage(message({ metadata: { source: 'system_injection' }, content: 'anything' }))).toBe(true)
  })

  it('detects historical composed prompts by their language directive header', () => {
    expect(isSystemInjectedMessage(message({ metadata: { source: 'turn_request' }, content: COMPOSED }))).toBe(true)
  })

  it('leaves ordinary user turns alone', () => {
    expect(isSystemInjectedMessage(message({ metadata: { source: 'turn_request' }, content: '提交这些代码' }))).toBe(false)
    expect(isSystemInjectedMessage(message({ metadata: null, content: '正常的提问' }))).toBe(false)
  })

  it('labels injected entries and keeps them in the timeline', () => {
    const entries = buildUserMessageEntries([
      message({ id: 'msg-a', metadata: { source: 'turn_request' }, content: COMPOSED }),
      message({ id: 'msg-b', metadata: { source: 'turn_request' }, content: '提交这些代码' }),
    ])

    expect(entries).toHaveLength(2)
    expect(entries[0].injected).toBe(true)
    expect(entries[0].label).toBe('已注入系统提示')
    // the full payload is still available, but not used as the label
    expect(entries[0].content).toBe(COMPOSED)
    expect(entries[1].injected).toBeUndefined()
    expect(entries[1].label).toBe('提交这些代码')
  })
})
