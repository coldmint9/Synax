import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCENT } from "../lib/appearance";
import { DEFAULT_THEME } from "../lib/theme/defaults";
import {
  hydrateShellPreferences,
  startShellAppearance,
  useShellStore,
} from "./shellStore";
import { THEME_STORAGE_KEY, useThemeStore } from "./themeStore";

const legacyKey = "rumbling-shell-preferences";
let stop: (() => void) | undefined;
let dark = false;
let change: (() => void) | undefined;
let remove: ReturnType<typeof vi.fn>;
const initial = useShellStore.getState().preferences;

beforeEach(() => {
  localStorage.clear();
  dark = false;
  change = undefined;
  remove = vi.fn();
  useThemeStore.getState().setActiveTheme(DEFAULT_THEME, "builtin");
  useThemeStore.getState().setMode("system");
  localStorage.clear();
  vi.spyOn(window, "matchMedia").mockImplementation(
    () =>
      ({
        get matches() {
          return dark;
        },
        addEventListener: (_: string, listener: () => void) => {
          change = listener;
        },
        removeEventListener: remove,
      }) as unknown as MediaQueryList,
  );
  useShellStore.setState({
    preferences: { ...initial, theme: "system", accentColor: DEFAULT_ACCENT },
    resolvedTheme: "light",
  });
  stop = startShellAppearance();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shell appearance", () => {
  it("follows live system changes without changing legacy storage", () => {
    const legacy = JSON.stringify({
      theme: "light",
      locale: "en",
      accentColor: "#123456",
    });
    localStorage.setItem(legacyKey, legacy);

    useShellStore.getState().setTheme("system");
    expect(localStorage.getItem(legacyKey)).toBe(legacy);
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toMatchObject({
      schemaVersion: 1,
      mode: "system",
      theme: expect.any(Object),
      source: "builtin",
    });

    dark = true;
    change?.();
    expect(document.documentElement).toHaveClass("dark");
    expect(useShellStore.getState().resolvedTheme).toBe("dark");
    expect(localStorage.getItem(legacyKey)).toBe(legacy);
    dark = false;
    change?.();
    expect(document.documentElement).not.toHaveClass("dark");
    expect(useShellStore.getState().resolvedTheme).toBe("light");
  });

  it("holds manual choices, then resumes following the system", () => {
    useShellStore.getState().setTheme("light");
    dark = true;
    change?.();
    expect(useShellStore.getState().resolvedTheme).toBe("light");
    useShellStore.getState().setTheme("system");
    expect(useShellStore.getState().resolvedTheme).toBe("dark");
    useShellStore.getState().setTheme("dark");
    dark = false;
    change?.();
    expect(useShellStore.getState().resolvedTheme).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");
  });

  it(
    "migrates theme preferences to canonical storage without losing legacy preferences",
    () => {
      const legacy = JSON.stringify({
        theme: "dark",
        locale: "en",
        accentColor: "#ABC",
        sessionListDisplayMode: "title",
      });
      localStorage.setItem(legacyKey, legacy);

      hydrateShellPreferences();

      expect(useShellStore.getState().preferences).toMatchObject({
        theme: "dark",
        accentColor: "#aabbcc",
        locale: "en",
        sessionListDisplayMode: "title",
      });
      expect(localStorage.getItem(legacyKey)).toBe(legacy);
      expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toMatchObject({
        schemaVersion: 1,
        mode: "dark",
        theme: { colors: { light: { accent: "#aabbcc" } } },
        source: "builtin",
      });

      useShellStore.getState().setTheme("light");
      useShellStore.getState().setAccentColor("#98aecb");
      expect(localStorage.getItem(legacyKey)).toBe(legacy);
      expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toMatchObject({
        schemaVersion: 1,
        mode: "light",
        theme: { colors: { light: { accent: "#98aecb" } } },
        source: "builtin",
      });
      expect(
        document.documentElement.style.getPropertyValue("--cx-accent-bottom"),
      ).toBe("#98aecb");
    },
  );

  it("restores and persists the session list display mode", () => {
    localStorage.setItem(
      legacyKey,
      JSON.stringify({ sessionListDisplayMode: "title" }),
    );
    hydrateShellPreferences();
    expect(useShellStore.getState().preferences.sessionListDisplayMode).toBe(
      "title",
    );

    useShellStore.getState().setSessionListDisplayMode("preview");
    expect(
      JSON.parse(localStorage.getItem(legacyKey)!).sessionListDisplayMode,
    ).toBe("preview");
  });

  it("survives malformed and unavailable storage", () => {
    for (const payload of [
      "{",
      "null",
      '{"theme":"nope","accentColor":"url(x)"}',
    ]) {
      localStorage.setItem(legacyKey, payload);
      expect(() => hydrateShellPreferences()).not.toThrow();
      expect(useShellStore.getState().preferences.accentColor).toBe(
        DEFAULT_ACCENT,
      );
    }
    vi.stubGlobal("localStorage", {
      setItem() {
        throw new Error("Unavailable");
      },
    });
    expect(() => useShellStore.getState().setTheme("dark")).not.toThrow();
    expect(() =>
      useShellStore.getState().setAccentColor("#123456"),
    ).not.toThrow();
    expect(
      document.documentElement.style.getPropertyValue("--cx-accent-bottom"),
    ).toBe("#123456");
  });

  it("syncs stored settings across windows and removes the system listener", () => {
    const legacy = JSON.stringify({ theme: "dark", accentColor: "#cca58d" });
    localStorage.setItem(legacyKey, legacy);
    window.dispatchEvent(
      new StorageEvent("storage", { key: legacyKey, newValue: legacy }),
    );
    expect(useShellStore.getState().resolvedTheme).toBe("dark");
    expect(useShellStore.getState().preferences.accentColor).toBe("#cca58d");
    expect(localStorage.getItem(legacyKey)).toBe(legacy);
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toMatchObject({
      schemaVersion: 1,
      mode: "dark",
      theme: { colors: { light: { accent: "#cca58d" } } },
      source: "builtin",
    });
    stop?.();
    stop = undefined;
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
