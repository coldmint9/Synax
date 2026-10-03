import { create } from "zustand";
import { systemTheme } from "../lib/appearance";
import {
  applyCurrentThemeRuntime,
  ensureThemeRuntime,
  hydrateThemePreferences,
  startThemeRuntime,
  useThemeStore,
  type ThemeMode,
  type ResolvedTheme,
} from "./themeStore";
import { useApiConnectivityStore } from "../lib/apiConnectivity";
import { mergeTheme } from "../lib/theme/normalize";
import { resolveThemeTokens } from "../lib/theme/runtime";
import { AppError } from "../lib/appError";
import { listProjects } from "../../adapters/transport/project-list";

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
  userMessageFontWeight: number;
  /** Fold runs of activity-only agent turns into one work-log row. */
  sessionFoldWorkRuns: boolean;
  sessionListDisplayMode: "title" | "preview";
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
  setUserMessageFontWeight: (fontWeight: number) => void;
  setSessionFoldWorkRuns: (value: boolean) => void;
  setSessionListDisplayMode: (
    value: ShellPreferences["sessionListDisplayMode"],
  ) => void;
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
const DEFAULT_USER_MESSAGE_FONT_WEIGHT = 450;
const MIN_USER_MESSAGE_FONT_WEIGHT = 100;
const MAX_USER_MESSAGE_FONT_WEIGHT = 900;
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
  if (typeof document === "undefined" || !document.documentElement) return;
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
  resolvedTheme: useThemeStore.getState().resolvedTheme,
  preferences: {
    // Deprecated compatibility projection. Theme ownership lives in themeStore.
    theme: useThemeStore.getState().mode,
    accentColor: useThemeStore.getState().activeTheme.colors.light.accent,
    defaultHome: "global-home",
    notifications: true,
    locale: "zh",
    editor: "system",
    agentFontSize: 14,
    userMessageFontWeight: DEFAULT_USER_MESSAGE_FONT_WEIGHT,
    sessionFoldWorkRuns: true,
    sessionListDisplayMode: "preview",
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
    useThemeStore.getState().setMode(theme);
    ensureThemeRuntime();
  },
  setAccentColor: (color) => {
    useThemeStore.getState().setAccentColor(color);
    ensureThemeRuntime();
  },
  setLocale: (locale) => {
    set((state) => ({ preferences: { ...state.preferences, locale } }));
    persistShellPreferences();
  },
  setDefaultHome: (defaultHome) => {
    set((state) => ({ preferences: { ...state.preferences, defaultHome } }));
    persistShellPreferences();
  },
  setNotifications: (notifications) => {
    set((state) => ({ preferences: { ...state.preferences, notifications } }));
    persistShellPreferences();
  },
  setEditor: (editor) => {
    set((state) => ({ preferences: { ...state.preferences, editor } }));
    persistShellPreferences();
  },
  setAgentFontSize: (fontSize) => {
    const normalized = Math.min(
      MAX_UI_FONT_SIZE,
      Math.max(MIN_UI_FONT_SIZE, Math.round(fontSize)),
    );
    set((state) => ({
      preferences: { ...state.preferences, agentFontSize: normalized },
    }));
    persistShellPreferences();
    applyUiFontSize(normalized);
  },
  setUserMessageFontWeight: (fontWeight) => {
    const normalized = Math.min(
      MAX_USER_MESSAGE_FONT_WEIGHT,
      Math.max(MIN_USER_MESSAGE_FONT_WEIGHT, Math.round(fontWeight)),
    );
    set((state) => ({
      preferences: { ...state.preferences, userMessageFontWeight: normalized },
    }));
    persistShellPreferences();
  },
  setSessionFoldWorkRuns: (value) => {
    set((state) => ({
      preferences: { ...state.preferences, sessionFoldWorkRuns: value },
    }));
    persistShellPreferences();
  },
  setSessionListDisplayMode: (value) => {
    set((state) => ({
      preferences: { ...state.preferences, sessionListDisplayMode: value },
    }));
    persistShellPreferences();
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
      const { items } = await listProjects(undefined, {
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

function getShellStorage(): Storage | null {
  if (typeof globalThis === "undefined" || !("localStorage" in globalThis)) return null;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function persistShellPreferences(): void {
  const storage = getShellStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey, JSON.stringify(useShellStore.getState().preferences));
  } catch {
    // Non-theme shell preferences remain usable when browser storage is unavailable.
  }
}

function syncShellThemeMirror(): void {
  const theme = useThemeStore.getState();
  useShellStore.setState((state) => ({
    preferences: {
      ...state.preferences,
      theme: theme.mode,
      accentColor: theme.activeTheme.colors.light.accent,
    },
    resolvedTheme: theme.resolvedTheme,
  }));
}

const stopThemeMirror = useThemeStore.subscribe((state) => {
  useShellStore.setState((shell) => ({
    preferences: {
      ...shell.preferences,
      theme: state.mode,
      accentColor: state.activeTheme.colors.light.accent,
    },
    resolvedTheme: state.resolvedTheme,
  }));
});
if (import.meta.hot) import.meta.hot.dispose(stopThemeMirror);
syncShellThemeMirror();

export function hydrateShellPreferences() {
  hydrateThemePreferences();
  try {
    const storage = getShellStorage();
    const raw = storage?.getItem(storageKey);
    const parsed = (raw ? JSON.parse(raw) : {}) as Partial<ShellPreferences>;
    if (!parsed || typeof parsed !== "object") return;
    const patch: Partial<ShellPreferences> = {};
    if (parsed.locale === "zh" || parsed.locale === "en")
      patch.locale = parsed.locale;
    if (
      parsed.defaultHome === "global-home" ||
      parsed.defaultHome === "last-project"
    )
      patch.defaultHome = parsed.defaultHome;
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
    if (
      typeof parsed.userMessageFontWeight === "number" &&
      parsed.userMessageFontWeight >= MIN_USER_MESSAGE_FONT_WEIGHT &&
      parsed.userMessageFontWeight <= MAX_USER_MESSAGE_FONT_WEIGHT
    ) {
      patch.userMessageFontWeight = Math.round(parsed.userMessageFontWeight);
    }
    if (typeof parsed.sessionFoldWorkRuns === "boolean")
      patch.sessionFoldWorkRuns = parsed.sessionFoldWorkRuns;
    if (
      parsed.sessionListDisplayMode === "title" ||
      parsed.sessionListDisplayMode === "preview"
    ) {
      patch.sessionListDisplayMode = parsed.sessionListDisplayMode;
    }
    if (Object.keys(patch).length > 0) {
      useShellStore.setState((state) => ({
        preferences: { ...state.preferences, ...patch },
      }));
    }
    const agentFontSize = useShellStore.getState().preferences.agentFontSize;
    applyUiFontSize(agentFontSize);
  } catch {
    // Ignore unavailable storage or broken preference payloads.
  }
  syncShellThemeMirror();
}

export function startShellAppearance(): () => void {
  // Legacy callers can continue to start appearance handling while the actual
  // runtime and persistence are owned by themeStore.
  const shellTheme = useShellStore.getState().preferences.theme;
  const shellAccent = useShellStore.getState().preferences.accentColor;
  const currentTheme = useThemeStore.getState();
  // Do not flatten imported light/dark accents when the mirror is unchanged.
  const activeTheme = shellAccent === currentTheme.activeTheme.colors.light.accent
    ? currentTheme.activeTheme
    : mergeTheme(currentTheme.activeTheme, {
      colors: {
        light: { accent: shellAccent },
        dark: { accent: shellAccent },
      },
    });
  // Legacy in-memory fixtures are supported without writing either preference key.
  const resolvedTheme = shellTheme === "system" ? systemTheme() : shellTheme;
  useThemeStore.setState({
    mode: shellTheme,
    activeTheme,
    source: currentTheme.source,
    resolvedTheme,
    resolvedTokens: resolveThemeTokens(activeTheme, resolvedTheme),
  });
  applyCurrentThemeRuntime();
  const stopRuntime = startThemeRuntime();
  const onLegacyStorage = (event: StorageEvent) => {
    if (event.key !== storageKey || !event.newValue) return;
    try {
      const parsed = JSON.parse(event.newValue) as Partial<ShellPreferences>;
      if (parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system")
        useThemeStore.getState().setMode(parsed.theme);
      if (typeof parsed.accentColor === "string")
        useThemeStore.getState().setAccentColor(parsed.accentColor);
    } catch {
      // Legacy storage is untrusted input.
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onLegacyStorage);
  return () => {
    stopRuntime();
    if (typeof window !== "undefined") window.removeEventListener("storage", onLegacyStorage);
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
