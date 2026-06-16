import { agentRuntimeApi } from '../../../../lib/api/agentRuntime'
import type { ToolCallRecord } from '../../../../lib/api/agentRuntime'

export type GoalSessionStatus = 'idle' | 'running' | 'completed' | 'failed'

export interface GoalSessionState {
  status: GoalSessionStatus
  sessionId: string | null
  toolCalls: { tool: string; summary: string }[]
  error: string | null
}

export const initialGoalSessionState: GoalSessionState = {
  status: 'idle',
  sessionId: null,
  toolCalls: [],
  error: null,
}

type StreamChunk = {
  type?: string
  toolCall?: ToolCallRecord
  error?: string
}

export function applyGoalStreamChunk(
  state: GoalSessionState,
  chunk: unknown,
): GoalSessionState {
  if (!chunk || typeof chunk !== 'object') return state
  const typed = chunk as StreamChunk

  switch (typed.type) {
    case 'tool_call':
      if (!typed.toolCall) return { ...state, status: 'running' }
      return {
        ...state,
        status: 'running',
        toolCalls: [
          ...state.toolCalls,
          { tool: typed.toolCall.toolId, summary: typed.toolCall.inputSummary },
        ],
      }
    case 'run_failed':
      return {
        ...state,
        status: 'failed',
        error: typed.error ?? 'Agent run failed',
      }
    case 'run_completed':
    case 'done':
      return { ...state, status: 'completed', error: null }
    default:
      return state.status === 'idle' ? { ...state, status: 'running' } : state
  }
}

export async function streamGoalAgentTurn(
  sessionId: string,
  input: { message?: string; model?: string | null },
  onChunk: (chunk: unknown) => void,
): Promise<void> {
  const body = {
    ...(input.message ? { message: input.message } : {}),
    ...(input.model ? { model: input.model } : {}),
  }
  await agentRuntimeApi.streamTurn(sessionId, body, onChunk)
}
