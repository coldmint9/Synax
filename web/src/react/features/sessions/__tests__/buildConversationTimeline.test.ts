import { describe, it, expect } from 'vitest'
import { buildConversationTimeline, buildUserMessageEntries } from '../buildConversationTimeline'
import type { AgentRun, AgentRunStep, AgentRuntimeMessage, AgentSession, ToolCallRecord } from '../../../../lib/api/agentRuntime'

const SESSION_ID = 'sess-1'
const RUN_ID = 'run-1'
const STEP_ID = 'step-1'

function makeStep(partial: Partial<AgentRunStep> = {}): AgentRunStep {
  return {
    id: STEP_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    index: 1,
    status: 'completed',
    model: 'test-model',
    startedAt: '2026-01-01T00:00:02.000Z',
    completedAt: '2026-01-01T00:00:05.000Z',
    finishReason: 'tool-calls',
    metadata: {},
    ...partial,
  }
}

function makeRun(partial: Partial<AgentRun> = {}): AgentRun {
  return {
    id: RUN_ID,
    sessionId: SESSION_ID,
    status: 'completed',
    startedAt: '2026-01-01T00:00:01.000Z',
    completedAt: '2026-01-01T00:00:06.000Z',
    triggerMessageId: 'msg-user',
    currentStep: 1,
    stopReason: null,
    model: null,
    metadata: {},
    ...partial,
  }
}

function makeMessage(partial: Partial<AgentRuntimeMessage>): AgentRuntimeMessage {
  return {
    id: 'msg-user',
    sessionId: SESSION_ID,
    runId: RUN_ID,
    stepId: null,
    role: 'user',
    content: 'Fix the wiki search module',
    metadata: {},
    createdAt: '2026-01-01T00:00:01.000Z',
    ...partial,
  }
}

describe('buildConversationTimeline', () => {
  it('places user input before the linked agent turn', () => {
    const timeline = buildConversationTimeline(
      [makeRun()],
      [makeStep()],
      [
        makeMessage({
          id: 'msg-user',
          metadata: { source: 'turn_request' },
          createdAt: '2026-01-01T00:00:01.000Z',
        }),
        {
          id: 'msg-assistant',
          sessionId: SESSION_ID,
          runId: RUN_ID,
          stepId: STEP_ID,
          role: 'assistant',
          content: 'I will inspect the code.',
          metadata: {},
          createdAt: '2026-01-01T00:00:03.000Z',
        },
      ],
      [],
    )

    expect(timeline.map(entry => entry.kind)).toEqual(['user', 'agent'])
    if (timeline[0]?.kind === 'user') {
      expect(timeline[0].content).toBe('Fix the wiki search module')
    }
  })

  it('orders multiple user turns across runs', () => {
    const timeline = buildConversationTimeline(
      [
        makeRun({ id: 'run-1', triggerMessageId: 'msg-1', startedAt: '2026-01-01T00:00:01.000Z' }),
        makeRun({ id: 'run-2', triggerMessageId: 'msg-2', startedAt: '2026-01-01T00:00:10.000Z' }),
      ],
      [
        makeStep({ id: 'step-1', runId: 'run-1', index: 1, startedAt: '2026-01-01T00:00:02.000Z' }),
        makeStep({ id: 'step-2', runId: 'run-2', index: 1, startedAt: '2026-01-01T00:00:11.000Z' }),
      ],
      [
        makeMessage({ id: 'msg-1', content: 'First ask', metadata: { source: 'turn_request' }, createdAt: '2026-01-01T00:00:01.000Z' }),
        makeMessage({ id: 'msg-2', content: 'Follow up', metadata: { source: 'turn_request' }, createdAt: '2026-01-01T00:00:10.000Z' }),
      ],
      [],
    )

    expect(timeline.map(entry => entry.kind)).toEqual(['user', 'agent', 'user', 'agent'])
    if (timeline[2]?.kind === 'user') {
      expect(timeline[2].content).toBe('Follow up')
    }
  })

  it('falls back to timestamp ordering when runs are missing', () => {
    const timeline = buildConversationTimeline(
      [],
      [makeStep()],
      [makeMessage({ id: 'msg-user', metadata: { source: 'turn_request' }, createdAt: '2026-01-01T00:00:01.000Z' })],
      [],
    )

    expect(timeline.map(entry => entry.kind)).toEqual(['user', 'agent'])
  })

  it('excludes session_prompt user messages from the timeline', () => {
    const timeline = buildConversationTimeline(
      [makeRun({ triggerMessageId: 'msg-prompt' })],
      [makeStep()],
      [
        makeMessage({
          id: 'msg-prompt',
          content: 'You are a helpful coding agent.',
          metadata: { source: 'session_prompt' },
          createdAt: '2026-01-01T00:00:01.000Z',
        }),
      ],
      [],
    )

    expect(timeline.map(entry => entry.kind)).toEqual(['agent'])
  })
})

describe('buildUserMessageEntries', () => {
  it('returns only turn_request user messages in order', () => {
    const entries = buildUserMessageEntries([
      makeMessage({
        id: 'msg-prompt',
        content: 'System instructions',
        metadata: { source: 'session_prompt' },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
      makeMessage({
        id: 'msg-1',
        content: 'First ask',
        metadata: { source: 'turn_request' },
        createdAt: '2026-01-01T00:00:02.000Z',
      }),
      makeMessage({
        id: 'msg-2',
        content: 'Follow up',
        metadata: { source: 'turn_request' },
        createdAt: '2026-01-01T00:00:10.000Z',
      }),
    ])

    expect(entries.map(entry => entry.id)).toEqual(['msg-1', 'msg-2'])
    expect(entries[1]?.label).toBe('Follow up')
  })

  it('includes goalContent as the first user bubble when initial run used session_prompt', () => {
    const session: AgentSession = {
      id: SESSION_ID,
      projectId: 'proj-1',
      parentSessionId: null,
      childSessionIds: [],
      nodeId: null,
      profileId: 'goal',
      status: 'completed',
      title: '你好',
      prompt: 'Long built system prompt for the agent.',
      contextSnapshotId: null,
      thinkingMode: 'standard',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:05.000Z',
      completedAt: '2026-01-01T00:00:05.000Z',
      resultSummary: null,
      blockedReason: null,
      skillIds: [],
      activeRunId: null,
      pendingResumeToken: null,
      model: null,
      sessionMetadata: { goalContent: '你好', source: 'goal-dock' },
    }

    const entries = buildUserMessageEntries([
      makeMessage({
        id: 'msg-prompt',
        content: session.prompt,
        metadata: { source: 'session_prompt' },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
    ], session)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe('你好')
    expect(entries[0]?.id).toBe('user-input-sess-1')
  })
})
