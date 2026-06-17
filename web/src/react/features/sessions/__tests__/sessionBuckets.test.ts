import { describe, expect, it } from 'vitest'
import type { AgentSession } from '../../../../lib/api/agentRuntime'
import { classifySession, isGoalSession, isWorkflowSession } from '../sessionBuckets'

function makeSession(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: 's1',
    projectId: 'p1',
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: 'goal',
    status: 'completed',
    title: null,
    prompt: 'test',
    contextSnapshotId: null,
    thinkingMode: 'standard',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: null,
    ...overrides,
  }
}

describe('sessionBuckets', () => {
  it('detects goal sessions', () => {
    expect(isGoalSession(makeSession({ profileId: 'goal' }))).toBe(true)
    expect(isGoalSession(makeSession({
      profileId: 'goal',
      sessionMetadata: { source: 'goal-dock' },
    }))).toBe(true)
    expect(isGoalSession(makeSession({
      profileId: 'goal',
      sessionMetadata: { source: 'plan-execution' },
    }))).toBe(true)
    expect(isGoalSession(makeSession({
      profileId: 'goal',
      sessionMetadata: { source: 'session-page' },
    }))).toBe(true)
  })

  it('detects wiki workflow sessions', () => {
    expect(isWorkflowSession(makeSession({ profileId: 'wiki-planner' }))).toBe(true)
    expect(isWorkflowSession(makeSession({ profileId: 'wiki-writer' }))).toBe(true)
    expect(isWorkflowSession(makeSession({ profileId: 'wiki-refresh' }))).toBe(true)
    expect(isWorkflowSession(makeSession({
      profileId: 'explorer',
      sessionMetadata: { snapshotId: 'snap-1', phase: 'planner' },
    }))).toBe(true)
    expect(isWorkflowSession(makeSession({ profileId: 'plan-planner' }))).toBe(true)
  })

  it('classifies interactive sessions as goal view bucket but not goal sessions', () => {
    expect(isGoalSession(makeSession({ profileId: 'explorer' }))).toBe(false)
    expect(classifySession(makeSession({ profileId: 'explorer' }))).toBe('goal')
    expect(isGoalSession(makeSession({ profileId: 'goal' }))).toBe(true)
  })

  it('classifies automation sessions as workflow view', () => {
    expect(classifySession(makeSession({ profileId: 'wiki-verifier' }))).toBe('workflow')
  })
})
