import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useShellStore } from "../../../shared/state/shellStore";
import { ThinkingIndicator } from "../ThinkingIndicator";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(0));
  useShellStore.setState((state) => ({
    preferences: { ...state.preferences, locale: "zh" },
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ThinkingIndicator", () => {
  it("starts with a glowing ASCII frame and no visible placeholder label", () => {
    const { container } = render(<ThinkingIndicator />);
    const status = screen.getByRole("status");

    expect(status).toHaveAttribute("data-phase", "initial");
    expect(status.querySelector(".ascii-thinking-art")).toHaveTextContent(/<~\*~>/);
    expect(status.querySelector(".ascii-thinking-message")).toBeNull();
    expect(container.querySelectorAll(".loading-state-cell")).toHaveLength(0);
    expect(status).toHaveTextContent("正在思考");
  });

  it("adds a reassurance message after three seconds", async () => {
    render(<ThinkingIndicator />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("data-phase", "reassure");
    expect(status.querySelector(".ascii-thinking-message")).toHaveTextContent(
      "还在和字节们开会，请再等等 ~",
    );
  });

  it("switches to a network or provider hint after twenty seconds", async () => {
    render(<ThinkingIndicator />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("data-phase", "network");
    expect(status.querySelector(".ascii-thinking-message")).toHaveTextContent(
      "响应有点久，可以检查一下网络或供应商状态。",
    );
  });

  it("keeps the accessible status localized in English", () => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "en" },
    }));
    render(<ThinkingIndicator />);

    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
  });
});
