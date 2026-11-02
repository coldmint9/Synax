import { describe, expect, it } from 'vitest'
import type { AgentSession } from '../contracts.js'
import {
  announcesWorkerSettle,
  projectRuntimeSessionEvent,
  projectSessionState,
  projectSessionSummary,
} from '../session-projection.js'

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

  it('preserves Synax failed so the session list can flag the failure', () => {
    expect(projectSessionState(session('failed')).status).toBe('failed')
  })

  it.each(['cancelled', 'interrupted'] as const)(
    'projects terminal Synax %s as completed',
    (status) => expect(projectSessionState(session(status)).status).toBe('completed'),
  )

  it('normalizes retired blocked sessions as completed', () => {
    expect(projectSessionState(session('blocked', 'explorer')).status).toBe('completed')
  })

  it.each(['synax', 'goal', 'explorer'])(
    'preserves resumable paused sessions for %s',
    (profileId) => {
      const row = { ...session('paused', profileId), pendingResumeToken: 'resume-token' }
      expect(projectSessionState(row)).toBe(row)
      expect(projectSessionState(row).pendingResumeToken).toBe('resume-token')
    },
  )

  it.each(['synax', 'goal'])(
    'keeps a settled %s row settled while a stop fence is still present',
    (profileId) => {
      // `runtimeControl` is written before the stop is confirmed and is not
      // cleared when the run finishes first. Letting the fence decide rewound
      // the row to `running`, so every list kept animating a finished run.
      const fence = { runtimeControl: { state: 'stopping', reason: 'Stopping execution.' } }
      expect(
        projectSessionState({ ...session('completed', profileId), sessionMetadata: fence }).status,
      ).toBe('completed')
      expect(
        projectSessionState({ ...session('running', profileId), sessionMetadata: fence }).status,
      ).toBe('running')
    },
  )

  it('keeps a settled legacy row settled while a stop fence is still present', () => {
    const fence = { runtimeControl: { state: 'stopping', reason: 'Stopping execution.' } }
    expect(
      projectSessionState({ ...session('completed', 'explorer'), sessionMetadata: fence }).status,
    ).toBe('completed')
    expect(
      projectSessionState({ ...session('failed', 'explorer'), sessionMetadata: fence }).status,
    ).toBe('failed')
    expect(
      projectSessionState({ ...session('running', 'explorer'), sessionMetadata: fence }).status,
    ).toBe('stopping')
  })
})

describe('projectRuntimeSessionEvent', () => {
  it.each(['synax', 'executor'])(
    'keeps the event status instead of the stale copy for %s sessions',
    (profileId) => {
      const stale = { ...session('running', profileId), activeRunId: 'run-1' }
      expect(
        projectRuntimeSessionEvent(
          { patch: { status: 'completed', activeRunId: null } },
          stale,
        ),
      ).toEqual({ status: 'completed', activeRunId: null })
      expect(
        projectRuntimeSessionEvent(
          { patch: { status: 'waiting_input', pendingResumeToken: 'request-1' } },
          stale,
        ),
      ).toEqual({ status: 'waiting_input' })
    },
  )

  it('still normalizes retired lifecycle values from the event', () => {
    expect(
      projectRuntimeSessionEvent(
        { patch: { status: 'interrupted' } },
        session('running'),
      ),
    ).toEqual({ status: 'completed' })
  })

  it('does not replay the copy status on metadata-only events', () => {
    expect(
      projectRuntimeSessionEvent(
        { patch: { sessionMetadata: { mode: 'chat' } } },
        session('completed'),
      ),
    ).toEqual({})
    expect(
      projectRuntimeSessionEvent(
        { patch: { sessionMetadata: { runtimeControl: { state: 'unconfirmed' } } } },
        session('running'),
      ),
    ).toEqual({ status: 'completed' })
  })

  it('leaves unknown sessions and unrelated patches untouched', () => {
    expect(
      projectRuntimeSessionEvent({ patch: { status: 'completed' } }, undefined),
    ).toBeUndefined()
    expect(
      projectRuntimeSessionEvent({ patch: { title: 'Renamed' } }, session('completed')),
    ).toBeUndefined()
  })
})

describe('announcesWorkerSettle', () => {
  const settle = (status: string) => ({
    type: 'runtime:event',
    event: { type: 'session_changed', sessionId: 'session-1', patch: { status, activeRunId: null } },
  })

  it('accepts the terminal report of a worker that is being released', () => {
    expect(announcesWorkerSettle(settle('completed'), session('running'))).toBe(true)
    expect(announcesWorkerSettle(settle('failed'), session('queued'))).toBe(true)
  })

  it('ignores progress and non-terminal reports', () => {
    expect(announcesWorkerSettle(settle('running'), session('running'))).toBe(false)
    expect(announcesWorkerSettle(settle('stopping'), session('running'))).toBe(false)
    expect(
      announcesWorkerSettle(
        { type: 'runtime:event', event: { type: 'session_process_changed', sessionId: 'session-1' } },
        session('running'),
      ),
    ).toBe(false)
    expect(announcesWorkerSettle({ type: 'stream:done' }, session('running'))).toBe(false)
  })

  it('never undoes a stop this process already recorded', () => {
    expect(announcesWorkerSettle(settle('completed'), session('paused'))).toBe(false)
    expect(announcesWorkerSettle(settle('completed'), session('interrupted'))).toBe(false)
    expect(announcesWorkerSettle(settle('completed'), undefined)).toBe(false)
  })
})

describe('projectSessionSummary', () => {
  it('drops the per-step system-prompt preview from list rows', () => {
    const row = {
      ...session('running'),
      sessionMetadata: { mode: 'chat', latestSystemPrompt: 'x'.repeat(4096) },
    }
    const projected = projectSessionSummary(row)
    expect(projected.sessionMetadata).toEqual({ mode: 'chat', historyStorage: 3 })
    expect(JSON.stringify(projected)).not.toContain('x'.repeat(64))
  })

  it('advertises cursor history for existing sessions without mutating stored metadata', () => {
    const row = session('running')
    const projected = projectSessionSummary(row)
    expect(projected.sessionMetadata).toEqual({ historyStorage: 3 })
    expect(row.sessionMetadata).toEqual({})
    expect(projectSessionSummary(projected)).toBe(projected)
  })
})
