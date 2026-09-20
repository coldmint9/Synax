import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AppearanceSection } from "../AppearanceSection";
import { useShellStore } from "../../../../state/shellStore";
import { DEFAULT_ACCENT } from "../../../../../lib/appearance";

beforeEach(() => {
  useShellStore.setState((state) => ({
    preferences: {
      ...state.preferences,
      theme: "system",
      accentColor: DEFAULT_ACCENT,
      locale: "en",
    },
    resolvedTheme: "light",
  }));
});

describe("AppearanceSection", () => {
  it("uses accessible exclusive mode choices and keeps system status current", () => {
    render(<AppearanceSection />);
    expect(
      screen.getByRole("radio", { name: "System", exact: true }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Dark", exact: true }));
    expect(useShellStore.getState().preferences.theme).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "System", exact: true }));
    act(() => useShellStore.setState({ resolvedTheme: "dark" }));
    expect(screen.getByText("System is currently dark")).toBeInTheDocument();
  });

  it("selects a preset and restores the Synax accent without changing mode", () => {
    render(<AppearanceSection />);
    const swatch = screen.getByRole("option", { name: "Iris", exact: true });
    fireEvent.click(swatch);
    expect(useShellStore.getState().preferences.accentColor).toBe("#b1a2c9");
    expect(screen.getByText("#B1A2C9")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset accent color" }));
    expect(useShellStore.getState().preferences).toMatchObject({
      accentColor: DEFAULT_ACCENT,
      theme: "system",
    });
  });
});
