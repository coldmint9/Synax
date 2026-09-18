import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionListHeader } from '../SessionListHeader'
import { useShellStore } from '../../../state/shellStore'

const noop = () => {}

function renderHeader(props: Partial<React.ComponentProps<typeof SessionListHeader>> = {}) {
  return render(
    <SessionListHeader
      listView="sessions"
      workflowCount={0}
      searchQuery=""
      onSearchChange={noop}
      onClearInactive={noop}
      onNewSession={noop}
      {...props}
    />,
  )
}

describe('SessionListHeader', () => {
  beforeEach(() => {
    useShellStore.setState(state => ({ preferences: { ...state.preferences, locale: 'zh' } }))
  })

  it('shows the 任务 heading without a session counter', () => {
    const { container } = renderHeader()

    expect(container.textContent).toContain('任务')
    expect(container.textContent).not.toMatch(/\(\d+\)/)
  })

  it('renders the new-chat button with a leading icon and no manual refresh', () => {
    const onNewSession = vi.fn()
    renderHeader({ onNewSession })

    const newChat = screen.getByRole('button', { name: /新任务/ })
    expect(newChat.firstElementChild?.tagName.toLowerCase()).toBe('svg')
    expect(screen.queryByRole('button', { name: /refresh|刷新/i })).toBeNull()
    // Only "新任务" and the clear-inactive action remain in the header actions.
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
})


it('keeps workflows reachable while their rows may be on a later page', () => {
  renderHeader({ workflowCount: 0, hasMoreSessions: true, onOpenWorkflows: noop })
  expect(screen.getByRole('button', { name: /Workflow/ })).toBeTruthy()
})
