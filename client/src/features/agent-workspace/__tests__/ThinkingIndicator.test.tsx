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
  it("shows the operation immediately without a decorative character animation", () => {
    const { container } = render(<ThinkingIndicator />);
    const status = screen.getByRole("status");

    expect(screen.getByTestId("thinking-indicator")).toHaveAttribute("data-phase", "initial");
    expect(status).toHaveAccessibleName("正在思考");
    expect(screen.getByText("正在思考")).toBeVisible();
    expect(container.querySelector(".ascii-thinking-art")).toBeNull();
  });

  it("adds a reassurance message after three seconds", async () => {
    render(<ThinkingIndicator />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(screen.getByTestId("thinking-indicator")).toHaveAttribute("data-phase", "reassure");
    expect(screen.getByRole("status")).toHaveAccessibleName("仍在思考，请稍候");
    expect(screen.queryByText("正在思考")).not.toBeInTheDocument();
  });

  it("switches to a network or provider hint after twenty seconds", async () => {
    render(<ThinkingIndicator />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });

    const status = screen.getByRole("status");
    expect(screen.getByTestId("thinking-indicator")).toHaveAttribute("data-phase", "network");
    expect(status).toHaveAccessibleName(/响应有点久/);
    expect(screen.getByText("响应有点久，可以检查一下网络或供应商状态。")).toBeVisible();
  });

  it("keeps a custom operation label after a long wait without model-specific hints", () => {
    render(<ThinkingIndicator label="正在压缩上下文" />);
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("status")).toHaveAccessibleName("正在压缩上下文");
    expect(screen.getByText("正在压缩上下文")).toBeVisible();
    expect(screen.queryByText(/网络|字节|仍在思考/)).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets the waiting phase after changing operations and clears timers on unmount", () => {
    const { rerender, unmount } = render(<ThinkingIndicator />);
    act(() => vi.advanceTimersByTime(20_000));
    rerender(<ThinkingIndicator label="正在压缩上下文" />);
    expect(vi.getTimerCount()).toBe(0);
    rerender(<ThinkingIndicator />);
    expect(screen.getByRole("status")).toHaveAccessibleName("正在思考");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the accessible status localized in English", () => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "en" },
    }));
    render(<ThinkingIndicator />);

    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
  });
});
