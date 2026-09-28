import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCENT } from "../../../lib/appearance";
import { DEFAULT_THEME } from "../../../lib/theme/defaults";
import { mergeTheme } from "../../../lib/theme/normalize";
import {
  ensureThemeRuntime,
  exportActiveTheme,
  hydrateThemePreferences,
  importThemeFile,
  startThemeRuntime,
  THEME_STORAGE_KEY,
  useThemeStore,
} from "../themeStore";
import { hydrateShellPreferences, startShellAppearance, useShellStore } from "../shellStore";

const legacyKey = "rumbling-shell-preferences";
let stopRuntime: (() => void) | undefined;
let systemDark = false;
let activeMedia: (MediaQueryList & { emit: () => void }) | undefined;

function mockMatchMedia() {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const listeners = new Set<() => void>();
    const media = {
      media: query,
      get matches() {
        return systemDark;
      },
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
      dispatchEvent: () => true,
      emit() {
        for (const listener of listeners) listener();
      },
    } as unknown as MediaQueryList & { emit: () => void };
    activeMedia = media;
    return media;
  });
}

beforeEach(() => {
  localStorage.clear();
  systemDark = false;
  activeMedia = undefined;
  useThemeStore.setState({
    mode: "system",
    activeTheme: DEFAULT_THEME,
    source: "builtin",
    resolvedTheme: "light",
    resolvedTokens: {
      colors: { ...DEFAULT_THEME.colors.light },
      shape: { ...DEFAULT_THEME.shape },
      effects: { ...DEFAULT_THEME.effects.light },
    },
  });
  mockMatchMedia();
});

afterEach(() => {
  stopRuntime?.();
  stopRuntime = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (typeof localStorage !== "undefined") localStorage.clear();
});

describe("theme store", () => {
  it("migrates the old shell appearance preferences once", () => {
    localStorage.setItem(
      legacyKey,
      JSON.stringify({ theme: "dark", accentColor: "#98aecb", locale: "zh" }),
    );

    hydrateThemePreferences();

    expect(useThemeStore.getState().mode).toBe("dark");
    expect(useThemeStore.getState().activeTheme.colors.dark.accent).toBe("#98aecb");
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toMatchObject({
      schemaVersion: 1,
      mode: "dark",
      theme: { colors: { dark: { accent: "#98aecb" } } },
      source: "builtin",
    });
    expect(JSON.parse(localStorage.getItem(legacyKey)!)).toMatchObject({ locale: "zh" });
    localStorage.setItem(legacyKey, JSON.stringify({ theme: "light", accentColor: "#123456" }));
    hydrateThemePreferences();
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(useThemeStore.getState().activeTheme.colors.dark.accent).toBe("#98aecb");
  });

  it("prefers a valid new payload over legacy appearance preferences", () => {
    const imported = mergeTheme(DEFAULT_THEME, {
      id: "new-theme",
      name: "New Theme",
      colors: { dark: { accent: "#b1a2c9" } },
    });
    localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, mode: "light", theme: imported, source: "imported" }),
    );
    localStorage.setItem(legacyKey, JSON.stringify({ theme: "dark", accentColor: "#98aecb" }));

    hydrateThemePreferences();

    expect(useThemeStore.getState().mode).toBe("light");
    expect(useThemeStore.getState().activeTheme.id).toBe("new-theme");
    expect(useThemeStore.getState().activeTheme.colors.dark.accent).toBe("#b1a2c9");
  });

  it("does not replace the active theme when import validation fails", async () => {
    const before = useThemeStore.getState().activeTheme;
    await expect(importThemeFile(new File(["{bad"], "bad.json"))).resolves.toMatchObject({ ok: false });
    expect(useThemeStore.getState().activeTheme).toEqual(before);
  });

  it("persists mode and imported themes", async () => {
    useThemeStore.getState().setMode("dark");
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toMatchObject({
      schemaVersion: 1,
      mode: "dark",
      theme: expect.any(Object),
    });
    expect(Object.keys(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).sort()).toEqual(
      ["schemaVersion", "mode", "theme", "source"].sort(),
    );

    const result = await importThemeFile(
      new File([JSON.stringify({ version: 1, id: "mist-blue", name: "Mist Blue", colors: { light: { accent: "#98aecb" } } })], "mist.json"),
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toMatchObject({
      source: "imported",
      theme: { id: "mist-blue", colors: { light: { accent: "#98aecb" } } },
    });
    expect(exportActiveTheme().id).toBe("mist-blue");
  });

  it("does not write the legacy shell key when the theme changes", () => {
    const legacy = JSON.stringify({ theme: "light", accentColor: "#a1bba8", locale: "en" });
    localStorage.setItem(legacyKey, legacy);

    const writes = vi.spyOn(localStorage, "setItem");
    hydrateThemePreferences();
    useThemeStore.getState().setMode("dark");
    useThemeStore.getState().setAccentColor("#98aecb");
    useThemeStore.getState().resetTheme();
    useShellStore.getState().setTheme("light");
    useShellStore.getState().setAccentColor("#b1a2c9");
    stopRuntime = startThemeRuntime();
    window.dispatchEvent(new StorageEvent("storage", {
      key: THEME_STORAGE_KEY,
      newValue: JSON.stringify({ schemaVersion: 1, mode: "dark", theme: DEFAULT_THEME, source: "builtin" }),
    }));

    expect(localStorage.getItem(legacyKey)).toBe(legacy);
    expect(writes.mock.calls.every(([key]) => key === THEME_STORAGE_KEY)).toBe(true);
    useShellStore.getState().setLocale("en");
    expect(writes).toHaveBeenLastCalledWith(legacyKey, expect.any(String));
    expect(JSON.parse(localStorage.getItem(legacyKey)!)).toMatchObject({ locale: "en" });
  });

  it("refreshes resolved tokens when the mode stays the same", () => {
    useThemeStore.getState().setMode("light");
    const before = useThemeStore.getState().resolvedTokens;
    const nextTheme = mergeTheme(DEFAULT_THEME, {
      colors: { light: { accent: "#c49eaa" } },
    });

    useThemeStore.getState().setActiveTheme(nextTheme, "imported");

    expect(useThemeStore.getState().resolvedTheme).toBe("light");
    expect(useThemeStore.getState().resolvedTokens).not.toBe(before);
    expect(useThemeStore.getState().resolvedTokens.colors.accent).toBe("#c49eaa");
    useThemeStore.getState().setAccentColor("#98aecb");
    expect(useThemeStore.getState().resolvedTokens.colors.accent).toBe("#98aecb");
    const tokens = useThemeStore.getState().resolvedTokens;
    useThemeStore.getState().setMode("light");
    expect(useThemeStore.getState().resolvedTokens).not.toBe(tokens);
    expect(useThemeStore.getState().resolvedTokens.colors.accent).toBe("#98aecb");
  });

  it.each(["mode", "accent"])("applies the shell %s setter before runtime start without installing listeners", (first) => {
    document.documentElement.classList.remove("dark");
    document.documentElement.style.removeProperty("--theme-accent");
    const listeners = vi.spyOn(window, "addEventListener");
    if (first === "mode") {
      useShellStore.getState().setTheme("dark");
      expect(document.documentElement).toHaveClass("dark");
      expect(useShellStore.getState().resolvedTheme).toBe("dark");
    } else {
      useShellStore.getState().setAccentColor("#98aecb");
      expect(document.documentElement.style.getPropertyValue("--theme-accent")).toBe("#98aecb");
      expect(useThemeStore.getState().resolvedTokens.colors.accent).toBe("#98aecb");
    }
    expect(listeners.mock.calls.filter(([type]) => type === "storage")).toHaveLength(1);
    stopRuntime = ensureThemeRuntime();
    expect(ensureThemeRuntime()).toBe(stopRuntime);
  });

  it("refreshes same-mode tokens through startShellAppearance", () => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, theme: "light", accentColor: "#c49eaa" },
    }));
    stopRuntime = startShellAppearance();
    expect(useThemeStore.getState().resolvedTheme).toBe("light");
    expect(useThemeStore.getState().resolvedTokens.colors.accent).toBe("#c49eaa");
    expect(document.documentElement.style.getPropertyValue("--theme-accent")).toBe("#c49eaa");
  });

  it("does not flatten imported mode-specific accents when starting compatibility runtime", () => {
    const theme = mergeTheme(DEFAULT_THEME, { colors: { dark: { accent: "#c49eaa" } } });
    useThemeStore.getState().setActiveTheme(theme);
    stopRuntime = startShellAppearance();
    expect(useThemeStore.getState().activeTheme).toBe(theme);
    useThemeStore.getState().setMode("dark");
    expect(useThemeStore.getState().resolvedTokens.colors.accent).toBe("#c49eaa");
  });

  it("hydrates shell preferences and changes font size without a DOM", () => {
    localStorage.setItem(legacyKey, JSON.stringify({ theme: "dark", locale: "en", agentFontSize: 18 }));
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);
    try {
      expect(() => hydrateShellPreferences()).not.toThrow();
      expect(useShellStore.getState().preferences).toMatchObject({ locale: "en", agentFontSize: 18 });
      expect(useThemeStore.getState().resolvedTheme).toBe("dark");
      expect(() => useShellStore.getState().setAgentFontSize(16)).not.toThrow();
      expect(() => startThemeRuntime()()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts the old Task 3 payload only for reads and writes canonical preferences next", () => {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ version: 1, mode: "dark", activeTheme: DEFAULT_THEME, source: "builtin" }));
    hydrateThemePreferences();
    expect(useThemeStore.getState().mode).toBe("dark");
    useThemeStore.getState().setMode("light");
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toEqual({
      schemaVersion: 1, mode: "light", theme: exportActiveTheme(), source: "builtin",
    });
  });

  it.each([
    { schemaVersion: 2, version: 1, mode: "dark", activeTheme: DEFAULT_THEME, source: "builtin" },
    { schemaVersion: 1, mode: "wrong", theme: DEFAULT_THEME, source: "builtin" },
    { schemaVersion: 1, mode: "dark", source: "builtin" },
    { schemaVersion: 1, mode: "dark", theme: DEFAULT_THEME, source: "wrong" },
  ])("ignores invalid storage payloads without changing the active theme", (payload) => {
    stopRuntime = startThemeRuntime();
    const before = useThemeStore.getState();
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: JSON.stringify(payload) }));
    expect(useThemeStore.getState()).toBe(before);
  });

  it("resolves system mode, ignores system changes for manual modes, and syncs storage events", () => {
    stopRuntime = startThemeRuntime();
    expect(useThemeStore.getState().resolvedTheme).toBe("light");

    systemDark = true;
    activeMedia?.emit();
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");

    useThemeStore.getState().setMode("light");
    systemDark = false;
    activeMedia?.emit();
    expect(useThemeStore.getState().resolvedTheme).toBe("light");
    expect(document.documentElement).not.toHaveClass("dark");

    const nextTheme = mergeTheme(DEFAULT_THEME, { id: "from-window", colors: { light: { accent: "#c49eaa" } } });
    window.dispatchEvent(new StorageEvent("storage", {
      key: THEME_STORAGE_KEY,
      newValue: JSON.stringify({ schemaVersion: 1, mode: "dark", theme: nextTheme, source: "imported" }),
    }));
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(useThemeStore.getState().activeTheme.id).toBe("from-window");
  });

  it("keeps working when storage and window are unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => hydrateThemePreferences()).not.toThrow();
    expect(() => useThemeStore.getState().setAccentColor(DEFAULT_ACCENT)).not.toThrow();
    vi.stubGlobal("window", undefined);
    try {
      expect(() => { stopRuntime = startThemeRuntime(); }).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
