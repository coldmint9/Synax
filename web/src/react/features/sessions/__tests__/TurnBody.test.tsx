import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { InterleavedTurn } from '../buildInterleavedTurns'
import { TurnBody } from '../TurnBody'

const emptyTurn: InterleavedTurn = {
  stepId: 'step-1',
  index: 0,
  status: 'running',
  duration: null,
  blocks: [],
}

describe('TurnBody', () => {
  it('shows the thinking dots while a streaming turn is waiting for content', () => {
    const { container } = render(
      <TurnBody turn={emptyTurn} entryId="entry-1" isStreaming />,
    )

    expect(container.querySelectorAll('[data-thinking-dot]')).toHaveLength(3)
  })

  it('does not show the thinking dots for an empty completed turn', () => {
    const { container } = render(
      <TurnBody turn={{ ...emptyTurn, status: 'completed' }} entryId="entry-1" />,
    )

    expect(container.querySelector('[data-thinking-dot]')).toBeNull()
  })
})
