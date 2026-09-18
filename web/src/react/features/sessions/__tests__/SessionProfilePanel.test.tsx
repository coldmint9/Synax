import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  it('discloses runtime details only on demand', () => {
    render(<SessionProfilePanel sessionId="session-1" />)

    const toggle = screen.getByRole('button', { name: '运行详情' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })

  it('does not show an inspector without a session', () => {
    render(<SessionProfilePanel sessionId={null} />)

    expect(screen.queryByRole('button')).toBeNull()
  })
})
