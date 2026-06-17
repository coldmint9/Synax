import { describe, expect, it } from 'vitest'
import { getSessionDisplayTitle } from '../useSessionDisplayTitle'
import type { AgentSession } from '../../../lib/api/agentRuntime'

function session(partial: Partial<AgentSession>): AgentSession {
  return {
    id: 'ars_test',
    projectId: 'proj',
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: 'goal',
    status: 'running',
    title: null,
    prompt: '## User Goal\nFix auth\n\n## Instructions\nLong system prompt…',
    contextSnapshotId: null,
    thinkingMode: 'standard',
    permissionRules: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: null,
    ...partial,
  }
}

describe('getSessionDisplayTitle', () => {
  it('prefers summarized title when present', () => {
    expect(getSessionDisplayTitle(session({ title: '认证模块排查' }))).toBe('认证模块排查')
  })

  it('falls back to goalContent before system prompt', () => {
    expect(getSessionDisplayTitle(session({
      sessionMetadata: { goalContent: '你好' },
    }))).toBe('你好')
  })

  it('falls back to truncated system prompt', () => {
    const prompt = `You are an agent\n\n${'x'.repeat(120)}`
    expect(getSessionDisplayTitle(session({ prompt }))).toBe(prompt.slice(0, 50))
  })
})
