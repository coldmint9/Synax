import { describe, expect, it } from 'vitest'
import type { AgentSession, PermissionDecision } from '../../../lib/api/agentRuntime'
import {
  canEnqueueSessionInput,
  isSessionComposerLocked,
  patchAgentSession,
  sessionHasPendingPermissions,
} from '../sessionComposerState'

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    projectId: 'proj-1',
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: 'synax',
    status: 'completed',
    title: null,
    prompt: 'hello',
    contextSnapshotId: null,
    thinkingMode: 'standard',
    createdAt: '',
    updatedAt: '',
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    model: null,
    ...overrides,
  }
}

function makePermission(overrides: Partial<PermissionDecision> = {}): PermissionDecision {
  return {
    id: 'perm-1',
    sessionId: 'sess-1',
    runId: 'run-1',
    stepId: 'step-1',
    toolCallId: 'tool-1',
    coarseCategory: 'write',
    internalGate: 'write',
    action: 'ask',
    reason: 'needs approval',
    patterns: [],
    userReply: null,
    createdAt: '',
    resolvedAt: null,
    resumeToken: null,
    metadata: {},
    ...overrides,
  }
}

describe('sessionComposerState', () => {
  it('locks while submitting', () => {
    expect(isSessionComposerLocked(makeSession(), { submitting: true })).toBe(true)
  })

  it('locks running sessions with an active run', () => {
    expect(isSessionComposerLocked(makeSession({
      status: 'running',
      activeRunId: 'run-1',
    }))).toBe(true)
  })

  it('unlocks completed sessions', () => {
    expect(isSessionComposerLocked(makeSession({ status: 'completed' }))).toBe(false)
  })

  it('unlocks running sessions without activeRunId', () => {
    expect(isSessionComposerLocked(makeSession({ status: 'running', activeRunId: null }))).toBe(false)
  })

  it('locks waiting_permission only when pending approvals exist', () => {
    const session = makeSession({ status: 'waiting_permission', activeRunId: 'run-1' })
    expect(isSessionComposerLocked(session, { hasPendingPermissions: false })).toBe(false)
    expect(isSessionComposerLocked(session, { hasPendingPermissions: true })).toBe(true)
  })

  it('allows enqueue while running or waiting permission', () => {
    expect(canEnqueueSessionInput(makeSession({ status: 'running', activeRunId: 'run-1' }))).toBe(true)
    expect(canEnqueueSessionInput(makeSession({ status: 'waiting_permission', activeRunId: 'run-1' }))).toBe(true)
    expect(canEnqueueSessionInput(makeSession({ status: 'completed' }))).toBe(false)
    expect(canEnqueueSessionInput(undefined)).toBe(false)
  })

  it('patches session fields locally', () => {
    const session = makeSession({ status: 'running', activeRunId: 'run-1' })
    expect(patchAgentSession(session, { status: 'completed', activeRunId: null })).toMatchObject({
      status: 'completed',
      activeRunId: null,
    })
  })

  it('detects pending permissions only for the selected session', () => {
    const permissions = [makePermission()]
    expect(sessionHasPendingPermissions('sess-1', 'sess-1', permissions)).toBe(true)
    expect(sessionHasPendingPermissions('sess-1', 'sess-2', permissions)).toBe(false)
    expect(sessionHasPendingPermissions('sess-1', 'sess-1', [
      makePermission({ action: 'allow', resolvedAt: '2026-01-01T00:00:00Z' }),
    ])).toBe(false)
  })
})
