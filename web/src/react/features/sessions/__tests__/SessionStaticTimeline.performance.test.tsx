import { act, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionStaticTimeline } from '../SessionStaticTimeline'
import { useAgentSessionStore as store } from '../agentSessionStore'
import { EMPTY_STREAMING_BUFFERS } from '../streamingLiveBlocks'
import type { AgentRuntimeMessage } from '../../../../lib/api/agentRuntime'

const renders = vi.hoisted(() => vi.fn())
vi.mock('../TimelineEntryView', () => ({ TimelineEntryView: ({ entry }: { entry: { id: string } }) => { renders(entry.id); return <div>{entry.id}</div> } }))
vi.mock('../TimelineLazyEntry', () => ({ TimelineLazyEntry: ({ children }: { children: React.ReactNode }) => children, estimateEntryHeight: () => 100 }))
afterEach(() => { store.setState(store.getInitialState()); vi.clearAllMocks() })

it('does not rerender historical message bodies for streaming token deltas', () => {
  store.setState({ ...store.getInitialState(), streamingStepId: 'live' })
  render(<SessionStaticTimeline unifiedLive runs={[]} steps={[]} messages={[{ id: 'history', sessionId: 's', role: 'user', content: 'History', createdAt: '2026-01-01T00:00:00Z' } as AgentRuntimeMessage]} toolCalls={[]} excludeStepId="live" />)
  const historicalCalls = renders.mock.calls.filter(([id]) => id.includes('history')).length
  expect(historicalCalls).toBeGreaterThan(0)
  act(() => store.setState({ streamingLive: { ...EMPTY_STREAMING_BUFFERS, pendingText: 'new tokens' } }))
  expect(renders.mock.calls.filter(([id]) => id.includes('history'))).toHaveLength(historicalCalls)
})
