import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_SESSION_WORKSPACE,
  openWorkspaceTab,
  useSessionWorkspaceStore,
} from '../sessionWorkspaceStore'

function matchViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
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

describe('sessionWorkspaceStore', () => {
  beforeEach(() => {
    useSessionWorkspaceStore.setState({ sessions: {} })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps tabs isolated per session and restores the prior active tab', () => {
    const store = useSessionWorkspaceStore.getState()
    store.openTab('session-a', { kind: 'diff', title: 'a.ts', path: 'a.ts' })
    store.openTab('session-b', { kind: 'file', title: 'b.ts', path: 'b.ts' })
    store.activateTab('session-a', 'diff:a.ts')
    store.enterFocus('session-b')

    const state = useSessionWorkspaceStore.getState().sessions
    expect(state['session-a'].activeTabId).toBe('diff:a.ts')
    expect(state['session-a'].presentation).toBe('dock')
    expect(state['session-b'].activeTabId).toBe('file:b.ts')
    expect(state['session-b'].presentation).toBe('focus')
  })

  it('does not enter focus on wide viewports and does on compact viewports', () => {
    matchViewport(true)
    openWorkspaceTab('wide', { kind: 'diff', title: 'wide.ts', path: 'wide.ts' })
    expect(useSessionWorkspaceStore.getState().sessions.wide.presentation).toBe('dock')

    matchViewport(false)
    openWorkspaceTab('compact', { kind: 'diff', title: 'compact.ts', path: 'compact.ts' })
    expect(useSessionWorkspaceStore.getState().sessions.compact.presentation).toBe('focus')
  })

  it('keeps focus after closing the last tab and only exits explicitly', () => {
    const store = useSessionWorkspaceStore.getState()
    store.openTab('session-a', { kind: 'file', title: 'a.ts', path: 'a.ts' })
    store.enterFocus('session-a')
    store.closeAll('session-a')

    expect(useSessionWorkspaceStore.getState().sessions['session-a']).toMatchObject({
      tabs: [],
      activeTabId: null,
      presentation: 'focus',
    })

    store.exitFocus('session-a')
    expect(useSessionWorkspaceStore.getState().sessions['session-a'].presentation).toBe('dock')
  })

  it('removes only the deleted sessions', () => {
    const store = useSessionWorkspaceStore.getState()
    store.openTab('keep', { kind: 'file', title: 'keep.ts', path: 'keep.ts' })
    store.openTab('delete', { kind: 'file', title: 'delete.ts', path: 'delete.ts' })
    store.removeSessions(['delete'])

    expect(useSessionWorkspaceStore.getState().sessions.keep).toBeDefined()
    expect(useSessionWorkspaceStore.getState().sessions.delete).toBeUndefined()
    expect(EMPTY_SESSION_WORKSPACE.tabs).toEqual([])
  })
})
