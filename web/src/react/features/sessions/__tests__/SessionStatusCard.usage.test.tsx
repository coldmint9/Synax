import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
vi.mock('../../../../hooks/useLocale', () => ({ useLocale: () => ({ locale: 'zh' }) }))
import { SessionStatusCard } from '../SessionWorkspace'
import type { SessionStats } from '../../../../lib/api/agentRuntime'

const stats: SessionStats = {
  status: 'interrupted', tokenUsage: { input: 403292, output: 275308, total: 403292 },
  context: { inputTokens: 403292, requestId: 'latest', measuredAt: '2026-09-13T13:00:00Z', latestRequestUsageAvailable: false },
  contextLimit: 1000000, contextUsedPercent: 40, toolCallCount: 132, runningDuration: 5000, activeSubAgentCount: 0,
  work: { id: 'work', status: 'closing', remaining: [], reason: 'Tasks done' },
  usage: { self: { input: 6252715, output: 275308, total: 6528023, reasoning: 258078, cacheRead: 4506496 }, tree: { input: 6900000, output: 300000, total: 7200000, reasoning: 280000, cacheRead: 4600000 } },
  coverage: { self: { requests: 39, recorded: 31, missing: 8, complete: false }, tree: { requests: 71, recorded: 63, missing: 8, complete: false } },
}
describe('SessionStatusCard usage boundaries', () => {
  it('uses live Session status rather than a late running stats response', () => {
    render(<SessionStatusCard stats={{ ...stats, status: 'running' }} status="completed" steps={[]} todos={[]} />)
    expect(screen.getByText('completed')).toBeTruthy()
    expect(screen.queryByText('running')).toBeNull()
    expect(screen.getByText('0:05')).toBeTruthy()
  })

  it('does not display a guessed context window for a CLI that has not reported one', () => {
    render(<SessionStatusCard stats={{ ...stats, context: { inputTokens: null, requestId: null, measuredAt: null, latestRequestUsageAvailable: false }, contextLimitKnown: false }} steps={[]} todos={[]} />)
    expect(screen.getByText(/未知.*context/)).toBeTruthy()
    expect(screen.queryByText('40%')).toBeNull()
  })

  it('separates current context, session/tree cumulative usage and incomplete coverage', () => {
    render(<SessionStatusCard stats={stats} steps={[]} todos={[]} />)
    expect(screen.getByText('当前上下文')).toBeTruthy()
    expect(screen.getByText('本会话累计')).toBeTruthy()
    expect(screen.getByText('含子 Agent')).toBeTruthy()
    expect(screen.getByText('记录不完整：8 个请求缺少 usage')).toBeTruthy()
    expect(screen.getByText(/确认交付或剩余工作/)).toBeTruthy()
    expect(screen.getByText('上下文显示最近一次可用记录')).toBeTruthy()
  })
  it('does not add time for a stale running step after the run has ended', () => {
    render(<SessionStatusCard stats={stats} steps={[{ id: 'stale', runId: 'ended', sessionId: 'session', index: 1, status: 'running', model: null, startedAt: '2020-01-01T00:00:00Z', completedAt: null, finishReason: null, metadata: {} }]} todos={[]} />)
    expect(screen.getByText('0:05')).toBeTruthy()
  })
})
