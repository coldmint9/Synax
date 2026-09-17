import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionCacheCard } from '../SessionCacheCard'
import type { SessionCacheUsage } from '../../../../lib/api/agentRuntime'
vi.mock('../../../../hooks/useLocale', () => ({ useLocale: () => ({ locale: 'zh' }) }))
const latest = { stepId: 'latest', measuredAt: '2026-09-17T16:00:00Z', model: 'test', unit: 'request' as const, inputTokens: 88169, cacheReadTokens: 0, ratio: 0, status: 'reported' as const, inputSource: 'raw:input_tokens', cacheSource: 'raw:input_tokens_details.cached_tokens' }
const summary = { inputTokens: 4362282, cacheReadTokens: 811648, ratio: 0.17027139947575275, weightedRatio: 811648 / 4362282, empty: 0, aggregated: 0, samples: 75, matched: 75, missing: 0, invalid: 0 }
const cache: SessionCacheUsage = { latest, recent: { ...summary, ratio: 0, samples: 10, matched: 10 }, session: summary, pending: 1, recentSamples: [latest] }

describe('cache statistics evidence', () => {
  it('distinguishes the latest zero hit from the session weighted average and exposes API evidence', () => {
    render(<SessionCacheCard cache={cache} />)
    expect(screen.getByText('17.0%')).toBeTruthy()
    expect(screen.getByText(/Token 加权命中率.*18.6%/)).toBeTruthy()
    expect(screen.getAllByText('0.0%').length).toBeGreaterThan(0)
    expect(screen.getByText('1 个请求等待 usage')).toBeTruthy()
    expect(screen.getByText(/811,648 \/ 4,362,282 tokens/)).toBeTruthy()
    expect(screen.getByText(/raw:input_tokens_details.cached_tokens/)).toBeTruthy()
  })
  it('shows coverage for incomplete data and never falls back to an earlier hit', () => {
    render(<SessionCacheCard cache={{ ...cache, latest: { ...latest, ratio: null, cacheReadTokens: null, status: 'missing' }, recentSamples: [], recent: { ...summary, samples: 10, matched: 8, missing: 2 } }} />)
    expect(screen.getByText('部分数据 8/10')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
  })
  it('renders unavailable data without claiming a zero hit', () => {
    render(<SessionCacheCard />)
    expect(screen.getAllByText('—')).toHaveLength(3)
    expect(screen.queryByText('0.0%')).toBeNull()
  })
})
