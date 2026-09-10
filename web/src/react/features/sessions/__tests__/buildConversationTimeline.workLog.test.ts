import { describe, expect, it } from 'vitest'
import { WORK_LOG_MIN_TURNS, buildConversationTimeline } from '../buildConversationTimeline'
import type { AgentRun, AgentRunStep, AgentRuntimeMessage, ToolCallRecord } from '../../../../lib/api/agentRuntime'

const SESSION_ID = 'sess-1'
const RUN_ID = 'run-1'

function makeStep(index: number, status: AgentRunStep['status'] = 'completed'): AgentRunStep {
  const minute = String(index).padStart(2, '0')
  return {
    id: `step-${index}`,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    index,
    status,
    model: 'test-model',
    startedAt: `2026-01-01T00:${minute}:00.000Z`,
    completedAt: `2026-01-01T00:${minute}:30.000Z`,
    finishReason: status === 'completed' ? 'tool-calls' : null,
    metadata: {},
  }
}

function thinking(stepIndex: number, content = `thinking ${stepIndex}`): AgentRuntimeMessage {
  return {
    id: `msg-think-${stepIndex}`,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    stepId: `step-${stepIndex}`,
    role: 'assistant',
    content,
    metadata: { type: 'thinking' },
    createdAt: `2026-01-01T00:${String(stepIndex).padStart(2, '0')}:05.000Z`,
  }
}

function answer(stepIndex: number, content = 'here is the answer'): AgentRuntimeMessage {
  return {
    id: `msg-text-${stepIndex}`,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    stepId: `step-${stepIndex}`,
    role: 'assistant',
    content,
    metadata: {},
    createdAt: `2026-01-01T00:${String(stepIndex).padStart(2, '0')}:20.000Z`,
  }
}

function toolCall(stepIndex: number): ToolCallRecord {
  return {
    id: `tool-${stepIndex}`,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    stepId: `step-${stepIndex}`,
    toolId: 'bash',
    category: 'shell',
    mutability: 'read',
    inputSummary: `cmd ${stepIndex}`,
    outputSummary: 'ok',
    status: 'completed',
    startedAt: `2026-01-01T00:${String(stepIndex).padStart(2, '0')}:10.000Z`,
    endedAt: `2026-01-01T00:${String(stepIndex).padStart(2, '0')}:12.000Z`,
    error: null,
  }
}

function build(steps: AgentRunStep[], messages: AgentRuntimeMessage[], toolCalls: ToolCallRecord[], foldWorkRuns?: boolean) {
  const run: AgentRun = {
    id: RUN_ID,
    sessionId: SESSION_ID,
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T01:00:00.000Z',
    triggerMessageId: 'msg-user',
    currentStep: steps.length,
    stopReason: null,
    model: null,
    metadata: {},
  }
  return buildConversationTimeline(run ? [run] : [], steps, messages, toolCalls, undefined, { foldWorkRuns })
}

describe('buildConversationTimeline work logs', () => {
  it('folds a run of activity-only turns into one entry', () => {
    const steps = [1, 2, 3, 4].map(index => makeStep(index))
    const messages = steps.map(step => thinking(step.index))
    const toolCalls = steps.map(step => toolCall(step.index))

    const timeline = build(steps, messages, toolCalls)

    expect(timeline).toHaveLength(1)
    const entry = timeline[0]
    expect(entry.kind).toBe('work_log')
    if (entry.kind !== 'work_log') throw new Error('expected work log')
    expect(entry.turns).toHaveLength(4)
    expect(entry.stats.stepCount).toBe(4)
    expect(entry.stats.toolCallCount).toBe(4)
    expect(entry.stats.thinkingChars).toBe('thinking 1thinking 2thinking 3thinking 4'.length)
    // step-1 starts at 00:01:00, step-4 completes at 00:04:30
    expect(entry.stats.elapsedMs).toBe(210_000)
    expect(entry.id).toBe('work-log-step-1')
  })

  it('leaves short runs expanded', () => {
    const steps = [1, 2].map(index => makeStep(index))
    const messages = steps.map(step => thinking(step.index))

    const timeline = build(steps, messages, [])

    expect(timeline).toHaveLength(2)
    expect(timeline.every(entry => entry.kind === 'agent')).toBe(true)
  })

  it('breaks the run where a turn answers the user', () => {
    const steps = [1, 2, 3, 4, 5, 6].map(index => makeStep(index))
    const messages = [
      thinking(1), thinking(2), thinking(3),
      thinking(4), answer(4),
      thinking(5), thinking(6),
    ]

    const timeline = build(steps, messages, [])

    // 1-3 fold, 4 stays as the answer, 5-6 are too short to fold.
    expect(timeline.map(entry => entry.kind)).toEqual(['work_log', 'agent', 'agent', 'agent'])
  })

  it('breaks the run at a user message', () => {
    const steps = [1, 2, 3, 4, 5, 6, 7].map(index => makeStep(index))
    const messages = [
      thinking(1), thinking(2), thinking(3),
      thinking(4),
      {
        id: 'msg-user-2',
        sessionId: SESSION_ID,
        runId: RUN_ID,
        stepId: null,
        role: 'user' as const,
        content: 'keep going',
        metadata: {},
        // Lands after step-4 started and before step-5 does.
        createdAt: '2026-01-01T00:04:40.000Z',
      },
      thinking(5), thinking(6), thinking(7),
    ]

    const timeline = build(steps, messages, [])

    expect(timeline.map(entry => entry.kind)).toEqual(['work_log', 'user', 'work_log'])
  })

  it('keeps every turn when the switch is off', () => {
    const steps = [1, 2, 3, 4].map(index => makeStep(index))
    const messages = steps.map(step => thinking(step.index))

    const timeline = build(steps, messages, [], false)

    expect(timeline).toHaveLength(4)
    expect(timeline.every(entry => entry.kind === 'agent')).toBe(true)
  })

  it('keeps the work-log id stable while the run grows', () => {
    const steps = [1, 2, 3, 4, 5].map(index => makeStep(index))
    const messages = steps.map(step => thinking(step.index))

    const before = build(steps.slice(0, 4), messages.slice(0, 4), [])
    const after = build(steps, messages, [])

    expect(before[0].id).toBe(after[0].id)
  })

  it('never folds the live step', () => {
    const steps = [1, 2, 3, 4].map(index => makeStep(index))
    const messages = steps.map(step => thinking(step.index))

    const timeline = buildConversationTimeline(
      [],
      steps,
      messages,
      [],
      undefined,
      { excludeStepId: 'step-4' },
    )

    expect(timeline).toHaveLength(1)
    expect(timeline[0].kind).toBe('work_log')
    if (timeline[0].kind !== 'work_log') throw new Error('expected work log')
    expect(timeline[0].turns.map(turn => turn.stepId)).toEqual(['step-1', 'step-2', 'step-3'])
  })

  it('needs at least WORK_LOG_MIN_TURNS turns to fold', () => {
    const steps = Array.from({ length: WORK_LOG_MIN_TURNS }, (_, i) => makeStep(i + 1))
    const messages = steps.map(step => thinking(step.index))

    expect(build(steps, messages, [])[0].kind).toBe('work_log')
    expect(build(steps.slice(1), messages.slice(1), [])[0].kind).toBe('agent')
  })
})
