import { beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { AgentSession } from '../../../../lib/api/agentRuntime'
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
    useAgentSessionStore.setState({ projectId: 'p1', readSessionMarkers: {} })
  })

  it('shows a spinning loader before the title for running sessions', () => {
    const { container } = render(
      <SessionTreeItem
        node={makeNode(makeSession({ status: 'running' }))}
        isSelected={false}
        onSelect={noop}
        onToggleExpand={noop}
      />,
    )

    const indicator = container.querySelector('.session-list-running-indicator')
    const title = container.querySelector('.session-list-title')

    expect(indicator?.classList.contains('animate-spin')).toBe(true)
    expect(title).toBeTruthy()
    // The indicator must sit ahead of the title in document order …
    expect(indicator!.compareDocumentPosition(title!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // … and stay out of the flex flow so it never takes width from the title.
    expect(indicator?.classList.contains('shrink-0')).toBe(false)
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

    const indicator = container.querySelector('.session-list-running-indicator')

    expect(indicator?.classList.contains('animate-spin')).toBe(true)
    // Child rows use their own narrower gutter offset.
    expect(indicator?.classList.contains('session-list-running-indicator--child')).toBe(true)
  })
})
