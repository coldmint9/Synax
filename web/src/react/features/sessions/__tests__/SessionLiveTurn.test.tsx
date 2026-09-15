import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRunStep } from '../../../../lib/api/agentRuntime'
import type { TurnContentBlock } from '../buildInterleavedTurns'
import { SessionLiveTurn } from '../SessionLiveTurn'
import { EMPTY_STREAMING_BUFFERS } from '../streamingLiveBlocks'

vi.mock('../ThinkingBlock', () => ({
  ThinkingBlock: ({ content }: { content: string }) => <div>{content}</div>,
}))
vi.mock('../ToolCallRoundPanel', () => ({
  ToolCallRoundPanel: ({ toolBlocks }: { toolBlocks: TurnContentBlock[] }) => (
    <div>{toolBlocks.map(block => block.type === 'tool_call' ? block.call.inputSummary : '').join('')}</div>
  ),
}))

const blocks: TurnContentBlock[] = [
  { type: 'thinking', content: 'Locating BUI styles elsewhere' },
  { type: 'tool_call', call: {
    id: 'call-1', toolId: 'grep.search', inputSummary: 'bui-tool|bui-activity|StreamingTextBlock',
    outputSummary: 'Found matches', status: 'completed', duration: '55ms',
  } },
]
const snapshot = { stepId: 'step-1', stepIndex: 1, blocks }
const persisted: AgentRunStep = {
  id: 'step-1', runId: 'run-1', sessionId: 'session-1', index: 1,
  status: 'completed', model: 'test', startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:00:01Z', finishReason: 'tool-calls', metadata: {},
}
const props = {
  steps: [] as AgentRunStep[], streamingStepId: 'step-2',
  streamingLive: EMPTY_STREAMING_BUFFERS, streamingCompletedSteps: [snapshot],
}

describe('SessionLiveTurn', () => {
  it('hands completed snapshots over to history after detail refresh', () => {
    const { rerender, container } = render(<SessionLiveTurn {...props} />)
    expect(screen.getAllByText('Locating BUI styles elsewhere')).toHaveLength(1)
    expect(screen.getAllByText('bui-tool|bui-activity|StreamingTextBlock')).toHaveLength(1)

    rerender(<SessionLiveTurn {...props} steps={[persisted]} />)
    expect(screen.queryByText('Locating BUI styles elsewhere')).toBeNull()
    expect(screen.queryByText('bui-tool|bui-activity|StreamingTextBlock')).toBeNull()
    expect(container.querySelector('.bui-thinking')).toHaveAttribute('data-live', 'true')
    expect(screen.getByRole('status').textContent).toBeTruthy()
  })

  it('keeps an unsynced step even when its contents match a persisted step', () => {
    render(<SessionLiveTurn {...props} steps={[persisted]}
      streamingCompletedSteps={[snapshot, { ...snapshot, stepId: 'other-step', stepIndex: 2 }]} />)
    expect(screen.getAllByText('Locating BUI styles elsewhere')).toHaveLength(1)
    expect(screen.getAllByText('bui-tool|bui-activity|StreamingTextBlock')).toHaveLength(1)
  })

  it('renders nothing when history owns every step and there is no active stream', () => {
    const { container } = render(<SessionLiveTurn {...props} steps={[persisted]} streamingStepId={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('keeps the current running step in the live layer', () => {
    render(<SessionLiveTurn {...props} steps={[{ ...persisted, status: 'running' }]}
      streamingStepId="step-1" streamingCompletedSteps={[]}
      streamingLive={{ ...EMPTY_STREAMING_BUFFERS, blocks }} />)
    expect(screen.getAllByText('Locating BUI styles elsewhere')).toHaveLength(1)
    expect(screen.getAllByText('bui-tool|bui-activity|StreamingTextBlock')).toHaveLength(1)
  })
})
