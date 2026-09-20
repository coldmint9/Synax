import { create } from 'zustand'
import { useApiConnectivityStore } from '../../lib/apiConnectivity'

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
    kind: 'scratch' | 'github' | 'gitlab' | 'localPath' | 'wsl'
    repo?: string
    branch?: string
    /** 本地目录导入时的绝对或相对路径（与后端 `source.localPath` 对应） */
    localPath?: string
    distribution?: string
    wslPath?: string
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
  agentFontSize: number
  /** Fold runs of activity-only agent turns into one work-log row. */
  sessionFoldWorkRuns: boolean
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
  setAgentFontSize: (fontSize: number) => void
  setSessionFoldWorkRuns: (value: boolean) => void
  addProject: (project: ProjectSummary) => void
  setProjects: (projects: ProjectSummary[]) => void
  removeProject: (projectId: string) => void
  updateProject: (projectId: string, updates: Partial<ProjectSummary>) => void
  setProjectFilter: (filter: Partial<ProjectSearchFilter>) => void
  setCurrentProjectId: (projectId: string | null) => void
  fetchProjects: () => Promise<void>
}

const storageKey = 'rumbling-shell-preferences'
const DEFAULT_UI_FONT_SIZE = 14
const MIN_UI_FONT_SIZE = 12
const MAX_UI_FONT_SIZE = 20
let projectFetchVersion = 0
let projectMutationVersion = 0

function applyUiFontSize(fontSize: number): void {
  const normalized = Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, Math.round(fontSize)))
  document.documentElement.style.setProperty('--ui-font-size', `${normalized}px`)
  document.documentElement.style.setProperty('--ui-font-scale', String(normalized / DEFAULT_UI_FONT_SIZE))
}

export const useShellStore = create<ShellState>((set, get) => ({
  projects: [],
  projectsLoaded: false,
  preferences: {
    theme: 'dark',
    defaultHome: 'global-home',
    notifications: true,
    locale: 'zh',
    editor: 'system',
    agentFontSize: 14,
    sessionFoldWorkRuns: true,
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
  setAgentFontSize: (fontSize) => {
    const normalized = Math.min(MAX_UI_FONT_SIZE, Math.max(MIN_UI_FONT_SIZE, Math.round(fontSize)))
    set((state) => ({ preferences: { ...state.preferences, agentFontSize: normalized } }))
    localStorage.setItem(storageKey, JSON.stringify(useShellStore.getState().preferences))
    applyUiFontSize(normalized)
  },
  setSessionFoldWorkRuns: (value) => {
    set((state) => ({ preferences: { ...state.preferences, sessionFoldWorkRuns: value } }))
    localStorage.setItem(storageKey, JSON.stringify(useShellStore.getState().preferences))
  },
  addProject: (project) => {
    projectMutationVersion++
    set((state) => ({
      projects: [project, ...state.projects.filter(p => p.id !== project.id)],
      currentProjectId: project.id,
    }))
  },
  setProjects: (list) => {
    projectMutationVersion++
    set(() => ({ projects: list }))
  },
  removeProject: (projectId) => {
    projectMutationVersion++
    set((state) => ({
      projects: state.projects.filter(p => p.id !== projectId),
      currentProjectId: state.currentProjectId === projectId ? null : state.currentProjectId,
    }))
  },
  updateProject: (projectId, updates) => {
    projectMutationVersion++
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
    const version = ++projectFetchVersion
    const mutationVersion = projectMutationVersion
    try {
      const { projectApi } = await import('../../lib/api/project')
      const { items } = await projectApi.listProjects(undefined, { throwOnError: true })
      if (version !== projectFetchVersion) return
      if (mutationVersion !== projectMutationVersion) {
        // A project was changed while this snapshot was in flight. Fetch a fresh
        // snapshot without briefly restoring removed projects or losing new ones.
        await get().fetchProjects()
        return
      }
      set({ projects: items, projectsLoaded: true })
    } catch {
      // A failed request is not an empty project list. Retry on connectivity recovery.
    }
  },
}))

export function startProjectRecovery(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastRefreshAt = -Infinity
  const refresh = () => {
    timer = undefined
    if (useApiConnectivityStore.getState().shouldSkipRequest()) return
    lastRefreshAt = Date.now()
    void useShellStore.getState().fetchProjects()
  }
  const unsubscribe = useApiConnectivityStore.subscribe((state, previous) => {
    if (state.recoveryVersion === previous.recoveryVersion || state.shouldSkipRequest() || timer) return
    // A healthy /health endpoint must not create an immediate retry loop when
    // /projects itself fails. Coalesce recoveries and retry at most every 10s.
    const delay = Math.max(0, lastRefreshAt + 10_000 - Date.now())
    if (delay > 0) timer = setTimeout(refresh, delay)
    else refresh()
  })
  return () => {
    unsubscribe()
    if (timer) clearTimeout(timer)
  }
}

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
    if (typeof parsed.agentFontSize === 'number' && parsed.agentFontSize >= MIN_UI_FONT_SIZE && parsed.agentFontSize <= MAX_UI_FONT_SIZE) {
      patch.agentFontSize = Math.round(parsed.agentFontSize)
    }
    if (typeof parsed.sessionFoldWorkRuns === 'boolean') patch.sessionFoldWorkRuns = parsed.sessionFoldWorkRuns
    if (Object.keys(patch).length > 0) {
      useShellStore.setState((state) => ({
        preferences: { ...state.preferences, ...patch },
      }))
    }
    const agentFontSize = useShellStore.getState().preferences.agentFontSize
    applyUiFontSize(agentFontSize)
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
