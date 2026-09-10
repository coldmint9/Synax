import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionEnvironment } from '../../../../lib/api/agentRuntime'
import { WorkspaceDashboard } from '../WorkspaceDashboard'
import { useSessionWorkspaceStore } from '../sessionWorkspaceStore'

const environment: SessionEnvironment = {
  sessionId: 'session-1',
  projectId: 'proj-1',
  workspacePath: '/Users/mint/IdeaProjects/jbolt-ai-vue/.worktrees/feature',
  branch: 'feature/dynamic-workflow-refactor',
  headCommitSha: '5e5727b0abcdef0123456789',
  dirty: true,
  additions: 585,
  deletions: 138,
  changedFiles: [
    {
      path: 'src/views/chat-cli/index.vue',
      status: 'modified',
      additions: 40,
      deletions: 12,
      staged: false,
      untracked: false,
    },
    {
      path: 'src/views/cli_chat/components/blocks/BlockAsk.vue',
      status: 'added',
      additions: 62,
      deletions: 0,
      staged: true,
      untracked: false,
    },
    {
      path: 'notes.md',
      status: 'untracked',
      additions: 4,
      deletions: 0,
      staged: false,
      untracked: true,
    },
  ],
  agentChangedFiles: [],
  inputFiles: [
    'src/views/cli_chat/index.vue',
    'src/views/cli_chat/utils/toolDisplay.js',
  ],
  subagents: [
    {
      id: 'sub-1',
      parentSessionId: 'session-1',
      profileId: 'explorer',
      status: 'completed',
      title: null,
      prompt: '## Investigation Task\n用只读方式深度调研 src/views/cli_chat 目录',
      updatedAt: '2026-09-10T00:00:00.000Z',
      completedAt: '2026-09-10T00:10:00.000Z',
      resultSummary: null,
    },
    {
      id: 'sub-2',
      parentSessionId: 'session-1',
      profileId: 'worker',
      status: 'running',
      title: 'Writer',
      prompt: '重写 BlockTool.vue',
      updatedAt: '2026-09-10T00:20:00.000Z',
      completedAt: null,
      resultSummary: null,
    },
  ],
  refreshedAt: '2026-09-10T00:30:00.000Z',
}

function renderDashboard(overrides: Partial<SessionEnvironment> = {}) {
  return render(
    <WorkspaceDashboard
      sessionId="session-1"
      environment={{ ...environment, ...overrides }}
      loading={false}
      reload={() => {}}
    />,
  )
}

describe('WorkspaceDashboard', () => {
  beforeEach(() => {
    useSessionWorkspaceStore.setState({ sessions: {} })
  })

  afterEach(() => cleanup())

  it('divides the snapshot into one card per component group', () => {
    renderDashboard()

    expect(screen.getByText('feature/dynamic-workflow-refactor')).toBeTruthy()
    expect(screen.getByText('5e5727b0')).toBeTruthy()
    expect(screen.getByText('+585')).toBeTruthy()
    expect(screen.getByText('-138')).toBeTruthy()

    expect(screen.getByRole('button', { name: /Subagents/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Git 变更/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /输入文件/ })).toBeTruthy()
    expect(screen.getByText('运行中 1')).toBeTruthy()
    expect(screen.getByText('已暂存 1')).toBeTruthy()
  })

  it('falls back to the prompt headline for untitled subagents', () => {
    renderDashboard()

    expect(screen.getByText('Investigation Task')).toBeTruthy()
    expect(screen.getByText('用只读方式深度调研 src/views/cli_chat 目录')).toBeTruthy()
    expect(screen.getByText('Writer')).toBeTruthy()
  })

  it('opens diff, file, and subagent tabs from the card rows', () => {
    renderDashboard()

    fireEvent.click(screen.getByText('BlockAsk.vue'))
    expect(useSessionWorkspaceStore.getState().sessions['session-1'].tabs).toMatchObject([
      { id: 'diff:src/views/cli_chat/components/blocks/BlockAsk.vue', kind: 'diff' },
    ])

    fireEvent.click(screen.getByText('toolDisplay.js'))
    expect(useSessionWorkspaceStore.getState().sessions['session-1'].tabs).toMatchObject([
      { id: 'diff:src/views/cli_chat/components/blocks/BlockAsk.vue', kind: 'diff' },
      { id: 'file:src/views/cli_chat/utils/toolDisplay.js', kind: 'file' },
    ])

    fireEvent.click(screen.getByText('Investigation Task'))
    expect(useSessionWorkspaceStore.getState().sessions['session-1'].tabs).toMatchObject([
      { id: 'diff:src/views/cli_chat/components/blocks/BlockAsk.vue', kind: 'diff' },
      { id: 'file:src/views/cli_chat/utils/toolDisplay.js', kind: 'file' },
      { id: 'subagent:sub-1', kind: 'subagent' },
    ])
  })

  it('collapses a card body from its header', () => {
    renderDashboard()

    const header = screen.getByRole('button', { name: /Git 变更/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('notes.md')).toBeTruthy()

    fireEvent.click(header)

    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('notes.md')).toBeNull()
    // Other cards keep their content.
    expect(screen.getByText('toolDisplay.js')).toBeTruthy()
  })

  it('keeps the three list cards with empty states', () => {
    renderDashboard({ changedFiles: [], inputFiles: [], subagents: [] })

    expect(screen.queryByRole('button', { name: /Subagents/ })).toBeNull()
    expect(screen.getByText('无变更')).toBeTruthy()
    expect(screen.getByText('暂无读取文件')).toBeTruthy()
  })

  it('reflects the agent change status on each row', () => {
    const { container } = renderDashboard()

    const badges = [...container.querySelectorAll('.ws-badge')].map(node => node.textContent)
    expect(badges).toEqual(['M', 'A', 'U'])
  })

  it('reloads the snapshot from the repository card', () => {
    const reload = vi.fn()
    render(
      <WorkspaceDashboard sessionId="session-1" environment={environment} loading={false} reload={reload} />,
    )

    fireEvent.click(screen.getByLabelText('刷新工作区'))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
