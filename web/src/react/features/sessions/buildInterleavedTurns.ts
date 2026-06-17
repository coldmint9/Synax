import type { AgentRunStep, AgentRuntimeMessage, AgentSession, ToolCallRecord } from '../../../lib/api/agentRuntime'

export interface ToolCallView {
  id: string
  toolId: string
  inputSummary: string
  outputSummary: string
  status: string
  category: string
  duration: string | null
  mutability: string
}

export type TurnContentBlock =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; call: ToolCallView }
  | { type: 'tool_call_group'; calls: ToolCallView[] }
  | { type: 'sub_session'; session: AgentSession }
  | { type: 'context_compacted'; originalTokens: number; compressedTokens: number; messageCount: number }

export interface InterleavedTurn {
  stepId: string
  index: number
  status: string
  duration: string | null
  blocks: TurnContentBlock[]
}

function computeDuration(step: AgentRunStep): string | null {
  if (!step.completedAt) return null
  const ms = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function computeToolDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function groupParallelToolCalls(blocks: TurnContentBlock[]): TurnContentBlock[] {
  const result: TurnContentBlock[] = []
  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]
    if (block.type === 'tool_call') {
      const group: ToolCallView[] = [block.call]
      let j = i + 1
      while (j < blocks.length && blocks[j].type === 'tool_call') {
        group.push((blocks[j] as { type: 'tool_call'; call: ToolCallView }).call)
        j++
      }
      if (group.length > 1) {
        result.push({ type: 'tool_call_group', calls: group })
      } else {
        result.push(block)
      }
      i = j
    } else {
      result.push(block)
      i++
    }
  }
  return result
}

function mergeConsecutiveBlocks(blocks: TurnContentBlock[]): TurnContentBlock[] {
  const result: TurnContentBlock[] = []
  for (const block of blocks) {
    const prev = result[result.length - 1]
    if (block.type === 'text' && prev?.type === 'text') {
      result[result.length - 1] = { type: 'text', content: prev.content + '\n' + block.content }
    } else if (block.type === 'thinking' && prev?.type === 'thinking') {
      result[result.length - 1] = { type: 'thinking', content: prev.content + '\n' + block.content }
    } else {
      result.push(block)
    }
  }
  return result
}

export function buildInterleavedTurns(
  steps: AgentRunStep[],
  toolCallRecords: ToolCallRecord[],
  messages: AgentRuntimeMessage[],
  childSessions?: AgentSession[],
): InterleavedTurn[] {
  const sorted = [...steps].sort((a, b) => a.index - b.index)

  const messagesByStep = new Map<string, AgentRuntimeMessage[]>()
  for (const message of messages) {
    if (!message.stepId || message.role !== 'assistant') continue
    const bucket = messagesByStep.get(message.stepId)
    if (bucket) bucket.push(message)
    else messagesByStep.set(message.stepId, [message])
  }

  const toolCallsByStep = new Map<string, ToolCallRecord[]>()
  for (const toolCall of toolCallRecords) {
    const bucket = toolCallsByStep.get(toolCall.stepId)
    if (bucket) bucket.push(toolCall)
    else toolCallsByStep.set(toolCall.stepId, [toolCall])
  }

  return sorted.map(step => {
    const items: Array<{ timestamp: number; block: TurnContentBlock }> = []

    const stepMessages = messagesByStep.get(step.id) ?? []
    for (const msg of stepMessages) {
      const isThinking = msg.metadata?.type === 'thinking' || msg.metadata?.kind === 'thought'
      items.push({
        timestamp: new Date(msg.createdAt).getTime(),
        block: isThinking
          ? { type: 'thinking', content: msg.content }
          : { type: 'text', content: msg.content },
      })
    }

    const stepToolCalls = toolCallsByStep.get(step.id) ?? []
    for (const tc of stepToolCalls) {
      items.push({
        timestamp: new Date(tc.startedAt).getTime(),
        block: {
          type: 'tool_call',
          call: {
            id: tc.id,
            toolId: tc.toolId,
            inputSummary: tc.inputSummary ?? '',
            outputSummary: tc.outputSummary ?? '',
            status: tc.status,
            category: tc.category,
            duration: tc.endedAt ? computeToolDuration(tc.startedAt, tc.endedAt) : null,
            mutability: tc.mutability,
          },
        },
      })

      if (tc.mutability === 'task' && childSessions) {
        const child = childSessions.find(cs =>
          cs.parentSessionId === step.sessionId &&
          Math.abs(new Date(cs.createdAt).getTime() - new Date(tc.startedAt).getTime()) < 3000,
        )
        if (child) {
          items.push({
            timestamp: new Date(child.createdAt).getTime(),
            block: { type: 'sub_session', session: child },
          })
        }
      }
    }

    items.sort((a, b) => a.timestamp - b.timestamp)
    const merged = mergeConsecutiveBlocks(items.map(i => i.block))
    const blocks = groupParallelToolCalls(merged)

    return {
      stepId: step.id,
      index: step.index,
      status: step.status,
      duration: computeDuration(step),
      blocks,
    }
  })
}
