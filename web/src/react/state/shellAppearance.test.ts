import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCENT } from "../../lib/appearance";
import {
  hydrateShellPreferences,
  startShellAppearance,
  useShellStore,
} from "./shellStore";

const key = "rumbling-shell-preferences";
let stop: (() => void) | undefined;
let dark = false;
let change: (() => void) | undefined;
let remove: ReturnType<typeof vi.fn>;
const initial = useShellStore.getState().preferences;

beforeEach(() => {
  dark = false;
  remove = vi.fn();
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shell appearance", () => {
  it("follows live system changes without replacing the saved preference", () => {
    useShellStore.getState().setTheme("system");
    dark = true;
    change?.();
    expect(document.documentElement).toHaveClass("dark");
    expect(useShellStore.getState().resolvedTheme).toBe("dark");
    expect(JSON.parse(localStorage.getItem(key)!).theme).toBe("system");
    dark = false;
    change?.();
    expect(document.documentElement).not.toHaveClass("dark");
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
  });

  it("restores legacy explicit modes and custom color without losing other preferences", () => {
    localStorage.setItem(
      key,
      JSON.stringify({ theme: "dark", locale: "en", accentColor: "#ABC" }),
    );
    hydrateShellPreferences();
    expect(useShellStore.getState().preferences).toMatchObject({
      theme: "dark",
      accentColor: "#aabbcc",
      locale: "en",
    });
    expect(
      document.documentElement.style.getPropertyValue("--cx-accent-bottom"),
    ).toBe("#aabbcc");
    useShellStore.getState().setAccentColor("#98aecb");
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
      theme: "dark",
      accentColor: "#98aecb",
      locale: "en",
    });
  });

  it("restores and persists the session list display mode", () => {
    localStorage.setItem(
      key,
      JSON.stringify({ sessionListDisplayMode: "title" }),
    );
    hydrateShellPreferences();
    expect(useShellStore.getState().preferences.sessionListDisplayMode).toBe(
      "title",
    );

    useShellStore.getState().setSessionListDisplayMode("preview");
    expect(
      JSON.parse(localStorage.getItem(key)!).sessionListDisplayMode,
    ).toBe("preview");
  });

  it("survives malformed and unavailable storage", () => {
    for (const payload of [
      "{",
      "null",
      '{"theme":"nope","accentColor":"url(x)"}',
    ]) {
      localStorage.setItem(key, payload);
      expect(() => hydrateShellPreferences()).not.toThrow();
      expect(useShellStore.getState().preferences.accentColor).toBe(
        DEFAULT_ACCENT,
      );
    }
    vi.stubGlobal("localStorage", { setItem() { throw new Error("Unavailable"); } });
    expect(() => useShellStore.getState().setTheme("dark")).not.toThrow();
    expect(() =>
      useShellStore.getState().setAccentColor("#123456"),
    ).not.toThrow();
    expect(
      document.documentElement.style.getPropertyValue("--cx-accent-bottom"),
    ).toBe("#123456");
  });

  it("syncs stored settings across windows and removes the system listener", () => {
    localStorage.setItem(
      key,
      JSON.stringify({ theme: "dark", accentColor: "#cca58d" }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key, newValue: localStorage.getItem(key) }),
    );
    expect(useShellStore.getState().resolvedTheme).toBe("dark");
    expect(useShellStore.getState().preferences.accentColor).toBe("#cca58d");
    stop?.();
    stop = undefined;
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
