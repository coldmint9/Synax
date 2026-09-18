import { act, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionStaticTimeline } from '../SessionStaticTimeline'
import { useAgentSessionStore as store } from '../agentSessionStore'
import { EMPTY_STREAMING_BUFFERS } from '../streamingLiveBlocks'
import type { AgentRuntimeMessage, AgentSession } from '../../../../lib/api/agentRuntime'

const renders = vi.hoisted(() => vi.fn())
vi.mock('../TimelineEntryView', () => ({ TimelineEntryView: ({ entry, isWorking }: { entry: { id: string }; isWorking?: boolean }) => { renders(entry.id); return <div data-working={isWorking || undefined}>{entry.id}</div> } }))
vi.mock('../TimelineLazyEntry', () => ({ TimelineLazyEntry: ({ children }: { children: React.ReactNode }) => children, estimateEntryHeight: () => 100 }))
afterEach(() => { act(() => store.setState(store.getInitialState())); vi.clearAllMocks() })

it('keeps only the latest activity working between steps until the session stops', () => {
  const tool = (id: string) => ({ type: 'tool_call' as const, call: {
    id, toolId: 'bash', inputSummary: 'pwd', outputSummary: '/workspace',
    status: 'completed' as const, duration: '10ms',
  } })
  store.setState({ ...store.getInitialState(), streamingCompletedSteps: [{
    stepId: 'finished-step', stepIndex: 1,
    blocks: [tool('first'), { type: 'text', content: 'Continuing' }, tool('latest')],
  }] })
  const props = { unifiedLive: true, runs: [], steps: [], messages: [], toolCalls: [], isRunning: true }
  const { container, rerender } = render(<SessionStaticTimeline {...props} />)
  expect(container.querySelectorAll('[data-working="true"]')).toHaveLength(1)
  expect(container.querySelector('[data-working="true"]')).toHaveTextContent('finished-step:activity:2')

  // A new step can exist before it has emitted any content.
  act(() => store.setState({ streamingStepId: 'next-step' }))
  rerender(<SessionStaticTimeline {...props} excludeStepId="next-step" />)
  expect(container.querySelectorAll('[data-working="true"]')).toHaveLength(1)
  expect(container.querySelector('[data-working="true"]')).toHaveTextContent('finished-step:activity:2')

  act(() => store.setState({ streamingLive: { ...EMPTY_STREAMING_BUFFERS, blocks: [
    { type: 'text', content: 'New instruction' }, tool('next-tool'),
  ] } }))
  expect(container.querySelectorAll('[data-working="true"]')).toHaveLength(1)
  expect(container.querySelector('[data-working="true"]')).toHaveTextContent('next-step:activity:1')

  rerender(<SessionStaticTimeline {...props} excludeStepId="next-step" isRunning={false} />)
  expect(container.querySelector('[data-working="true"]')).toBeNull()
})

it('does not rerender historical message bodies for streaming token deltas', () => {
  store.setState({ ...store.getInitialState(), streamingStepId: 'live' })
  render(<SessionStaticTimeline unifiedLive runs={[]} steps={[]} messages={[{ id: 'history', sessionId: 's', role: 'user', content: 'History', createdAt: '2026-01-01T00:00:00Z' } as AgentRuntimeMessage]} toolCalls={[]} excludeStepId="live" />)
  const historicalCalls = renders.mock.calls.filter(([id]) => id.includes('history')).length
  expect(historicalCalls).toBeGreaterThan(0)
  act(() => store.setState({ streamingLive: { ...EMPTY_STREAMING_BUFFERS, pendingText: 'new tokens' } }))
  expect(renders.mock.calls.filter(([id]) => id.includes('history'))).toHaveLength(historicalCalls)
})


it.each(['live', 'snapshot'])('keeps a durable question after its %s tool activity before HTTP steps arrive', stage => {
  store.setState({ ...store.getInitialState(), interactionState: {
    sessionId: 's', loading: false, error: null, items: [{
      id: 'question', sessionId: 's', stepId: 'ask-step', runId: 'r', toolCallId: 'ask-call',
      kind: 'clarification', revision: 1, status: 'pending', createdAt: '2026-01-01T00:00:00Z', resolvedAt: null, response: null,
      request: { title: 'Scope?', questions: [] },
    }],
  }, ...(stage === 'live' ? { streamingStepId: 'ask-step', streamingLive: { ...EMPTY_STREAMING_BUFFERS, pendingText: 'Need your input' } }
    : { streamingCompletedSteps: [{ stepId: 'ask-step', stepIndex: 1, blocks: [{ type: 'text', content: 'Need your input' }] }] }) })
  const { container } = render(<SessionStaticTimeline unifiedLive session={{ id: 's' } as AgentSession} runs={[]} steps={[]} messages={[]} toolCalls={[]} excludeStepId={stage === 'live' ? 'ask-step' : undefined} />)
  const text = container.textContent!
  expect(text.indexOf('ask-step')).toBeLessThan(text.indexOf('interaction-question'))
  expect(text.indexOf('ask-step')).toBeGreaterThanOrEqual(0)
})
