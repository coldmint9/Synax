import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { AgentRuntimeMessage, AgentSession } from '../../../../lib/api/agentRuntime'
import { useAgentSessionStore } from '../agentSessionStore'
import { SessionTreeItem } from '../SessionTreeItem'
import type { SessionTreeNode } from '../useSessionList'

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    projectId: 'p1',
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: 'synax',
    status: 'running',
    title: 'Run a command',
    prompt: 'hello',
    contextSnapshotId: null,
    thinkingMode: 'standard',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    activeRunId: 'run-1',
    pendingResumeToken: null,
    model: null,
    ...overrides,
  }
}

function makeNode(session: AgentSession, depth = 0): SessionTreeNode {
  return { session, depth, children: [], expanded: true }
}

const noop = () => {}

describe('SessionTreeItem', () => {
  beforeEach(() => {
    useAgentSessionStore.setState({ projectId: 'p1', readSessionMarkers: {}, selectedSessionId: null, messages: [], sessionDetailCache: {} })
  })

  it('shows a spinning loader before the title without an empty expand control', () => {
    const { container } = render(
      <SessionTreeItem
        node={makeNode(makeSession({ status: 'running' }))}
        isSelected={false}
        onSelect={noop}
        onToggleExpand={noop}
      />,
    )

    const indicator = container.querySelector('.animate-spin')
    const expandControl = container.querySelector('.session-list-expand')
    const title = container.querySelector('.session-list-title')

    expect(indicator?.classList.contains('animate-spin')).toBe(true)
    expect(indicator?.classList.contains('shrink-0')).toBe(true)
    expect(expandControl).toBeNull()
    expect(title).toBeTruthy()
    expect(indicator!.compareDocumentPosition(title!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does not show a spinner for completed sessions', () => {
    const { container } = render(
      <SessionTreeItem
        node={makeNode(makeSession({ status: 'completed' }))}
        isSelected={false}
        onSelect={noop}
        onToggleExpand={noop}
      />,
    )

    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('shows a spinner on running child sessions too', () => {
    const { container } = render(
      <SessionTreeItem
        node={makeNode(makeSession({ status: 'running' }), 1)}
        isSelected={false}
        onSelect={noop}
        onToggleExpand={noop}
      />,
    )

    const spinner = container.querySelector('.animate-spin')

    expect(spinner?.classList.contains('shrink-0')).toBe(true)
  })

  it('dismisses the completed dot on selection and shows it again after a new update', () => {
    const session = makeSession({ status: 'completed' })
    useAgentSessionStore.setState({ sessions: [session] })
    const onSelect = (id: string) => useAgentSessionStore.getState().markSessionRead(id)
    const { container, rerender } = render(
      <SessionTreeItem node={makeNode(session)} isSelected={false} onSelect={onSelect} onToggleExpand={noop} />,
    )
    expect(container.querySelector('.session-list-dot')).not.toBeNull()
    fireEvent.click(container.querySelector('.session-list-select')!)
    expect(container.querySelector('.session-list-dot')).toBeNull()
    expect(container.querySelector('.session-list-indicator')).not.toBeNull()
    expect(useAgentSessionStore.getState().readSessionMarkers[session.id]).toBe(session.updatedAt)

    rerender(<SessionTreeItem node={makeNode({ ...session })} isSelected={false} onSelect={onSelect} onToggleExpand={noop} />)
    expect(container.querySelector('.session-list-dot')).toBeNull()
    rerender(<SessionTreeItem node={makeNode({ ...session, updatedAt: '2026-01-03T00:00:00Z' })} isSelected={false} onSelect={onSelect} onToggleExpand={noop} />)
    expect(container.querySelector('.session-list-dot')).not.toBeNull()
  })

  it('keeps the running indicator after selection', () => {
    const session = makeSession()
    useAgentSessionStore.setState({ sessions: [session] })
    const { container } = render(
      <SessionTreeItem node={makeNode(session)} isSelected={false} onSelect={id => useAgentSessionStore.getState().markSessionRead(id)} onToggleExpand={noop} />,
    )
    fireEvent.click(container.querySelector('.session-list-select')!)
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  it('keeps selection separate from expand and delete actions', () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    const onToggleExpand = vi.fn()
    const node = makeNode(makeSession())
    node.children = [makeNode(makeSession({ id: 'child' }), 1)]
    const { container } = render(
      <SessionTreeItem node={node} isSelected onSelect={onSelect} onDelete={onDelete} onToggleExpand={onToggleExpand} />,
    )
    fireEvent.click(container.querySelector('.session-list-expand')!)
    fireEvent.click(container.querySelector('.session-list-delete')!)
    expect(onToggleExpand).toHaveBeenCalledWith('sess-1')
    expect(onDelete).toHaveBeenCalledWith('sess-1')
    expect(onSelect).not.toHaveBeenCalled()
    const select = container.querySelector('.session-list-select')!
    expect(select.getAttribute('aria-current')).toBe('true')
    fireEvent.click(select)
    expect(onSelect).toHaveBeenCalledWith('sess-1')
  })

  it('shows the latest conversation message and excludes tool output and injected prompts', () => {
    const message = (id: string, role: AgentRuntimeMessage['role'], content: string, metadata = {}): AgentRuntimeMessage => ({
      id, role, content, metadata, sessionId: 'sess-1', runId: null, stepId: null, createdAt: '2026-01-02T00:00:00Z',
    })
    useAgentSessionStore.setState({ selectedSessionId: 'sess-1', messages: [
      message('m1', 'assistant', '已完成复核，\n  正在验证布局。'),
      message('m2', 'tool', 'internal tool output'),
      message('m3', 'user', 'internal prompt', { source: 'system_injection' }),
    ] })
    const { container } = render(
      <SessionTreeItem node={makeNode(makeSession({ resultSummary: 'older summary' }))} isSelected onSelect={noop} onToggleExpand={noop} />,
    )
    expect(container.querySelector('.session-list-preview')?.textContent).toBe('已完成复核， 正在验证布局。')
    expect(container.querySelector('time')?.getAttribute('dateTime')).toBe('2026-01-02T00:00:00Z')
  })

  it('uses the summary or task content when no messages have been loaded', () => {
    const { container, rerender } = render(
      <SessionTreeItem node={makeNode(makeSession({ resultSummary: '已完成布局优化' }))} isSelected={false} onSelect={noop} onToggleExpand={noop} />,
    )
    expect(container.querySelector('.session-list-preview')?.textContent).toBe('已完成布局优化')
    rerender(<SessionTreeItem node={makeNode(makeSession())} isSelected={false} onSelect={noop} onToggleExpand={noop} />)
    expect(container.querySelector('.session-list-preview')?.textContent).toBe('hello')
  })
})
