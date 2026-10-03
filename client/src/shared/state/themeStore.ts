import { create } from "zustand";
import {
  DEFAULT_ACCENT,
  normalizeAccent,
  systemTheme,
} from "../lib/appearance";
import { DEFAULT_THEME } from "../lib/theme/defaults";
import type {
  NormalizedTheme,
  PortableTheme,
  ResolvedTheme,
  ThemeImportResult,
  ThemeMode,
  ThemeSource,
} from "../lib/theme/contract";
import { readThemeFile } from "../lib/theme/io";
import { mergeTheme, normalizeTheme, themeToExport } from "../lib/theme/normalize";
import { applyThemeRuntime, resolveThemeTokens, type ResolvedThemeTokens } from "../lib/theme/runtime";

export const THEME_STORAGE_KEY = "synax-theme-preferences";
const THEME_PREFERENCES_VERSION = 1 as const;
const LEGACY_SHELL_STORAGE_KEY = "rumbling-shell-preferences";

type PersistedThemePreferences = {
  schemaVersion: typeof THEME_PREFERENCES_VERSION;
  mode: ThemeMode;
  theme: PortableTheme;
  source: ThemeSource;
};

export interface ThemeState {
  mode: ThemeMode;
  activeTheme: NormalizedTheme;
  source: ThemeSource;
  resolvedTheme: ResolvedTheme;
  resolvedTokens: ResolvedThemeTokens;
  setMode: (mode: ThemeMode) => void;
  /** Compatibility alias for consumers migrating from shellStore. */
  setTheme: (mode: ThemeMode) => void;
  toggleMode: () => void;
  setActiveTheme: (theme: NormalizedTheme, source?: ThemeSource) => void;
  setAccentColor: (accentColor: string) => void;
  resetTheme: () => void;
}

function getStorage(): Storage | null {
  if (typeof globalThis === "undefined" || !("localStorage" in globalThis)) return null;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function getResolvedTheme(mode: ThemeMode): ResolvedTheme {
  return mode === "system" ? systemTheme() : mode;
}

function stateProjection(mode: ThemeMode, activeTheme: NormalizedTheme) {
  const resolvedTheme = getResolvedTheme(mode);
  return {
    resolvedTheme,
    resolvedTokens: resolveThemeTokens(activeTheme, resolvedTheme),
  };
}

function persistState(state: Pick<ThemeState, "mode" | "activeTheme" | "source">): void {
  const storage = getStorage();
  if (!storage) return;
  const payload: PersistedThemePreferences = {
    schemaVersion: THEME_PREFERENCES_VERSION,
    mode: state.mode,
    theme: themeToExport(state.activeTheme),
    source: state.source,
  };
  try {
    storage.setItem(THEME_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Themes remain usable in memory when browser storage is unavailable.
  }
}

function validMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePersistedPayload(raw: string): {
  mode: ThemeMode;
  activeTheme: NormalizedTheme;
  source: ThemeSource;
} | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const isCanonical = "schemaVersion" in parsed;
    if ((isCanonical ? parsed.schemaVersion : parsed.version) !== THEME_PREFERENCES_VERSION)
      return null;
    if (!validMode(parsed.mode)) return null;
    if (parsed.source !== "builtin" && parsed.source !== "imported") return null;
    // The original Task 3 shape is a read-only fallback, never a write format.
    const activeTheme = normalizeTheme(isCanonical ? parsed.theme : parsed.activeTheme);
    const mode = parsed.mode;
    const source = parsed.source;
    return { mode, activeTheme, source };
  } catch {
    return null;
  }
}

function parseLegacyPayload(raw: string): { mode: ThemeMode; activeTheme: NormalizedTheme } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const mode = validMode(parsed.theme) ? parsed.theme : "system";
    const accentColor = normalizeAccent(parsed.accentColor) ?? DEFAULT_ACCENT;
    const activeTheme = normalizeTheme({
      version: 1,
      id: DEFAULT_THEME.id,
      name: DEFAULT_THEME.name,
      colors: {
        light: { accent: accentColor },
        dark: { accent: accentColor },
      },
    });
    return { mode, activeTheme };
  } catch {
    return null;
  }
}

function applyPersistedState(
  persisted: { mode: ThemeMode; activeTheme: NormalizedTheme; source: ThemeSource },
): void {
  useThemeStore.setState({
    ...persisted,
    ...stateProjection(persisted.mode, persisted.activeTheme),
  });
}

function applyRawStorageValue(raw: string, persist = false): boolean {
  const persisted = parsePersistedPayload(raw);
  if (!persisted) return false;
  applyPersistedState(persisted);
  if (persist) persistState(persisted);
  return true;
}

function resetToDefault(persist = false): void {
  const next = {
    mode: "system" as const,
    activeTheme: DEFAULT_THEME,
    source: "builtin" as const,
  };
  applyPersistedState(next);
  if (persist) persistState(next);
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: "system",
  activeTheme: DEFAULT_THEME,
  source: "builtin",
  ...stateProjection("system", DEFAULT_THEME),
  setMode: (mode) => {
    if (!validMode(mode)) return;
    set((state) => ({ ...stateProjection(mode, state.activeTheme), mode }));
    persistState(get());
  },
  setTheme: (mode) => {
    get().setMode(mode);
  },
  toggleMode: () => {
    const state = get();
    state.setMode(state.resolvedTheme === "dark" ? "light" : "dark");
  },
  setActiveTheme: (activeTheme, source = "imported") => {
    set((state) => ({
      ...stateProjection(state.mode, activeTheme),
      activeTheme,
      source,
    }));
    persistState(get());
  },
  setAccentColor: (value) => {
    const accentColor = normalizeAccent(value);
    if (!accentColor) return;
    const activeTheme = mergeTheme(get().activeTheme, {
      colors: {
        light: { accent: accentColor },
        dark: { accent: accentColor },
      },
    });
    set((state) => ({
      ...stateProjection(state.mode, activeTheme),
      activeTheme,
      source: state.source === "builtin" ? "builtin" : "imported",
    }));
    persistState(get());
  },
  resetTheme: () => {
    set((state) => ({
      ...stateProjection(state.mode, DEFAULT_THEME),
      activeTheme: DEFAULT_THEME,
      source: "builtin",
    }));
    persistState(get());
  },
}));

/** Load the new theme payload, or perform the one-time legacy shell migration. */
export function hydrateThemePreferences(): void {
  const storage = getStorage();
  if (!storage) return;

  let newRaw: string | null = null;
  try {
    newRaw = storage.getItem(THEME_STORAGE_KEY);
  } catch {
    return;
  }

  if (newRaw && applyRawStorageValue(newRaw)) return;

  let legacyRaw: string | null = null;
  try {
    legacyRaw = storage.getItem(LEGACY_SHELL_STORAGE_KEY);
  } catch {
    return;
  }
  if (!legacyRaw) return;
  const legacy = parseLegacyPayload(legacyRaw);
  if (!legacy) return;
  const migrated = { ...legacy, source: "builtin" as const };
  applyPersistedState(migrated);
  persistState(migrated);
}

/** Refresh derived state and DOM synchronously without installing listeners. */
export function applyCurrentThemeRuntime(): void {
  const state = useThemeStore.getState();
  const projection = stateProjection(state.mode, state.activeTheme);
  useThemeStore.setState(projection);
  applyThemeRuntime(state.activeTheme, projection.resolvedTheme);
}

let activeRuntimeCleanup: (() => void) | null = null;

/** Apply the theme projection and connect browser/system/storage synchronisation. */
export function startThemeRuntime(): () => void {
  if (activeRuntimeCleanup) {
    applyCurrentThemeRuntime();
    return activeRuntimeCleanup;
  }
  if (typeof window === "undefined") {
    applyCurrentThemeRuntime();
    return () => {};
  }
  const runtimeWindow = window;
  let media: MediaQueryList | undefined;
  let mediaListener: (() => void) | undefined;

  const removeMediaListener = () => {
    if (!media || !mediaListener) return;
    if (typeof media.removeEventListener === "function")
      media.removeEventListener("change", mediaListener);
    else media.removeListener?.(mediaListener);
    media = undefined;
    mediaListener = undefined;
  };

  const syncMediaListener = () => {
    const shouldListen = useThemeStore.getState().mode === "system";
    if (!shouldListen || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      removeMediaListener();
      return;
    }
    if (media) return;
    media = window.matchMedia("(prefers-color-scheme: dark)");
    mediaListener = () => {
      if (useThemeStore.getState().mode !== "system") return;
      applyCurrent();
    };
    if (typeof media.addEventListener === "function") media.addEventListener("change", mediaListener);
    else media.addListener?.(mediaListener);
  };

  let applying = false;
  const applyCurrent = () => {
    if (applying) return;
    applying = true;
    try {
      applyCurrentThemeRuntime();
      syncMediaListener();
    } finally {
      applying = false;
    }
  };

  applyCurrent();
  const unsubscribe = useThemeStore.subscribe((state, previous) => {
    if (
      state.mode !== previous.mode ||
      state.activeTheme !== previous.activeTheme ||
      state.resolvedTheme !== previous.resolvedTheme
    ) {
      applyCurrent();
    }
  });

  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    if (event.newValue === null) {
      resetToDefault(false);
      return;
    }
    applyRawStorageValue(event.newValue);
  };
  runtimeWindow.addEventListener("storage", onStorage);

  const cleanup = () => {
    unsubscribe();
    removeMediaListener();
    runtimeWindow.removeEventListener("storage", onStorage);
    if (activeRuntimeCleanup === cleanup) activeRuntimeCleanup = null;
  };
  activeRuntimeCleanup = cleanup;
  return cleanup;
}

/** Start the singleton runtime when a compatibility caller mutates the theme. */
export function ensureThemeRuntime(): () => void {
  return startThemeRuntime();
}

export async function importThemeFile(file: Blob): Promise<ThemeImportResult> {
  const result = await readThemeFile(file);
  if (result.ok) useThemeStore.getState().setActiveTheme(result.theme, "imported");
  return result;
}

export function exportActiveTheme(): PortableTheme {
  return themeToExport(useThemeStore.getState().activeTheme);
}


export function getResolvedThemeTokens(): ResolvedThemeTokens {
  return useThemeStore.getState().resolvedTokens;
}

export type { ResolvedTheme, ThemeMode, ThemeSource };
