import { describe, expect, it } from 'vitest'
import type { AgentSession } from '../../../../lib/api/agentRuntime'
import { isSessionUnread } from '../agentSessionStore'

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    projectId: 'p1',
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: 'synax',
    status: 'completed',
    title: null,
    prompt: 'hello',
    contextSnapshotId: null,
    thinkingMode: 'standard',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    completedAt: '2026-01-02T00:00:00Z',
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    model: null,
    ...overrides,
  }
}

describe('isSessionUnread', () => {
  it('does not mark unseen completed sessions as unread', () => {
    expect(isSessionUnread(makeSession({ status: 'completed' }), {})).toBe(false)
  })

  it('marks unseen active sessions as unread', () => {
    expect(isSessionUnread(makeSession({ status: 'running' }), {})).toBe(true)
    expect(isSessionUnread(makeSession({ status: 'waiting_permission' }), {})).toBe(true)
  })

  it('respects persisted read markers', () => {
    const session = makeSession({ status: 'completed', updatedAt: '2026-01-02T00:00:00Z' })
    expect(isSessionUnread(session, { 'sess-1': '2026-01-02T00:00:00Z' })).toBe(false)
  })

  it('shows unread again after updates following last read', () => {
    const session = makeSession({ status: 'completed', updatedAt: '2026-01-03T00:00:00Z' })
    expect(isSessionUnread(session, { 'sess-1': '2026-01-02T00:00:00Z' })).toBe(true)
  })
})
