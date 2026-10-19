import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  hydrateShellPreferences,
  useShellStore,
} from "../../../../shared/state/shellStore";

vi.mock("../SettingsSelect", () => ({
  SettingsSelect: () => <div data-testid="settings-select" />,
}));

const { LayoutSection } = await import("../LayoutSection");

describe("LayoutSection", () => {
  beforeEach(() => {
    localStorage.clear();
    useShellStore.setState((state) => ({
      preferences: {
        ...state.preferences,
        locale: "en",
        sessionShowThinking: true,
        sessionFoldWorkRuns: true,
        userMessageFontWeight: 450,
      },
    }));
  });

  afterEach(() => {
    cleanup();
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, sessionShowThinking: true },
    }));
    localStorage.clear();
  });

  it("moves the work-log fold preference into settings", () => {
    render(<LayoutSection />);

    const toggle = screen.getByRole("switch", { name: "Fold work log" });
    expect(useShellStore.getState().preferences.sessionFoldWorkRuns).toBe(true);

    fireEvent.click(toggle);
    expect(useShellStore.getState().preferences.sessionFoldWorkRuns).toBe(
      false,
    );
  });

  it("persists the thinking setting and restores it on reload", () => {
    render(<LayoutSection />);

    const toggle = screen.getByRole("switch", { name: "Show thinking content" });
    expect(useShellStore.getState().preferences.sessionShowThinking).toBe(true);

    fireEvent.click(toggle);
    expect(useShellStore.getState().preferences.sessionShowThinking).toBe(false);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    act(() => {
      useShellStore.setState((state) => ({ preferences: { ...state.preferences, sessionShowThinking: true } }));
      hydrateShellPreferences();
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("enables thinking by default for existing preferences without the new setting", () => {
    localStorage.setItem("rumbling-shell-preferences", JSON.stringify({ locale: "en" }));
    hydrateShellPreferences();
    render(<LayoutSection />);
    expect(screen.getByRole("switch", { name: "Show thinking content" })).toHaveAttribute("aria-checked", "true");
  });

  it("updates the user message font weight with the range control", () => {
    render(<LayoutSection />);

    const slider = screen.getByRole("slider", { name: "用户消息字重" });
    expect(slider).toHaveValue("450");
    fireEvent.change(slider, { target: { value: "537" } });
    expect(useShellStore.getState().preferences.userMessageFontWeight).toBe(537);
    expect(screen.getByText("537")).toBeInTheDocument();
  });
});
