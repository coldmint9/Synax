import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { useAgentSessionStore } from '../agentSessionStore'
import { SessionProfilePanel } from '../SessionProfilePanel'

describe('SessionProfilePanel', () => {
  beforeEach(() => {
    useAgentSessionStore.setState({
      sessionStats: null,
      sessionTodos: [],
      sessionCapabilities: null,
      steps: [],
    })
  })

  afterEach(() => cleanup())

  it('renders a card-level Status heading for the selected session', () => {
    render(<SessionProfilePanel sessionId="session-1" />)

    expect(screen.getByText('Status')).toBeTruthy()
    expect(screen.getByText('当前会话')).toBeTruthy()
  })

  it('keeps the empty state inside the Profile card', () => {
    render(<SessionProfilePanel sessionId={null} />)

    expect(screen.getByText('Status')).toBeTruthy()
    expect(screen.getByText('选择会话后查看 Profile')).toBeTruthy()
  })
})
