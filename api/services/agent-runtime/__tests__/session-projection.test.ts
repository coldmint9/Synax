import { describe, expect, it } from 'vitest'
import type { AgentSession } from '../contracts.js'
import { projectSessionState } from '../session-projection.js'

type LegacySessionStatus = AgentSession['status'] | 'blocked' | 'paused'

function session(status: LegacySessionStatus, profileId = 'synax'): AgentSession {
  return {
    id: 'session-1',
    projectId: 'project-1',
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId,
    status: status as AgentSession['status'],
    title: null,
    prompt: 'test',
    contextSnapshotId: null,
    thinkingMode: 'standard',
    permissionRules: [],
    createdAt: '',
    updatedAt: '',
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    mcpServerIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: {},
  }
}

describe('projectSessionState', () => {
  it.each(['waiting_permission', 'waiting_input'] as const)(
    'preserves Synax %s as a distinct waiting state',
    (status) => expect(projectSessionState(session(status)).status).toBe(status),
  )

  it.each(['failed', 'cancelled', 'interrupted'] as const)(
    'projects terminal Synax %s as completed',
    (status) => expect(projectSessionState(session(status)).status).toBe('completed'),
  )

  it.each(['blocked', 'paused'] as const)(
    'normalizes legacy %s sessions as completed for every profile',
    (status) => expect(projectSessionState(session(status, 'explorer')).status).toBe('completed'),
  )
})
