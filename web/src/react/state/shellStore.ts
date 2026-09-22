import { create } from "zustand";
import {
  applyAppearance,
  DEFAULT_ACCENT,
  normalizeAccent,
  systemTheme,
  type ThemeMode,
  type ResolvedTheme,
} from "../../lib/appearance";
import { useApiConnectivityStore } from "../../lib/apiConnectivity";
import { AppError } from "../../lib/appError";

export interface ProjectSummary {
  id: string;
  name: string;
  status: "healthy" | "at_risk" | "blocked";
  environment: "production" | "staging" | "development";
  healthScore: number;
  activeAgents: number;
  activeHumans: number;
  openRisks: number;
  updatedAt: string;
  source?: {
    kind: "scratch" | "github" | "gitlab" | "localPath" | "wsl";
    repo?: string;
    branch?: string;
    /** 本地目录导入时的绝对或相对路径（与后端 `source.localPath` 对应） */
    localPath?: string;
    distribution?: string;
    wslPath?: string;
  };
  importState?: "idle" | "syncing" | "ready" | "failed";
  importError?: string;
  createdBy?: string;
  createdAt?: string;
}

export interface ShellPreferences {
  theme: ThemeMode;
  accentColor: string;
  defaultHome: "global-home" | "last-project";
  notifications: boolean;
  locale: "zh" | "en";
  editor: string;
  agentFontSize: number;
  wikiEnabled: boolean;
  /** Fold runs of activity-only agent turns into one work-log row. */
  sessionFoldWorkRuns: boolean;
}

export interface ProjectSearchFilter {
  search: string;
  statusFilter: string[];
  environmentFilter: string[];
  sortBy: "name" | "healthScore" | "updatedAt" | "createdAt";
  sortOrder: "asc" | "desc";
}

interface ShellState {
  projects: ProjectSummary[];
  projectsLoaded: boolean;
  preferences: ShellPreferences;
  resolvedTheme: ResolvedTheme;
  currentProjectId: string | null;
  currentUser: {
    id: string;
    name: string;
    email: string;
  };
  /** Search/filter state for project list */
  projectFilter: ProjectSearchFilter;
  setTheme: (theme: ShellPreferences["theme"]) => void;
  setAccentColor: (color: string) => void;
  setLocale: (locale: ShellPreferences["locale"]) => void;
  setDefaultHome: (defaultHome: ShellPreferences["defaultHome"]) => void;
  setNotifications: (notifications: boolean) => void;
  setEditor: (editor: ShellPreferences["editor"]) => void;
  setAgentFontSize: (fontSize: number) => void;
  setWikiEnabled: (enabled: boolean) => void;
  setSessionFoldWorkRuns: (value: boolean) => void;
  addProject: (project: ProjectSummary) => void;
  setProjects: (projects: ProjectSummary[]) => void;
  removeProject: (projectId: string) => void;
  updateProject: (projectId: string, updates: Partial<ProjectSummary>) => void;
  setProjectFilter: (filter: Partial<ProjectSearchFilter>) => void;
  setCurrentProjectId: (projectId: string | null) => void;
  fetchProjects: () => Promise<void>;
}

const storageKey = "rumbling-shell-preferences";
const DEFAULT_UI_FONT_SIZE = 14;
const MIN_UI_FONT_SIZE = 12;
const MAX_UI_FONT_SIZE = 20;
let projectFetchVersion = 0;
let projectMutationVersion = 0;
const PROJECT_RETRY_DELAY_MS = 10_000;
let projectRetryTimer: ReturnType<typeof setTimeout> | undefined;

function clearProjectRetry(): void {
  if (projectRetryTimer) clearTimeout(projectRetryTimer);
  projectRetryTimer = undefined;
}

function scheduleProjectRetry(delay = PROJECT_RETRY_DELAY_MS): void {
  if (projectRetryTimer) return;
  projectRetryTimer = setTimeout(() => {
    projectRetryTimer = undefined;
    if (useApiConnectivityStore.getState().shouldSkipRequest()) return;
    void useShellStore.getState().fetchProjects();
  }, delay);
}

function applyUiFontSize(fontSize: number): void {
  const normalized = Math.min(
    MAX_UI_FONT_SIZE,
    Math.max(MIN_UI_FONT_SIZE, Math.round(fontSize)),
  );
  document.documentElement.style.setProperty(
    "--ui-font-size",
    `${normalized}px`,
  );
  document.documentElement.style.setProperty(
    "--ui-font-scale",
    String(normalized / DEFAULT_UI_FONT_SIZE),
  );
}

export const useShellStore = create<ShellState>((set, get) => ({
  projects: [],
  projectsLoaded: false,
  resolvedTheme: systemTheme(),
  preferences: {
    theme: "system",
    accentColor: DEFAULT_ACCENT,
    defaultHome: "global-home",
    notifications: true,
    locale: "zh",
    editor: "system",
    agentFontSize: 14,
    wikiEnabled: false,
    sessionFoldWorkRuns: true,
  },
  currentProjectId: null,
  currentUser: {
    id: "u-alice",
    name: "Alice Chen",
    email: "alice@rumbling.local",
  },
  projectFilter: {
    search: "",
    statusFilter: [],
    environmentFilter: [],
    sortBy: "createdAt",
    sortOrder: "desc",
  },
  setTheme: (theme) => {
    set((state) => ({ preferences: { ...state.preferences, theme } }));
    syncShellAppearance();
    persistAppearance();
  },
  setAccentColor: (color) => {
    const accentColor = normalizeAccent(color);
    if (!accentColor) return;
    set((state) => ({ preferences: { ...state.preferences, accentColor } }));
    syncShellAppearance();
    persistAppearance();
  },
  setLocale: (locale) => {
    set((state) => ({ preferences: { ...state.preferences, locale } }));
    localStorage.setItem(
      storageKey,
      JSON.stringify(useShellStore.getState().preferences),
    );
  },
  setDefaultHome: (defaultHome) => {
    set((state) => ({ preferences: { ...state.preferences, defaultHome } }));
    localStorage.setItem(
      storageKey,
      JSON.stringify(useShellStore.getState().preferences),
    );
  },
  setNotifications: (notifications) => {
    set((state) => ({ preferences: { ...state.preferences, notifications } }));
    localStorage.setItem(
      storageKey,
      JSON.stringify(useShellStore.getState().preferences),
    );
  },
  setEditor: (editor) => {
    set((state) => ({ preferences: { ...state.preferences, editor } }));
    localStorage.setItem(
      storageKey,
      JSON.stringify(useShellStore.getState().preferences),
    );
  },
  setWikiEnabled: (wikiEnabled) => {
    set((state) => ({ preferences: { ...state.preferences, wikiEnabled } }));
    localStorage.setItem(storageKey, JSON.stringify(get().preferences));
  },
  setAgentFontSize: (fontSize) => {
    const normalized = Math.min(
      MAX_UI_FONT_SIZE,
      Math.max(MIN_UI_FONT_SIZE, Math.round(fontSize)),
    );
    set((state) => ({
      preferences: { ...state.preferences, agentFontSize: normalized },
    }));
    localStorage.setItem(
      storageKey,
      JSON.stringify(useShellStore.getState().preferences),
    );
    applyUiFontSize(normalized);
  },
  setSessionFoldWorkRuns: (value) => {
    set((state) => ({
      preferences: { ...state.preferences, sessionFoldWorkRuns: value },
    }));
    localStorage.setItem(
      storageKey,
      JSON.stringify(useShellStore.getState().preferences),
    );
  },
  addProject: (project) => {
    projectMutationVersion++;
    set((state) => ({
      projects: [project, ...state.projects.filter((p) => p.id !== project.id)],
      currentProjectId: project.id,
    }));
  },
  setProjects: (list) => {
    projectMutationVersion++;
    set(() => ({ projects: list }));
  },
  removeProject: (projectId) => {
    projectMutationVersion++;
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== projectId),
      currentProjectId:
        state.currentProjectId === projectId ? null : state.currentProjectId,
    }));
  },
  updateProject: (projectId, updates) => {
    projectMutationVersion++;
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === projectId ? { ...p, ...updates } : p,
      ),
    }));
  },
  setProjectFilter: (filter) => {
    set((state) => ({
      projectFilter: { ...state.projectFilter, ...filter },
    }));
  },
  setCurrentProjectId: (projectId) => {
    set(() => ({ currentProjectId: projectId }));
  },
  fetchProjects: async () => {
    const version = ++projectFetchVersion;
    const mutationVersion = projectMutationVersion;
    try {
      const { projectApi } = await import("../../lib/api/project");
      const { items } = await projectApi.listProjects(undefined, {
        throwOnError: true,
      });
      if (version !== projectFetchVersion) return;
      if (mutationVersion !== projectMutationVersion) {
        // A project was changed while this snapshot was in flight. Fetch a fresh
        // snapshot without briefly restoring removed projects or losing new ones.
        await get().fetchProjects();
        return;
      }
      clearProjectRetry();
      set({ projects: items, projectsLoaded: true });
    } catch (error) {
      // A failed request is not an empty project list. Endpoint-level 5xx
      // failures retry locally; transport failures wait for health recovery.
      if (
        error instanceof AppError &&
        error.statusCode !== undefined &&
        error.statusCode >= 500 &&
        !useApiConnectivityStore.getState().shouldSkipRequest()
      ) {
        scheduleProjectRetry();
      }
    }
  },
}));

export function startProjectRecovery(): () => void {
  const unsubscribe = useApiConnectivityStore.subscribe((state, previous) => {
    if (
      state.recoveryVersion === previous.recoveryVersion ||
      state.shouldSkipRequest()
    )
      return;
    // Transport recovery retries immediately unless an endpoint-level backoff
    // is already pending, in which case the existing deadline is preserved.
    scheduleProjectRetry(0);
  });
  return () => {
    unsubscribe();
    clearProjectRetry();
  };
}

export function hydrateShellPreferences() {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = (raw ? JSON.parse(raw) : {}) as Partial<ShellPreferences>;
    if (!parsed || typeof parsed !== "object") return;
    const patch: Partial<ShellPreferences> = {};
    if (
      parsed.theme === "light" ||
      parsed.theme === "dark" ||
      parsed.theme === "system"
    )
      patch.theme = parsed.theme;
    const accentColor = normalizeAccent(parsed.accentColor);
    if (accentColor) patch.accentColor = accentColor;
    if (parsed.locale === "zh" || parsed.locale === "en")
      patch.locale = parsed.locale;
    if (
      parsed.defaultHome === "global-home" ||
      parsed.defaultHome === "last-project"
    )
      patch.defaultHome = parsed.defaultHome;
    if (typeof parsed.wikiEnabled === "boolean")
      patch.wikiEnabled = parsed.wikiEnabled;
    if (typeof parsed.notifications === "boolean")
      patch.notifications = parsed.notifications;
    if (typeof parsed.editor === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(parsed.editor))
      patch.editor = parsed.editor;
    if (
      typeof parsed.agentFontSize === "number" &&
      parsed.agentFontSize >= MIN_UI_FONT_SIZE &&
      parsed.agentFontSize <= MAX_UI_FONT_SIZE
    ) {
      patch.agentFontSize = Math.round(parsed.agentFontSize);
    }
    if (typeof parsed.sessionFoldWorkRuns === "boolean")
      patch.sessionFoldWorkRuns = parsed.sessionFoldWorkRuns;
    if (Object.keys(patch).length > 0) {
      useShellStore.setState((state) => ({
        preferences: { ...state.preferences, ...patch },
      }));
    }
    const agentFontSize = useShellStore.getState().preferences.agentFontSize;
    applyUiFontSize(agentFontSize);
  } catch {
    // Ignore unavailable storage or broken preference payloads.
  } finally {
    syncShellAppearance();
  }
}

function persistAppearance() {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(useShellStore.getState().preferences),
    );
  } catch {
    // Appearance remains usable when browser storage is unavailable.
  }
}

function syncShellAppearance() {
  const { preferences, resolvedTheme } = useShellStore.getState();
  const next =
    preferences.theme === "system" ? systemTheme() : preferences.theme;
  applyAppearance(next, preferences.accentColor);
  if (next !== resolvedTheme) useShellStore.setState({ resolvedTheme: next });
}

export function startShellAppearance(): () => void {
  syncShellAppearance();
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystemChange = () => {
    if (useShellStore.getState().preferences.theme === "system")
      syncShellAppearance();
  };
  media.addEventListener("change", onSystemChange);
  const unsubscribe = useShellStore.subscribe((state, previous) => {
    if (
      state.preferences.theme !== previous.preferences.theme ||
      state.preferences.accentColor !== previous.preferences.accentColor
    )
      syncShellAppearance();
  });
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey && event.newValue) hydrateShellPreferences();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    media.removeEventListener("change", onSystemChange);
    window.removeEventListener("storage", onStorage);
    unsubscribe();
  };
}

export function getProjectById(projectId: string) {
  return (
    useShellStore.getState().projects.find((p) => p.id === projectId) ?? null
  );
}

export function addProject(project: ProjectSummary) {
  useShellStore.getState().addProject(project);
}
