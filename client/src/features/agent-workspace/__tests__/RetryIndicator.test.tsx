import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RetryIndicator } from "../RetryIndicator";
import { useShellStore } from "../../../shared/state/shellStore";
import type { LlmRetryState } from "../../../adapters/transport/sessionLive";

const retry: LlmRetryState = {
  reason: "rate_limit", phase: "waiting", group: 1, attempt: 1, maxRetries: 10,
  nextRetryAt: null, error: "HTTP 429: Too many requests",
};

beforeEach(() => {
  vi.useFakeTimers();
  useShellStore.setState(state => ({ preferences: { ...state.preferences, locale: "zh" } }));
});
afterEach(() => vi.useRealTimers());

it("counts down without announcing each timer tick and hides immediately on recovery", () => {
  const waiting = { ...retry, nextRetryAt: Date.now() + 300_000 };
  const { rerender } = render(<RetryIndicator retry={waiting} />);
  expect(screen.getByTestId("retry-indicator")).toBeVisible();
  expect(screen.getByText("第 1/10 次重试 · 300 秒后重试")).toBeVisible();
  const announcement = screen.getByRole("status").textContent;
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText("第 1/10 次重试 · 299 秒后重试")).toBeVisible();
  expect(screen.getByRole("status").textContent).toBe(announcement);

  rerender(<RetryIndicator retry={{ ...retry, phase: "retrying" }} />);
  expect(screen.getByText("第 1/10 次重试 · 正在重试…")).toBeVisible();
  expect(vi.getTimerCount()).toBe(0);
  rerender(<RetryIndicator retry={{ ...retry, phase: "recovered" }} />);
  expect(screen.queryByTestId("retry-indicator")).not.toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(0);
});

it("describes a network retry without an empty retry budget or a fictional countdown", () => {
  render(<RetryIndicator retry={{ ...retry, reason: "network", maxRetries: 0 }} />);
  expect(screen.getByRole("status")).toHaveTextContent("网络连接异常");
  expect(screen.getByText("第 1 次重试 · 正在重试…")).toBeVisible();
  expect(screen.queryByText(/0 秒后|1\/0|第 1 组/)).not.toBeInTheDocument();
});

it("keeps an elapsed countdown nonnegative and clears the timer on unmount", () => {
  const { unmount } = render(<RetryIndicator retry={{ ...retry, nextRetryAt: Date.now() + 1000 }} />);
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByText("第 1/10 次重试 · 即将重试…")).toBeVisible();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("supports English status and exhausted retries", () => {
  useShellStore.setState(state => ({ preferences: { ...state.preferences, locale: "en" } }));
  render(<RetryIndicator retry={{ ...retry, reason: "upstream", phase: "exhausted", attempt: 10, nextRetryAt: Date.now() + 1000 }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Upstream service unavailable");
  expect(screen.getByText("Failed after 10 retries")).toBeVisible();
  expect(screen.getByTestId("retry-indicator")).toHaveAttribute("data-active", "false");
  expect(vi.getTimerCount()).toBe(0);
});
