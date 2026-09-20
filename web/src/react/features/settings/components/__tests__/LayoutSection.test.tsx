import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  hydrateShellPreferences,
  useShellStore,
} from "../../../../state/shellStore";

vi.mock("../SettingsSelect", () => ({
  SettingsSelect: () => <div data-testid="settings-select" />,
}));

const { LayoutSection } = await import("../LayoutSection");

describe("LayoutSection", () => {
  beforeEach(() => {
    useShellStore.setState((state) => ({
      preferences: {
        ...state.preferences,
        locale: "en",
        wikiEnabled: false,
        sessionFoldWorkRuns: true,
      },
    }));
  });

  afterEach(() => cleanup());

  it("persists the experimental Wiki opt-in and restores it after reload", () => {
    render(<LayoutSection />);
    expect(screen.getByText("Wiki (Experimental)")).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Wiki" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(useShellStore.getState().preferences.wikiEnabled).toBe(true);
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, wikiEnabled: false },
    }));
    hydrateShellPreferences();
    expect(useShellStore.getState().preferences.wikiEnabled).toBe(true);
    fireEvent.click(toggle);
    expect(useShellStore.getState().preferences.wikiEnabled).toBe(false);
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
});
