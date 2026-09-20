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

  it('removes the redundant task heading', () => {
    const { container } = renderHeader()

    expect(screen.queryByText('任务', { exact: true })).toBeNull()
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


it('never uses pagination as proof that a Wiki exists', () => {
  renderHeader({ workflowCount: 0, hasMoreSessions: true, onOpenWorkflows: noop })
  expect(screen.queryByRole('button', { name: /Workflow/ })).toBeNull()
})

it('shows workflows only after the current project has generated Wiki content', () => {
  renderHeader({ hasGeneratedWiki: true, workflowCount: 0, onOpenWorkflows: noop })
  expect(screen.getByRole('button', { name: /Workflow/ })).toBeTruthy()
})
