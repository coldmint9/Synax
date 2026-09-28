import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_THEME } from "../../../lib/theme/defaults";
import {
  startThemeRuntime,
  THEME_STORAGE_KEY,
  useThemeStore,
} from "../../state/themeStore";
import { useShellStore } from "../../state/shellStore";
import { ThemeToggle } from "../ThemeToggle";

let stopThemeRuntime: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
  useShellStore.setState((state) => ({
    preferences: { ...state.preferences, locale: "zh" },
  }));
  useThemeStore.setState((state) => ({
    ...state,
    mode: "light",
    activeTheme: DEFAULT_THEME,
    source: "builtin",
    resolvedTheme: "light",
    resolvedTokens: {
      colors: { ...DEFAULT_THEME.colors.light },
      shape: { ...DEFAULT_THEME.shape },
      effects: { ...DEFAULT_THEME.effects.light },
    },
  }));
  stopThemeRuntime = startThemeRuntime();
});

afterEach(() => {
  stopThemeRuntime?.();
  stopThemeRuntime = undefined;
  document.documentElement.classList.remove("dark");
  document.documentElement.style.cssText = "";
});

it("toggles the visible theme immediately without opening a menu and saves the choice", () => {
  render(<ThemeToggle />);
  const button = screen.getByRole("button", { name: "切换到深色模式" });
  const before = useShellStore.getState().preferences;
  fireEvent.click(button);

  expect(document.documentElement).toHaveClass("dark");
  expect(useThemeStore.getState().mode).toBe("dark");
  expect(useThemeStore.getState().resolvedTheme).toBe("dark");
  expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY)!)).toMatchObject({
    schemaVersion: 1,
    mode: "dark",
    source: "builtin",
  });
  expect(localStorage.getItem("rumbling-shell-preferences")).toBeNull();
  const {
    theme: _beforeTheme,
    accentColor: _beforeAccent,
    ...shellBefore
  } = before;
  const {
    theme: _afterTheme,
    accentColor: _afterAccent,
    ...shellAfter
  } = useShellStore.getState().preferences;
  expect(shellAfter).toEqual(shellBefore);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(button).not.toHaveAttribute("aria-haspopup");
  expect(screen.getByRole("button", { name: "切换到浅色模式" })).toBe(button);

  fireEvent.click(button);
  expect(document.documentElement).not.toHaveClass("dark");
  expect(useThemeStore.getState().mode).toBe("light");
});

it.each(["light", "dark"] as const)(
  "switches away from the resolved system %s theme in one click",
  (resolvedTheme) => {
    stopThemeRuntime?.();
    stopThemeRuntime = undefined;
    useThemeStore.setState((state) => ({
      ...state,
      mode: "system",
      resolvedTheme,
      resolvedTokens: {
        colors: { ...DEFAULT_THEME.colors[resolvedTheme] },
        shape: { ...DEFAULT_THEME.shape },
        effects: { ...DEFAULT_THEME.effects[resolvedTheme] },
      },
    }));
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(useThemeStore.getState().mode).toBe(
      resolvedTheme === "dark" ? "light" : "dark",
    );
  },
);

it("reflects external theme changes while keeping the same keyboard-focusable button", () => {
  render(<ThemeToggle />);
  const button = screen.getByRole("button");
  act(() => useThemeStore.getState().setMode("dark"));
  expect(screen.getByRole("button", { name: "切换到浅色模式" })).toBe(button);
  fireEvent.click(button);
  expect(useThemeStore.getState().resolvedTheme).toBe("light");
});
