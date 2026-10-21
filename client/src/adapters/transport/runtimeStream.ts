import type { AgentRun, AgentRunStep, AgentRuntimeMessage, AgentSession, PermissionDecision, RuntimeEvent, ToolCallRecord } from './agentRuntime'
import type { LlmRetryState, SessionLiveEvent } from './sessionLive'

export interface RuntimeChunk {
  type: string
  run?: AgentRun
  runId?: string
  stepId?: string
  retry?: LlmRetryState
  delta?: string
  outputTokens?: number
  thinkingTokens?: number
  step?: AgentRunStep
  queueRevision?: number
  toolCall?: ToolCallRecord
  message?: AgentRuntimeMessage
  permission?: PermissionDecision
  event?: RuntimeEvent
}
export interface RuntimeStreamRecord {
  sequence: number
  ephemeral?: boolean
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
  queuedInputs?: unknown[]
  forceInjectItemId?: string | null
}

/** Keep reconnect hydration as one render transaction on the client. */
export interface RuntimeSnapshotEvent {
  type: 'runtime_snapshot'
  sessionId: string
  session: AgentSession
  run?: AgentRun | null
  cursor: number
  liveChunks: RuntimeChunk[]
  completedStepIds: string[]
}

/** Chunks the store consumes locally by upserting the payload they carry; they must not trigger a full detail refresh. */
const LOCAL_CHUNK_TYPES = new Set([
  'message_delta',
  'thought_delta',
  'tool_call',
  'tool_result',
  'step_started',
  'retry_status',
  'input_queue_changed',
  'message',
  'input_injected',
  'event',
  'permission_requested',
])

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
    for (const chunk of value.liveChunks) {
      if (chunk.type === 'step_started' && chunk.step && !this.completedSteps.has(chunk.step.id))
        this.stepId = chunk.step.id
    }
    return [{
      type: 'runtime_snapshot',
      sessionId: value.session.id,
      session: value.session,
      ...(value.run ? { run: value.run } : {}),
      cursor: value.cursor,
      liveChunks: value.liveChunks,
      completedStepIds: value.completedStepIds,
    }]
  }

  record(value: RuntimeStreamRecord): SessionLiveEvent[] {
    if (!value.ephemeral) {
      if (value.sequence <= this.cursor) return []
      this.cursor = value.sequence
    }
    const key = this.key(value.state)
    const terminal = !['running', 'queued', 'waiting_permission', 'waiting_input'].includes(value.state.status)
    const reset = terminal && this.stepId !== null
    // Status/run transitions still refresh (permissions, stats); payload-bearing
    // chunks are applied locally and must not re-fetch the whole detail.
    const stateChanged = key !== this.stateKey
    const refresh = stateChanged || !LOCAL_CHUNK_TYPES.has(value.chunk.type)
    const output: SessionLiveEvent[] = value.chunk.type === 'input_queue_changed'
      ? [{ type: 'input_queue_changed', sessionId: value.sessionId, queueRevision: value.chunk.queueRevision ?? 0 }]
      : []
    if (stateChanged || refresh || reset) {
      const run = value.chunk.run
      output.push({ type: 'runtime_state', sessionId: value.sessionId, patch: value.state, reset, refresh,
        ...(run?.sessionId === value.sessionId && run.id === value.runId ? { run } : {}) })
      this.stateKey = key
    }
    if (reset) this.stepId = null
    // Full records already travel with the stream. Applying them locally keeps
    // message completion and permission prompts independent of history polling.
    // A terminal record may carry the final answer after activeRunId is cleared.
    if (value.state.activeRunId && value.state.activeRunId !== value.runId) return output
    const { message, permission, event } = value.chunk
    if (message?.sessionId === value.sessionId && (!message.runId || message.runId === value.runId))
      output.push({ type: 'message', message })
    if (permission?.sessionId === value.sessionId && permission.runId === value.runId)
      output.push({ type: 'permission_updated', permission })
    if (value.chunk.type === 'event' && event?.sessionId === value.sessionId)
      output.push({ type: 'event', event })
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
      return [{ type: 'step_started', stepId: chunk.step.id, stepIndex: chunk.step.index, step: chunk.step }]
    }
    if (!chunk.stepId || chunk.stepId !== this.stepId) return []
    if (chunk.type === 'retry_status' && chunk.retry) {
      return [{ type: 'retry_status', stepId: chunk.stepId, retry: chunk.retry }]
    }
    if ((chunk.type === 'message_delta' || chunk.type === 'thought_delta') && chunk.delta !== undefined) {
      const outputTokens = chunk.outputTokens
      return [{
        type: chunk.type,
        stepId: chunk.stepId,
        delta: chunk.delta,
        ...(chunk.type === 'message_delta' && typeof outputTokens === 'number' && Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? { outputTokens } : {}),
        ...(chunk.type === 'thought_delta' && typeof chunk.thinkingTokens === 'number' && Number.isSafeInteger(chunk.thinkingTokens) && chunk.thinkingTokens >= 0 ? { thinkingTokens: chunk.thinkingTokens } : {}),
      }]
    }
    if ((chunk.type === 'tool_call' || chunk.type === 'tool_result') && chunk.toolCall) {
      return [{ type: chunk.type, stepId: chunk.stepId, toolCall: chunk.toolCall }]
    }
    return []
  }
}
