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

  it('shows a spinning loader between the expand control and title for running sessions', () => {
    const { container } = render(
      <SessionTreeItem
        node={makeNode(makeSession({ status: 'running' }))}
        isSelected={false}
        onSelect={noop}
        onToggleExpand={noop}
      />,
    )

    const indicator = container.querySelector('.animate-spin')
    const expandControl = container.querySelector('button')
    const title = container.querySelector('.session-list-title')

    expect(indicator?.classList.contains('animate-spin')).toBe(true)
    expect(indicator?.classList.contains('shrink-0')).toBe(true)
    expect(expandControl).toBeTruthy()
    expect(expandControl!.compareDocumentPosition(indicator!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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
})
