import { create } from 'zustand'

export type WorkspaceTabKind = 'file' | 'diff' | 'subagent'

export interface WorkspaceTab {
  id: string
  kind: WorkspaceTabKind
  title: string
  /** File path for file/diff tabs. */
  path?: string
  /** Child session id for subagent tabs. */
  sessionId?: string
}

interface SessionWorkspaceState {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  maximized: boolean
  openTab: (tab: Omit<WorkspaceTab, 'id'>) => void
  activateTab: (id: string) => void
  closeTab: (id: string) => void
  closeOthers: (id: string) => void
  closeAll: () => void
  setMaximized: (value: boolean) => void
  reset: () => void
  resetTabs: () => void
}

function tabIdentity(tab: Omit<WorkspaceTab, 'id'>): string {
  return tab.kind === 'subagent'
    ? `subagent:${tab.sessionId ?? ''}`
    : `${tab.kind}:${tab.path ?? ''}`
}

export const useSessionWorkspaceStore = create<SessionWorkspaceState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  maximized: false,

  openTab: (tab) => {
    const id = tabIdentity(tab)
    set((state) => {
      const existing = state.tabs.some(item => item.id === id)
      const tabs = existing ? state.tabs : [...state.tabs, { ...tab, id }]
      return { tabs, activeTabId: id, maximized: state.maximized || state.tabs.length === 0 }
    })
  },

  activateTab: (id) => set({ activeTabId: id }),

  closeTab: (id) => {
    set((state) => {
      const tabs = state.tabs.filter(item => item.id !== id)
      const activeTabId = state.activeTabId === id
        ? (tabs[tabs.length - 1]?.id ?? null)
        : state.activeTabId
      return { tabs, activeTabId, maximized: tabs.length > 0 && state.maximized }
    })
  },

  closeOthers: (id) => {
    set((state) => ({
      tabs: state.tabs.filter(item => item.id === id),
      activeTabId: id,
    }))
  },

  closeAll: () => set({ tabs: [], activeTabId: null, maximized: false }),

  setMaximized: (value) => set({ maximized: value }),

  reset: () => set({ tabs: [], activeTabId: null, maximized: false }),

  resetTabs: () => set({ tabs: [], activeTabId: null }),
}))

export function openWorkspaceFile(path: string) {
  const name = path.split('/').pop() || path
  useSessionWorkspaceStore.getState().openTab({ kind: 'file', title: name, path })
}

export function openWorkspaceDiff(path: string) {
  const name = path.split('/').pop() || path
  useSessionWorkspaceStore.getState().openTab({ kind: 'diff', title: name, path })
}

export function openWorkspaceSubagent(sessionId: string, title: string) {
  useSessionWorkspaceStore.getState().openTab({ kind: 'subagent', title, sessionId })
}
