import type { AgentRun, AgentRunStep, AgentSession, ToolCallRecord } from './agentRuntime'
import type { LlmRetryState, SessionLiveEvent } from './sessionLive'

export interface RuntimeChunk {
  type: string
  runId?: string
  stepId?: string
  retry?: LlmRetryState
  delta?: string
  step?: AgentRunStep
  toolCall?: ToolCallRecord
}
export interface RuntimeStreamRecord {
  sequence: number
  sessionId: string
  runId: string
  chunk: RuntimeChunk
  state: Pick<AgentSession, 'status' | 'activeRunId' | 'pendingResumeToken' | 'blockedReason' | 'updatedAt'>
}
export interface RuntimeSnapshot {
  session: AgentSession
  run: AgentRun | null
  cursor: number
  liveChunks: RuntimeChunk[]
  completedStepIds: string[]
}

/** Cursors order transport; authoritative state in the same record prevents stale chunks reopening old Runs. */
export class RuntimeStreamProjector {
  private cursor = 0
  private stepId: string | null = null
  private completedSteps = new Set<string>()
  private stateKey = ''

  snapshot(value: RuntimeSnapshot): SessionLiveEvent[] {
    this.cursor = value.cursor
    this.stepId = null
    this.completedSteps = new Set(value.completedStepIds)
    this.stateKey = this.key(value.session)
    return [{ type: 'runtime_state', sessionId: value.session.id, patch: value.session, reset: true, refresh: true },
      ...value.liveChunks.flatMap(chunk => this.live(chunk))]
  }

  record(value: RuntimeStreamRecord): SessionLiveEvent[] {
    if (value.sequence <= this.cursor) return []
    this.cursor = value.sequence
    const key = this.key(value.state)
    const terminal = !['running', 'queued', 'waiting_permission', 'waiting_input'].includes(value.state.status)
    const reset = terminal && this.stepId !== null
    const refresh = !['message_delta', 'thought_delta'].includes(value.chunk.type)
    const output: SessionLiveEvent[] = []
    if (key !== this.stateKey || refresh || reset) {
      output.push({ type: 'runtime_state', sessionId: value.sessionId, patch: value.state, reset, refresh })
      this.stateKey = key
    }
    if (reset) this.stepId = null
    if (terminal || value.state.activeRunId !== value.runId) return output
    return [...output, ...this.live(value.chunk)]
  }

  private key(state: Partial<AgentSession>): string {
    return JSON.stringify([state.status, state.activeRunId, state.pendingResumeToken, state.blockedReason])
  }

  private live(chunk: RuntimeChunk): SessionLiveEvent[] {
    if (chunk.type === 'step_started' && chunk.step) {
      if (this.completedSteps.has(chunk.step.id)) return []
      this.stepId = chunk.step.id
      return [{ type: 'step_started', stepId: chunk.step.id, stepIndex: chunk.step.index }]
    }
    if (!chunk.stepId || chunk.stepId !== this.stepId) return []
    if (chunk.type === 'retry_status' && chunk.retry) {
      return [{ type: 'retry_status', stepId: chunk.stepId, retry: chunk.retry }]
    }
    if ((chunk.type === 'message_delta' || chunk.type === 'thought_delta') && chunk.delta !== undefined) {
      return [{ type: chunk.type, stepId: chunk.stepId, delta: chunk.delta }]
    }
    if ((chunk.type === 'tool_call' || chunk.type === 'tool_result') && chunk.toolCall) {
      return [{ type: chunk.type, stepId: chunk.stepId, toolCall: chunk.toolCall }]
    }
    return []
  }
}
