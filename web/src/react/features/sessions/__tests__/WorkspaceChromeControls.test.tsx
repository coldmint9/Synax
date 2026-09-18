import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSessionWorkspaceStore } from '../sessionWorkspaceStore'

const mocks = vi.hoisted(() => ({ reload: vi.fn() }))

vi.mock('../SessionEnvironmentContext', () => ({
  useSessionWorkspaceEnvironment: () => ({
    environment: null,
    loading: false,
    reload: mocks.reload,
  }),
}))

const { WorkspaceTabStrip } = await import('../WorkspaceChromeControls')

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

describe('WorkspaceTabStrip', () => {
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    matchWideViewport()
    mocks.reload.mockReset()
    scrollIntoView.mockReset()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
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

  it('renders every tab in a scrollable rail and keeps the active tab visible', () => {
    const { container } = render(<WorkspaceTabStrip sessionId="session-1" />)

    expect(screen.getAllByRole('tab')).toHaveLength(4)
    expect(container.querySelector('.workspace-tab-rail')).toBeTruthy()
    expect(container.querySelectorAll('[data-file-type-icon$=".ts"]')).toHaveLength(4)
    expect(screen.queryByLabelText('还有 1 个标签')).toBeNull()
    expect(screen.getByRole('tab', { name: 'd.ts' }).getAttribute('aria-selected')).toBe('true')
    expect(scrollIntoView).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('tab', { name: 'b.ts' }))
    expect(useSessionWorkspaceStore.getState().sessions['session-1'].activeTabId).toBe('diff:b.ts')
  })

  it('returns to the conversation without discarding output tabs', () => {
    render(<WorkspaceTabStrip sessionId="session-1" />)
    fireEvent.click(screen.getByRole('button', { name: '返回对话' }))
    const workspace = useSessionWorkspaceStore.getState().sessions['session-1']
    expect(workspace.activeTabId).toBeNull()
    expect(workspace.tabs).toHaveLength(4)
  })

  it('closes a tab and selects the remaining tab', () => {
    render(<WorkspaceTabStrip sessionId="session-1" />)

    fireEvent.click(screen.getByLabelText('关闭 d.ts'))

    expect(useSessionWorkspaceStore.getState().sessions['session-1']).toMatchObject({
      activeTabId: 'diff:c.ts',
      presentation: 'dock',
    })
  })

  it('refreshes and toggles fullscreen mode from the tab actions', () => {
    render(<WorkspaceTabStrip sessionId="session-1" />)

    fireEvent.click(screen.getByLabelText('刷新工作区'))
    expect(mocks.reload).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByLabelText('全屏'))
    expect(useSessionWorkspaceStore.getState().sessions['session-1'].presentation).toBe('focus')

    fireEvent.click(screen.getByLabelText('退出全屏'))
    expect(useSessionWorkspaceStore.getState().sessions['session-1'].presentation).toBe('dock')
  })

  it('renders nothing without an active tab', () => {
    useSessionWorkspaceStore.setState({
      sessions: {
        'session-1': {
          tabs: [],
          activeTabId: null,
          presentation: 'dock',
        },
      },
    })

    render(<WorkspaceTabStrip sessionId="session-1" />)

    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByLabelText('刷新工作区')).toBeNull()
  })
})
