import type { AgentRun, AgentRunStep, AgentRuntimeMessage, AgentSession, ToolCallRecord } from '../../../lib/api/agentRuntime'
import { buildInterleavedTurns, type InterleavedTurn } from './buildInterleavedTurns'

export type ConversationTimelineEntry =
  | {
      id: string
      kind: 'user'
      createdAt: string
      label: string
      content: string
    }
  | {
      id: string
      kind: 'agent'
      createdAt: string
      label: string
      turn: InterleavedTurn
    }

function truncate(text: string, max = 48): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max - 1)}…`
}

function toTimestamp(value: string): number {
  return new Date(value).getTime()
}

export function isSessionPromptUserMessage(message: AgentRuntimeMessage): boolean {
  return message.role === 'user' && message.metadata?.source === 'session_prompt'
}

export function sessionUserInputEntryId(sessionId: string): string {
  return `user-input-${sessionId}`
}

export function extractSessionUserInput(session: AgentSession | undefined): string | null {
  if (!session) return null
  const goalContent = session.sessionMetadata?.goalContent
  if (typeof goalContent === 'string' && goalContent.trim()) {
    return goalContent.trim()
  }
  return null
}

function isTimelineUserMessage(message: AgentRuntimeMessage): boolean {
  return message.role === 'user' && message.content.trim() !== '' && !isSessionPromptUserMessage(message)
}

export type UserMessageTimelineEntry = {
  id: string
  createdAt: string
  label: string
  content: string
}

function userTimelineEntry(message: AgentRuntimeMessage): UserMessageTimelineEntry {
  return {
    id: message.id,
    createdAt: message.createdAt,
    label: truncate(message.content),
    content: message.content,
  }
}

export function buildUserMessageEntries(
  messages: AgentRuntimeMessage[],
  session?: AgentSession,
): UserMessageTimelineEntry[] {
  const fromMessages = messages
    .filter(isTimelineUserMessage)
    .sort((a, b) => toTimestamp(a.createdAt) - toTimestamp(b.createdAt))
    .map(userTimelineEntry)

  const userInput = extractSessionUserInput(session)
  if (!userInput || !session) return fromMessages

  const alreadyShown = fromMessages.some(entry => entry.content.trim() === userInput)
  if (alreadyShown) return fromMessages

  const initial: UserMessageTimelineEntry = {
    id: sessionUserInputEntryId(session.id),
    createdAt: session.createdAt,
    label: truncate(userInput),
    content: userInput,
  }

  return [initial, ...fromMessages]
}

function agentEntry(turn: InterleavedTurn, step: AgentRunStep | undefined): ConversationTimelineEntry {
  let label = `Step ${turn.index}`
  for (const block of turn.blocks) {
    if (block.type === 'text' && block.content.trim()) {
      label = truncate(block.content)
      break
    }
    if (block.type === 'tool_call') {
      label = block.call.toolId
      break
    }
    if (block.type === 'tool_call_group' && block.calls[0]) {
      label = block.calls[0].toolId
      break
    }
  }

  return {
    id: turn.stepId,
    kind: 'agent',
    createdAt: step?.startedAt ?? turn.stepId,
    label,
    turn,
  }
}

function buildByTimestamp(
  steps: AgentRunStep[],
  agentTurns: InterleavedTurn[],
  userEntries: UserMessageTimelineEntry[],
): ConversationTimelineEntry[] {
  const items: Array<{ timestamp: number; entry: ConversationTimelineEntry }> = []

  for (const user of userEntries) {
    items.push({
      timestamp: toTimestamp(user.createdAt),
      entry: { kind: 'user', ...user },
    })
  }

  for (const turn of agentTurns) {
    const step = steps.find(item => item.id === turn.stepId)
    items.push({
      timestamp: step ? toTimestamp(step.startedAt) : 0,
      entry: agentEntry(turn, step),
    })
  }

  items.sort((a, b) => a.timestamp - b.timestamp)
  return items.map(item => item.entry)
}

export function buildConversationTimeline(
  runs: AgentRun[],
  steps: AgentRunStep[],
  messages: AgentRuntimeMessage[],
  toolCalls: ToolCallRecord[],
  childSessions?: AgentSession[],
  options?: { excludeStepId?: string | null; session?: AgentSession },
): ConversationTimelineEntry[] {
  const filteredSteps = options?.excludeStepId
    ? steps.filter(step => step.id !== options.excludeStepId)
    : steps

  const agentTurns = buildInterleavedTurns(filteredSteps, toolCalls, messages, childSessions)
  const userEntries = buildUserMessageEntries(messages, options?.session)

  if (userEntries.length === 0 && agentTurns.length === 0) return []

  return buildByTimestamp(filteredSteps, agentTurns, userEntries)
}

export function sessionEntryDomId(entryId: string): string {
  return `session-entry-${entryId}`
}
