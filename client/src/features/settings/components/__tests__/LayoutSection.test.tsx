import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    useShellStore.setState((state) => ({
      preferences: {
        ...state.preferences,
        locale: "en",
        
        sessionFoldWorkRuns: true,
        userMessageFontWeight: 450,
      },
    }));
  });

  afterEach(() => cleanup());

  it("moves the work-log fold preference into settings", () => {
    render(<LayoutSection />);

    const toggle = screen.getByRole("switch", { name: "Fold work log" });
    expect(useShellStore.getState().preferences.sessionFoldWorkRuns).toBe(true);

    fireEvent.click(toggle);
    expect(useShellStore.getState().preferences.sessionFoldWorkRuns).toBe(
      false,
    );
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
