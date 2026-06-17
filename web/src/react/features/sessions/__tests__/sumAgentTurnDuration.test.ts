import { describe, expect, it } from 'vitest'
import type { AgentRunStep } from '../../../../lib/api/agentRuntime'
import { sumAgentTurnDurationMs } from '../sumAgentTurnDuration'

function step(partial: Partial<AgentRunStep> & Pick<AgentRunStep, 'id' | 'status' | 'startedAt'>): AgentRunStep {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    index: 1,
    model: null,
    completedAt: null,
    finishReason: null,
    metadata: {},
    ...partial,
  }
}

describe('sumAgentTurnDurationMs', () => {
  it('sums completed steps and includes an in-progress step at now', () => {
    const now = Date.parse('2026-01-01T00:02:30.000Z')
    const total = sumAgentTurnDurationMs([
      step({
        id: 's1',
        status: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:01:00.000Z',
      }),
      step({
        id: 's2',
        status: 'running',
        startedAt: '2026-01-01T00:02:00.000Z',
      }),
    ], now)

    expect(total).toBe(60_000 + 30_000)
  })
})
