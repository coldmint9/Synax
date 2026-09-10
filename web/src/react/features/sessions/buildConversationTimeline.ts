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
  | {
      id: string
      kind: 'work_log'
      createdAt: string
      label: string
      turns: InterleavedTurn[]
      stats: WorkLogStats
    }

export interface WorkLogStats {
  stepCount: number
  toolCallCount: number
  thinkingChars: number
  elapsedMs: number
}

/**
 * Runs shorter than this stay as plain turns: folding two steps saves nothing
 * and costs the reader their place in the transcript.
 */
export const WORK_LOG_MIN_TURNS = 3

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

interface TimelineItem {
  timestamp: number
  entry: ConversationTimelineEntry
}

function buildTimelineItems(
  steps: AgentRunStep[],
  agentTurns: InterleavedTurn[],
  userEntries: UserMessageTimelineEntry[],
): TimelineItem[] {
  const stepById = new Map(steps.map(step => [step.id, step]))
  const items: TimelineItem[] = []

  for (const user of userEntries) {
    items.push({
      timestamp: toTimestamp(user.createdAt),
      entry: { kind: 'user', ...user },
    })
  }

  for (const turn of agentTurns) {
    const step = stepById.get(turn.stepId)
    items.push({
      timestamp: step ? toTimestamp(step.startedAt) : 0,
      entry: agentEntry(turn, step),
    })
  }

  items.sort((a, b) => a.timestamp - b.timestamp)
  return items
}

/** A turn whose only output is reasoning/tool activity — nothing the reader asked for. */
function isWorkOnlyTurn(turn: InterleavedTurn): boolean {
  return turn.blocks.every(block => block.type !== 'text' && block.type !== 'sub_session')
}

function turnToolCallCount(turn: InterleavedTurn): number {
  let count = 0
  for (const block of turn.blocks) {
    if (block.type === 'tool_call') count += 1
    if (block.type === 'tool_call_group') count += block.calls.length
  }
  return count
}

function turnThinkingChars(turn: InterleavedTurn): number {
  return turn.blocks.reduce(
    (total, block) => (block.type === 'thinking' ? total + block.content.length : total),
    0,
  )
}

function workLogEntry(
  turns: InterleavedTurn[],
  stepById: Map<string, AgentRunStep>,
): ConversationTimelineEntry {
  const first = stepById.get(turns[0].stepId)
  const last = stepById.get(turns[turns.length - 1].stepId)
  const startMs = first ? toTimestamp(first.startedAt) : 0
  const endMs = last ? toTimestamp(last.completedAt ?? last.startedAt) : startMs

  return {
    // Anchored to the first step so the id stays stable while the run grows.
    id: `work-log-${turns[0].stepId}`,
    kind: 'work_log',
    createdAt: first?.startedAt ?? turns[0].stepId,
    label: `Work log · ${turns.length} steps`,
    turns,
    stats: {
      stepCount: turns.length,
      toolCallCount: turns.reduce((total, turn) => total + turnToolCallCount(turn), 0),
      thinkingChars: turns.reduce((total, turn) => total + turnThinkingChars(turn), 0),
      elapsedMs: Math.max(0, endMs - startMs),
    },
  }
}

/**
 * Fold runs of activity-only turns into a single work-log row.
 *
 * A long agent run spends most of its steps on think → tool → think loops that
 * produce no answer: the measured local session has 82 steps, 81 of them
 * activity-only. Rendering one entry per step makes the transcript long and
 * expensive to lay out; folding them keeps the answer turns (and every user
 * message) exactly where they were, with one collapsible row in between.
 */
function foldWorkLogs(
  items: TimelineItem[],
  stepById: Map<string, AgentRunStep>,
  minTurns: number,
): TimelineItem[] {
  const folded: TimelineItem[] = []
  let index = 0

  while (index < items.length) {
    const entry = items[index].entry
    if (entry.kind !== 'agent' || !isWorkOnlyTurn(entry.turn)) {
      folded.push(items[index])
      index += 1
      continue
    }

    const turns: InterleavedTurn[] = []
    let end = index
    while (end < items.length) {
      const candidate = items[end].entry
      if (candidate.kind !== 'agent' || !isWorkOnlyTurn(candidate.turn)) break
      turns.push(candidate.turn)
      end += 1
    }

    if (turns.length < minTurns) {
      for (let cursor = index; cursor < end; cursor += 1) folded.push(items[cursor])
    } else {
      folded.push({ timestamp: items[index].timestamp, entry: workLogEntry(turns, stepById) })
    }
    index = end
  }

  return folded
}

export function buildConversationTimeline(
  runs: AgentRun[],
  steps: AgentRunStep[],
  messages: AgentRuntimeMessage[],
  toolCalls: ToolCallRecord[],
  childSessions?: AgentSession[],
  options?: { excludeStepId?: string | null; session?: AgentSession; foldWorkRuns?: boolean },
): ConversationTimelineEntry[] {
  const filteredSteps = options?.excludeStepId
    ? steps.filter(step => step.id !== options.excludeStepId)
    : steps

  const agentTurns = buildInterleavedTurns(filteredSteps, toolCalls, messages, childSessions)
  const userEntries = buildUserMessageEntries(messages, options?.session)

  if (userEntries.length === 0 && agentTurns.length === 0) return []

  const items = buildTimelineItems(filteredSteps, agentTurns, userEntries)
  if (options?.foldWorkRuns === false) return items.map(item => item.entry)

  const stepById = new Map(filteredSteps.map(step => [step.id, step]))
  return foldWorkLogs(items, stepById, WORK_LOG_MIN_TURNS).map(item => item.entry)
}

export function sessionEntryDomId(entryId: string): string {
  return `session-entry-${entryId}`
}
