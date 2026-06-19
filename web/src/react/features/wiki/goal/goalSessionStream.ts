import {
  agentRuntimeApi,
  type PermissionDecision,
  type ToolCallRecord,
  type ToolCallStatus,
} from '../../../../lib/api/agentRuntime'
import type { SessionLiveEvent } from '../../../../lib/api/sessionLive'
import { useAgentSessionStore } from '../../sessions/agentSessionStore'

export type GoalSessionStatus = 'idle' | 'running' | 'waiting_permission' | 'completed' | 'failed'

export interface GoalToolCall {
  id: string
  tool: string
  summary: string
  outputSummary: string | null
  status: ToolCallStatus
}

export interface GoalSessionState {
  status: GoalSessionStatus
  sessionId: string | null
  title: string | null
  promptFallback: string | null
  toolCalls: GoalToolCall[]
  permissions: PermissionDecision[]
  streamingThinking: string
  streamingText: string
  error: string | null
}

export const initialGoalSessionState: GoalSessionState = {
  status: 'idle',
  sessionId: null,
  title: null,
  promptFallback: null,
  toolCalls: [],
  permissions: [],
  streamingThinking: '',
  streamingText: '',
  error: null,
}

export function resolveGoalSessionDisplayTitle(
  session: GoalSessionState,
  workingLabel: string,
): string {
  const title = session.title?.trim()
  if (title) return title
  const fallback = session.promptFallback?.trim()
  if (fallback) return fallback
  if (isGoalSessionActive(session.status)) return workingLabel
  return ''
}

type StreamChunk = {
  type?: string
  delta?: string
  toolCall?: ToolCallRecord
  permission?: PermissionDecision
  error?: string
}

function toGoalToolCall(toolCall: ToolCallRecord): GoalToolCall {
  return {
    id: toolCall.id,
    tool: toolCall.toolId,
    summary: toolCall.inputSummary,
    outputSummary: toolCall.outputSummary,
    status: toolCall.status,
  }
}

function upsertToolCall(calls: GoalToolCall[], toolCall: ToolCallRecord): GoalToolCall[] {
  const next = toGoalToolCall(toolCall)
  const index = calls.findIndex(call => call.id === next.id)
  if (index === -1) return [...calls, next]
  const updated = [...calls]
  updated[index] = { ...updated[index], ...next }
  return updated
}

function upsertPermission(
  permissions: PermissionDecision[],
  permission: PermissionDecision,
): PermissionDecision[] {
  const index = permissions.findIndex(item => item.id === permission.id)
  if (index === -1) return [...permissions, permission]
  const updated = [...permissions]
  updated[index] = permission
  return updated
}

export function applyGoalStreamChunk(
  state: GoalSessionState,
  chunk: unknown,
): GoalSessionState {
  if (!chunk || typeof chunk !== 'object') return state
  const typed = chunk as StreamChunk

  switch (typed.type) {
    case 'thought_delta':
      return {
        ...state,
        status: state.status === 'waiting_permission' ? state.status : 'running',
        streamingThinking: state.streamingThinking + (typed.delta ?? ''),
      }
    case 'message_delta':
      return {
        ...state,
        status: state.status === 'waiting_permission' ? state.status : 'running',
        streamingText: state.streamingText + (typed.delta ?? ''),
      }
    case 'tool_call':
      if (!typed.toolCall) return { ...state, status: 'running' }
      return {
        ...state,
        status: 'running',
        toolCalls: upsertToolCall(state.toolCalls, typed.toolCall),
      }
    case 'tool_result':
      if (!typed.toolCall) return state
      return {
        ...state,
        toolCalls: upsertToolCall(state.toolCalls, typed.toolCall),
      }
    case 'permission_requested':
      if (!typed.permission) return { ...state, status: 'waiting_permission' }
      return {
        ...state,
        status: 'waiting_permission',
        permissions: upsertPermission(state.permissions, typed.permission),
        toolCalls: typed.toolCall
          ? upsertToolCall(state.toolCalls, typed.toolCall)
          : state.toolCalls,
      }
    case 'run_failed':
      return {
        ...state,
        status: 'failed',
        error: typed.error ?? 'Agent run failed',
      }
    case 'run_completed':
      return { ...state, status: 'completed', error: null }
    case 'input_injected':
      if (state.sessionId) {
        void useAgentSessionStore.getState().loadInputQueue(state.sessionId)
      }
      return {
        ...state,
        status: 'running',
        streamingThinking: '',
        streamingText: '',
      }
    case 'done':
      if (state.status === 'waiting_permission') return state
      return { ...state, status: 'completed', error: null }
    default:
      return state.status === 'idle' ? { ...state, status: 'running' } : state
  }
}

export function applyGoalLiveEvent(
  state: GoalSessionState,
  event: SessionLiveEvent,
): GoalSessionState {
  switch (event.type) {
    case 'thought_delta':
      return {
        ...state,
        status: state.status === 'waiting_permission' ? state.status : 'running',
        streamingThinking: state.streamingThinking + event.delta,
      }
    case 'message_delta':
      return {
        ...state,
        status: state.status === 'waiting_permission' ? state.status : 'running',
        streamingText: state.streamingText + event.delta,
      }
    case 'tool_call':
      return {
        ...state,
        status: 'running',
        toolCalls: upsertToolCall(state.toolCalls, event.toolCall),
      }
    case 'tool_result':
      return {
        ...state,
        toolCalls: upsertToolCall(state.toolCalls, event.toolCall),
      }
    case 'step_started':
      return { ...state, status: 'running' }
    default:
      return state
  }
}

export function applyGoalSessionPatch(
  state: GoalSessionState,
  patch: Record<string, unknown>,
): GoalSessionState {
  const next = { ...state }
  if (patch.status === 'running') {
    next.status = 'running'
    next.error = null
  }
  if (patch.status === 'waiting_permission') {
    next.status = 'waiting_permission'
  }
  if (patch.status === 'completed') {
    next.status = 'completed'
    next.error = null
  }
  if (patch.status === 'failed' || patch.status === 'interrupted' || patch.status === 'cancelled') {
    next.status = 'failed'
  }
  if (typeof patch.blockedReason === 'string') {
    next.error = patch.blockedReason
  }
  if (typeof patch.title === 'string') {
    next.title = patch.title.trim() || null
  }
  return next
}

export function isGoalSessionActive(status: GoalSessionStatus): boolean {
  return status === 'running' || status === 'waiting_permission'
}

export async function streamGoalAgentTurn(
  sessionId: string,
  input: { message?: string; model?: string | null },
  onChunk: (chunk: unknown) => void,
  options?: { continue?: boolean },
): Promise<void> {
  const body = {
    ...(input.message ? { message: input.message } : {}),
    ...(input.model ? { model: input.model } : {}),
  }
  if (options?.continue) {
    await agentRuntimeApi.resumeStream(sessionId, body, onChunk)
  } else {
    await agentRuntimeApi.streamTurn(sessionId, body, onChunk)
  }
}

export async function fetchGoalSessionPermissions(sessionId: string): Promise<PermissionDecision[]> {
  const { items } = await agentRuntimeApi.listPermissions(sessionId)
  return items
}
