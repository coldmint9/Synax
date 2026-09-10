import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSessionWorkspaceStore } from '../sessionWorkspaceStore'

vi.mock('../SessionEnvironmentContext', () => ({
  useSessionWorkspaceEnvironment: () => ({
    environment: null,
    loading: false,
    reload: vi.fn(),
  }),
}))

const { WorkspaceFocusControls, WorkspaceWing } = await import('../WorkspaceChromeControls')

function matchWideViewport() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

describe('WorkspaceChromeControls', () => {
  beforeEach(() => {
    matchWideViewport()
    useSessionWorkspaceStore.setState({
      sessions: {
        'session-1': {
          tabs: [
            { id: 'file:a.ts', kind: 'file', title: 'a.ts', path: 'a.ts' },
            { id: 'diff:b.ts', kind: 'diff', title: 'b.ts', path: 'b.ts' },
            { id: 'diff:c.ts', kind: 'diff', title: 'c.ts', path: 'c.ts' },
            { id: 'diff:d.ts', kind: 'diff', title: 'd.ts', path: 'd.ts' },
          ],
          activeTabId: 'diff:d.ts',
          presentation: 'dock',
        },
      },
    })
  })

  afterEach(() => cleanup())

  it('renders the dock wing without replacing the workspace layout', () => {
    render(<WorkspaceWing sessionId="session-1" />)

    expect(screen.getByText('d.ts')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('切换工作区标签'))
    expect(screen.getByRole('menuitem', { name: 'b.ts' })).toBeTruthy()

    fireEvent.click(screen.getByLabelText('切换到 d.ts'))
    expect(useSessionWorkspaceStore.getState().sessions['session-1']).toMatchObject({
      activeTabId: 'diff:d.ts',
      presentation: 'dock',
    })
  })

  it('wraps the tab strip in a pill without workspace actions', () => {
    const { container } = render(<WorkspaceFocusControls sessionId="session-1" />)

    expect(container.querySelector('.workspace-tabs-pill')).toBeTruthy()
    expect(screen.queryByRole('tab', { name: '工作区' })).toBeNull()
    expect(screen.queryByLabelText('新建标签页')).toBeNull()
    expect(screen.queryByLabelText('关闭全部标签')).toBeNull()
    expect(screen.getByRole('tab', { name: /d.ts/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByLabelText('还有 1 个标签'))
    expect(screen.getByRole('menuitem', { name: 'c.ts' })).toBeTruthy()
  })

  it('hides the dashboard launcher when there is nothing open', () => {
    useSessionWorkspaceStore.setState({
      sessions: {
        'session-1': {
          tabs: [],
          activeTabId: null,
          presentation: 'dock',
        },
      },
    })

    render(<WorkspaceWing sessionId="session-1" />)

    expect(screen.queryByLabelText('切换工作区标签')).toBeNull()
    expect(screen.queryByLabelText('打开工作区面板')).toBeNull()
    expect(screen.queryByLabelText('新建标签页')).toBeNull()
  })
})
