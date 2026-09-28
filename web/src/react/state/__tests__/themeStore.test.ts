import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCENT } from "../../../lib/appearance";
import { DEFAULT_THEME } from "../../../lib/theme/defaults";
import { mergeTheme } from "../../../lib/theme/normalize";
import {
  exportActiveTheme,
  hydrateThemePreferences,
  importThemeFile,
  startThemeRuntime,
  THEME_STORAGE_KEY,
  useThemeStore,
} from "../themeStore";

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
      mode: "dark",
      activeTheme: { colors: { dark: { accent: "#98aecb" } } },
    });
    expect(JSON.parse(localStorage.getItem(legacyKey)!)).toMatchObject({ locale: "zh" });
  });

  it("prefers a valid new payload over legacy appearance preferences", () => {
    const imported = mergeTheme(DEFAULT_THEME, {
      id: "new-theme",
      name: "New Theme",
      colors: { dark: { accent: "#b1a2c9" } },
    });
    localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ version: 1, mode: "light", activeTheme: imported, source: "imported" }),
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
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toMatchObject({ mode: "dark" });

    const result = await importThemeFile(
      new File([JSON.stringify({ version: 1, id: "mist-blue", name: "Mist Blue", colors: { light: { accent: "#98aecb" } } })], "mist.json"),
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toMatchObject({
      source: "imported",
      activeTheme: { id: "mist-blue", colors: { light: { accent: "#98aecb" } } },
    });
    expect(exportActiveTheme().id).toBe("mist-blue");
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
      newValue: JSON.stringify({ version: 1, mode: "dark", activeTheme: nextTheme, source: "imported" }),
    }));
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(useThemeStore.getState().activeTheme.id).toBe("from-window");
  });

  it("keeps working when storage and window are unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => hydrateThemePreferences()).not.toThrow();
    expect(() => useThemeStore.getState().setAccentColor(DEFAULT_ACCENT)).not.toThrow();
    expect(() => startThemeRuntime()).not.toThrow();
  });
});
