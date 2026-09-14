import { describe, expect, it } from 'vitest'
import { RuntimeStreamProjector, type RuntimeSnapshot, type RuntimeStreamRecord } from './runtimeStream'
import type { AgentSession, AgentRunStep } from './agentRuntime'
const session = { id: 'session', status: 'running', activeRunId: 'run', pendingResumeToken: null, blockedReason: null, updatedAt: '' } as AgentSession
const step = { id: 'step', runId: 'run', sessionId: 'session', index: 1, status: 'running' } as AgentRunStep
const snapshot = { session, run: null, cursor: 10, liveChunks: [{ type: 'step_started', step },
  { type: 'message_delta', stepId: 'step', delta: 'partial' }], completedStepIds: [] } satisfies RuntimeSnapshot
const record: RuntimeStreamRecord = { sequence: 11, sessionId: 'session', runId: 'run', state: session,
  chunk: { type: 'message_delta', stepId: 'step', delta: ' rest' } }

describe('runtime stream projection', () => {
  it('hydrates partial output on reconnect, then deduplicates cursor replay', () => {
    const projector = new RuntimeStreamProjector()
    expect(projector.snapshot(snapshot)).toContainEqual({ type: 'message_delta', stepId: 'step', delta: 'partial' })
    expect(projector.record(record)).toEqual([{ type: 'message_delta', stepId: 'step', delta: ' rest' }])
    expect(projector.record(record)).toEqual([])
  })
  it('does not reopen a finished session from a delayed run-start event', () => {
    const projector = new RuntimeStreamProjector()
    projector.snapshot(snapshot)
    const output = projector.record({ ...record, state: { ...session, status: 'completed', activeRunId: null },
      chunk: { type: 'step_started', step } })
    expect(output).toEqual([expect.objectContaining({ type: 'runtime_state', reset: true, patch: expect.objectContaining({ status: 'completed' }) })])
  })
  it('does not apply output from an older execution to the new active Run', () => {
    const projector = new RuntimeStreamProjector()
    projector.snapshot(snapshot)
    const output = projector.record({ ...record, state: { ...session, activeRunId: 'new-run' } })
    expect(output.some(event => event.type === 'message_delta')).toBe(false)
  })
})
