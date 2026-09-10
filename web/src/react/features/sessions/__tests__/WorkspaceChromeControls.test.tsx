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

  it('renders the dock wing and enters focus without changing tabs', () => {
    render(<WorkspaceWing sessionId="session-1" />)

    expect(screen.getByText('d.ts')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('切换工作区标签'))
    expect(screen.getByRole('menuitem', { name: 'b.ts' })).toBeTruthy()

    fireEvent.click(screen.getByLabelText('聚焦 d.ts'))
    expect(useSessionWorkspaceStore.getState().sessions['session-1']).toMatchObject({
      activeTabId: 'diff:d.ts',
      presentation: 'focus',
    })
  })

  it('pins the active tab and exposes overflow tabs in focus mode', () => {
    render(<WorkspaceFocusControls sessionId="session-1" />)

    expect(screen.getByRole('tab', { name: /d.ts/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByLabelText('还有 1 个标签'))
    expect(screen.getByRole('menuitem', { name: 'c.ts' })).toBeTruthy()
  })

  it('does not render a tab switcher when there is nothing to switch', () => {
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
    fireEvent.click(screen.getByLabelText('打开工作区面板'))
    expect(useSessionWorkspaceStore.getState().sessions['session-1'].presentation).toBe('focus')
  })
})
