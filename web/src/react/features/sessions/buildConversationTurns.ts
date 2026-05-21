import type { AgentRunStep, AgentRuntimeMessage, ToolCallRecord } from '../../../lib/api/agentRuntime'

export interface ToolCallView {
  id: string
  toolId: string
  inputSummary: string
  outputSummary: string
  status: string
  category: string
}

export interface ConversationTurn {
  stepId: string
  index: number
  status: string
  duration: string | null
  assistantText: string
  toolCalls: ToolCallView[]
}

function computeDuration(step: AgentRunStep): string | null {
  if (!step.completedAt) return null
  const ms = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function buildConversationTurns(
  steps: AgentRunStep[],
  toolCallRecords: ToolCallRecord[],
  messages: AgentRuntimeMessage[],
): ConversationTurn[] {
  const sorted = [...steps].sort((a, b) => a.index - b.index)

  return sorted.map(step => {
    const assistantMsgs = messages.filter(
      m => m.role === 'assistant' && m.stepId === step.id,
    )
    const assistantText = assistantMsgs.map(m => m.content).join('\n').trim()

    const toolCalls: ToolCallView[] = toolCallRecords
      .filter(tc => tc.stepId === step.id)
      .map(tc => ({
        id: tc.id,
        toolId: tc.toolId,
        inputSummary: tc.inputSummary ?? '',
        outputSummary: tc.outputSummary ?? '',
        status: tc.status,
        category: tc.category,
      }))

    return {
      stepId: step.id,
      index: step.index,
      status: step.status,
      duration: computeDuration(step),
      assistantText,
      toolCalls,
    }
  })
}
