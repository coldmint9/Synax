import { beforeEach, describe, expect, it } from 'vitest'
import { agentSessionRuntime } from '../session-runtime.js'
import { agentRuntimeStore } from '../session-store.js'
import { explorerSessionInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js'

describe('getSessionStats runningDuration', () => {
  beforeEach(resetAgentRuntimeFixtures)

  it('sums completed agent turn durations instead of session wall clock', () => {
    const session = agentSessionRuntime.create(explorerSessionInput)
    const run = agentRuntimeStore.appendRun({
      id: 'run-1',
      sessionId: session.id,
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:05:00.000Z',
      triggerMessageId: null,
      currentStep: 2,
      stopReason: null,
      model: null,
      metadata: {},
    })

    agentRuntimeStore.appendRunStep({
      id: 'step-1',
      runId: run.id,
      sessionId: session.id,
      index: 1,
      status: 'completed',
      model: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:30.000Z',
      finishReason: 'stop',
      metadata: {},
    })
    agentRuntimeStore.appendRunStep({
      id: 'step-2',
      runId: run.id,
      sessionId: session.id,
      index: 2,
      status: 'completed',
      model: null,
      startedAt: '2026-01-01T00:02:00.000Z',
      completedAt: '2026-01-01T00:03:45.000Z',
      finishReason: 'stop',
      metadata: {},
    })

    const stats = agentRuntimeStore.getSessionStats(session.id)
    expect(stats.runningDuration).toBe(90_000 + 105_000)
  })

  it('aggregates ACP usage and context window size from step metadata', () => {
    const session = agentSessionRuntime.create(explorerSessionInput)
    const run = agentRuntimeStore.appendRun({
      id: 'run-acp-usage',
      sessionId: session.id,
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:02:00.000Z',
      triggerMessageId: null,
      currentStep: 1,
      stopReason: 'end_turn',
      model: 'cursor-acp/default',
      metadata: { engine: 'acp' },
    })

    agentRuntimeStore.appendRunStep({
      id: 'step-acp-usage',
      runId: run.id,
      sessionId: session.id,
      index: 1,
      status: 'completed',
      model: 'cursor-acp/default',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:02:00.000Z',
      finishReason: 'end_turn',
      metadata: {
        engine: 'acp',
        usage: {
          inputTokens: 50_000,
          outputTokens: 1_200,
          contextWindowSize: 200_000,
          source: 'acp',
        },
      },
    })

    const stats = agentRuntimeStore.getSessionStats(session.id)
    expect(stats.tokenUsage).toEqual({ input: 50_000, output: 1_200, total: 50_000 })
    expect(stats.contextLimit).toBe(200_000)
    expect(stats.contextUsedPercent).toBe(25)
  })
})
