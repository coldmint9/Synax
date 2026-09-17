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

  it('projects tool-call chunks locally without requesting a detail refresh', () => {
    const projector = new RuntimeStreamProjector()
    projector.snapshot(snapshot)
    const toolCall = { id: 'call', sessionId: 'session', runId: 'run', stepId: 'step', toolId: 'edit_file', category: 'write', mutability: 'write', inputSummary: 'x', outputSummary: null, status: 'running', startedAt: '', endedAt: null, error: null } as never
    const output = projector.record({ ...record, chunk: { type: 'tool_call', stepId: 'step', toolCall } })
    // No runtime_state refresh event for a payload-bearing chunk on an unchanged state key.
    expect(output).toEqual([{ type: 'tool_call', stepId: 'step', toolCall }])
  })

  it('carries the full step object on step_started events', () => {
    const projector = new RuntimeStreamProjector()
    projector.snapshot({ ...snapshot, liveChunks: [] })
    const output = projector.record({ ...record, chunk: { type: 'step_started', step } })
    expect(output).toEqual([{ type: 'step_started', stepId: 'step', stepIndex: 1, step }])
  })

  it('still refreshes when the session state key changes (permissions, run transitions)', () => {
    const projector = new RuntimeStreamProjector()
    projector.snapshot(snapshot)
    const output = projector.record({ ...record, state: { ...session, status: 'waiting_permission' },
      chunk: { type: 'tool_call', stepId: 'step', toolCall: { id: 'call' } as never } })
    const stateEvent = output.find(event => event.type === 'runtime_state')
    expect(stateEvent).toMatchObject({ refresh: true, patch: { status: 'waiting_permission' } })
  })
})
