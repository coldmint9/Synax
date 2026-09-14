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
  it('prefers the provider-configured window over the reported usage window', () => {
    const session = agentSessionRuntime.create(explorerSessionInput)
    const run = agentRuntimeStore.appendRun({
      id: 'run-configured-limit',
      sessionId: session.id,
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:02:00.000Z',
      triggerMessageId: null,
      currentStep: 1,
      stopReason: 'stop',
      model: null,
      metadata: { contextLimit: 1_000_000 },
    })

    agentRuntimeStore.appendRunStep({
      id: 'step-configured-limit',
      runId: run.id,
      sessionId: session.id,
      index: 1,
      status: 'completed',
      model: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:02:00.000Z',
      finishReason: 'stop',
      metadata: { usage: { inputTokens: 50_000, outputTokens: 100, contextWindowSize: 200_000 } },
    })

    const stats = agentRuntimeStore.getSessionStats(session.id)
    expect(stats.contextLimit).toBe(1_000_000)
    expect(stats.contextUsedPercent).toBe(5)
  })

  it('honours an explicit configured context limit override', () => {
    const session = agentSessionRuntime.create(explorerSessionInput)
    const stats = agentRuntimeStore.getSessionStats(session.id, { configuredContextLimit: 1_000_000 })
    expect(stats.contextLimit).toBe(1_000_000)
  })
});

describe('usage projection across runs', () => {
  beforeEach(resetAgentRuntimeFixtures)
  it('orders context by real request time, sums cumulative usage and reports missing requests', () => {
    const session = agentSessionRuntime.create(explorerSessionInput)
    const add = (runId: string, index: number, time: string, input?: number) => {
      agentRuntimeStore.appendRun({ id: runId, sessionId: session.id, status: 'interrupted', startedAt: time, completedAt: time, triggerMessageId: null, currentStep: index, stopReason: 'disconnect', model: null, metadata: {} })
      agentRuntimeStore.appendRunStep({ id: `step-${runId}`, runId, sessionId: session.id, index, status: input === undefined ? 'running' : 'completed', startedAt: time, completedAt: null, model: null, finishReason: null,
        metadata: input === undefined ? {} : { usage: { inputTokens: input, outputTokens: 100, reasoningTokens: 80, cachedInputTokens: 50 } } })
    }
    add('old', 17, '2026-09-13T12:00:00Z', 329597)
    add('new', 4, '2026-09-13T13:00:00Z', 403292)
    add('interrupted', 5, '2026-09-13T13:01:00Z')
    const stats = agentRuntimeStore.getSessionStats(session.id)
    expect(stats.context).toMatchObject({ inputTokens: 403292, requestId: 'step-new', latestRequestUsageAvailable: false })
    expect(stats.usage.self).toEqual({ input: 732889, output: 200, reasoning: 160, cacheRead: 100, total: 733089 })
    expect(stats.coverage.self).toEqual({ requests: 3, recorded: 2, missing: 1, complete: false })
    expect(stats.runningDuration).toBe(0)
  })
})
