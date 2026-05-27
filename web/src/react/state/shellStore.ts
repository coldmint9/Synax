import { create } from 'zustand'

export interface ProjectSummary {
  id: string
  name: string
  status: 'healthy' | 'at_risk' | 'blocked'
  environment: 'production' | 'staging' | 'development'
  healthScore: number
  activeAgents: number
  activeHumans: number
  openRisks: number
  updatedAt: string
  source?: {
    kind: 'scratch' | 'github' | 'gitlab' | 'localPath'
    repo?: string
    branch?: string
    /** 本地目录导入时的绝对或相对路径（与后端 `source.localPath` 对应） */
    localPath?: string
  }
  importState?: 'idle' | 'syncing' | 'ready' | 'failed'
  importError?: string
  createdBy?: string
  createdAt?: string
}

export interface ShellPreferences {
  theme: 'light' | 'dark'
  defaultHome: 'global-home' | 'last-project'
  notifications: boolean
  locale: 'zh' | 'en'
  editor: 'system' | 'vscode' | 'cursor' | 'windsurf' | 'webstorm'
  showSessionsTab: boolean
}

export interface ProjectSearchFilter {
  search: string
  statusFilter: string[]
  environmentFilter: string[]
  sortBy: 'name' | 'healthScore' | 'updatedAt' | 'createdAt'
  sortOrder: 'asc' | 'desc'
}

interface ShellState {
  projects: ProjectSummary[]
  projectsLoaded: boolean
  preferences: ShellPreferences
  currentProjectId: string | null
  currentUser: {
    id: string
    name: string
    email: string
  }
  /** Search/filter state for project list */
  projectFilter: ProjectSearchFilter
  setTheme: (theme: ShellPreferences['theme']) => void
  setLocale: (locale: ShellPreferences['locale']) => void
  setDefaultHome: (defaultHome: ShellPreferences['defaultHome']) => void
  setNotifications: (notifications: boolean) => void
  setEditor: (editor: ShellPreferences['editor']) => void
  setShowSessionsTab: (show: boolean) => void
  addProject: (project: ProjectSummary) => void
  setProjects: (projects: ProjectSummary[]) => void
  removeProject: (projectId: string) => void
  updateProject: (projectId: string, updates: Partial<ProjectSummary>) => void
  setProjectFilter: (filter: Partial<ProjectSearchFilter>) => void
  setCurrentProjectId: (projectId: string | null) => void
  fetchProjects: () => Promise<void>
}

const storageKey = 'rumbling-shell-preferences'

export const useShellStore = create<ShellState>((set) => ({
  projects: [],
  projectsLoaded: false,
  preferences: {
    theme: 'dark',
    defaultHome: 'global-home',
    notifications: true,
    locale: 'zh',
    editor: 'system',
    showSessionsTab: false,
  },
  currentProjectId: null,
  currentUser: {
    id: 'u-alice',
    name: 'Alice Chen',
    email: 'alice@rumbling.local',
  },
  projectFilter: {
    search: '',
    statusFilter: [],
    environmentFilter: [],
    sortBy: 'createdAt',
    sortOrder: 'desc',
  },
  setTheme: (theme) => {
    set((state) => ({ preferences: { ...state.preferences, theme } }))
    const next = useShellStore.getState().preferences
    localStorage.setItem(storageKey, JSON.stringify(next))
    document.documentElement.classList.toggle('dark', theme === 'dark')
  },
  setLocale: (locale) => {
    set((state) => ({ preferences: { ...state.preferences, locale } }))
    localStorage.setItem(storageKey, JSON.stringify(useShellStore.getState().preferences))
  },
  setDefaultHome: (defaultHome) => {
    set((state) => ({ preferences: { ...state.preferences, defaultHome } }))
    localStorage.setItem(storageKey, JSON.stringify(useShellStore.getState().preferences))
  },
  setNotifications: (notifications) => {
    set((state) => ({ preferences: { ...state.preferences, notifications } }))
    localStorage.setItem(storageKey, JSON.stringify(useShellStore.getState().preferences))
  },
  setEditor: (editor) => {
    set((state) => ({ preferences: { ...state.preferences, editor } }))
    localStorage.setItem(storageKey, JSON.stringify(useShellStore.getState().preferences))
  },
  setShowSessionsTab: (showSessionsTab) => {
    set((state) => ({ preferences: { ...state.preferences, showSessionsTab } }))
    localStorage.setItem(storageKey, JSON.stringify(useShellStore.getState().preferences))
  },
  addProject: (project) => {
    set((state) => ({
      projects: [project, ...state.projects.filter(p => p.id !== project.id)],
      currentProjectId: project.id,
    }))
  },
  setProjects: (list) => {
    set(() => ({ projects: list }))
  },
  removeProject: (projectId) => {
    set((state) => ({
      projects: state.projects.filter(p => p.id !== projectId),
      currentProjectId: state.currentProjectId === projectId ? null : state.currentProjectId,
    }))
  },
  updateProject: (projectId, updates) => {
    set((state) => ({
      projects: state.projects.map(p => (p.id === projectId ? { ...p, ...updates } : p)),
    }))
  },
  setProjectFilter: (filter) => {
    set((state) => ({
      projectFilter: { ...state.projectFilter, ...filter },
    }))
  },
  setCurrentProjectId: (projectId) => {
    set(() => ({ currentProjectId: projectId }))
  },
  fetchProjects: async () => {
    try {
      const { projectApi } = await import('../../lib/api/project')
      const { items } = await projectApi.listProjects()
      set(() => ({ projects: items, projectsLoaded: true }))
    } catch {
      set(() => ({ projectsLoaded: true }))
    }
  },
}))

export function hydrateShellPreferences() {
  const raw = localStorage.getItem(storageKey)
  if (!raw) return
  try {
    const parsed = JSON.parse(raw) as Partial<ShellPreferences>
    const patch: Partial<ShellPreferences> = {}
    if (parsed.theme === 'light' || parsed.theme === 'dark') patch.theme = parsed.theme
    if (parsed.locale === 'zh' || parsed.locale === 'en') patch.locale = parsed.locale
    if (parsed.defaultHome === 'global-home' || parsed.defaultHome === 'last-project') patch.defaultHome = parsed.defaultHome
    if (typeof parsed.notifications === 'boolean') patch.notifications = parsed.notifications
    if (parsed.editor && ['system', 'vscode', 'cursor', 'windsurf', 'webstorm'].includes(parsed.editor)) patch.editor = parsed.editor
    if (typeof parsed.showSessionsTab === 'boolean') patch.showSessionsTab = parsed.showSessionsTab
    if (Object.keys(patch).length > 0) {
      useShellStore.setState((state) => ({
        preferences: { ...state.preferences, ...patch },
      }))
    }
  } catch {
    // ignore broken preference payload
  }
}

export function getProjectById(projectId: string) {
  return useShellStore.getState().projects.find(p => p.id === projectId) ?? null
}

export function addProject(project: ProjectSummary) {
  useShellStore.getState().addProject(project)
}
