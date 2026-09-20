import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ThemeToggle } from "../ThemeToggle";
import { useShellStore as store } from "../../state/shellStore";

beforeEach(() => {
  store.setState((s) => ({
    preferences: { ...s.preferences, locale: "zh", theme: "light" },
    resolvedTheme: "light",
  }));
});
afterEach(() => {
  store.setState(store.getInitialState());
  document.documentElement.classList.remove("dark");
});

it("toggles the visible theme immediately without opening a menu and saves the choice", () => {
  render(<ThemeToggle />);
  const button = screen.getByRole("button", { name: "切换到深色模式" });
  fireEvent.click(button);
  expect(document.documentElement).toHaveClass("dark");
  expect(store.getState().preferences.theme).toBe("dark");
  expect(
    JSON.parse(localStorage.getItem("rumbling-shell-preferences")!).theme,
  ).toBe("dark");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(button).not.toHaveAttribute("aria-haspopup");
  expect(screen.getByRole("button", { name: "切换到浅色模式" })).toBe(button);
  fireEvent.click(button);
  expect(document.documentElement).not.toHaveClass("dark");
  expect(store.getState().preferences.theme).toBe("light");
});

it.each(["light", "dark"] as const)(
  "switches away from the resolved system %s theme in one click",
  (resolvedTheme) => {
    store.setState((s) => ({
      preferences: { ...s.preferences, theme: "system" },
      resolvedTheme,
    }));
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(store.getState().preferences.theme).toBe(
      resolvedTheme === "dark" ? "light" : "dark",
    );
  },
);

it("reflects external theme changes while keeping the same keyboard-focusable button", () => {
  render(<ThemeToggle />);
  const button = screen.getByRole("button");
  act(() => store.getState().setTheme("dark"));
  expect(screen.getByRole("button", { name: "切换到浅色模式" })).toBe(button);
  fireEvent.click(button);
  expect(store.getState().resolvedTheme).toBe("light");
});
