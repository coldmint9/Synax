import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  TOKEN_RATE_SAMPLE_MS,
  useSessionTokenRate,
} from "../useSessionTokenRate";
import {
  noteLiveEvent,
  readStreamedTokens,
  resetStreamedTokensForTests,
} from "../../../shared/lib/streamThroughput";

describe("streamThroughput", () => {
  beforeEach(resetStreamedTokensForTests);

  it("keeps accumulating across step boundaries", () => {
    noteLiveEvent("s1", { type: "message_delta", stepId: "one", outputTokens: 1 });
    noteLiveEvent("s1", { type: "thought_delta", stepId: "two", thinkingTokens: 1 });
    expect(readStreamedTokens("s1")).toBe(2);
  });

  it("counts each session separately", () => {
    noteLiveEvent("s1", { type: "message_delta", stepId: "one", outputTokens: 1 });
    noteLiveEvent("s2", { type: "message_delta", stepId: "one", outputTokens: 4 });
    expect(readStreamedTokens("s1")).toBe(1);
    expect(readStreamedTokens("s2")).toBe(4);
    expect(readStreamedTokens("s3")).toBe(0);
  });

  it("deduplicates text and reasoning counts independently", () => {
    noteLiveEvent("s1", { type: "thought_delta", stepId: "step-1", thinkingTokens: 5 });
    noteLiveEvent("s1", { type: "thought_delta", stepId: "step-1", thinkingTokens: 5 });
    noteLiveEvent("s1", { type: "thought_delta", stepId: "step-1", thinkingTokens: 3 });
    noteLiveEvent("s1", { type: "message_delta", stepId: "step-1", outputTokens: 4 });
    noteLiveEvent("s1", { type: "message_delta", stepId: "step-1", outputTokens: 2 });
    noteLiveEvent("s1", { type: "message_delta", stepId: "step-1", outputTokens: 7 });
    noteLiveEvent("s1", { type: "message_delta", stepId: "step-2", outputTokens: 3 });
    expect(readStreamedTokens("s1")).toBe(15);
  });

  it("includes reasoning telemetry in the output rate", () => {
    noteLiveEvent("s1", { type: "message_delta", stepId: "step-1", outputTokens: 4 });
    noteLiveEvent("s1", { type: "thought_delta", stepId: "step-1", thinkingTokens: 6 });
    expect(readStreamedTokens("s1")).toBe(10);
  });

  it("hydrates the current step from a reconnect snapshot", () => {
    noteLiveEvent("s1", {
      type: "runtime_snapshot",
      liveChunks: [
        { type: "message_delta", stepId: "step-1", outputTokens: 8 },
        { type: "thought_delta", stepId: "step-1", thinkingTokens: 20 },
      ],
    });
    expect(readStreamedTokens("s1")).toBe(0);
    noteLiveEvent("s1", { type: "message_delta", stepId: "step-1", outputTokens: 10 });
    noteLiveEvent("s1", { type: "thought_delta", stepId: "step-1", thinkingTokens: 23 });
    expect(readStreamedTokens("s1")).toBe(5);
  });
});

describe("useSessionTokenRate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStreamedTokensForTests();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("samples one five-second window at a time while the session works", () => {
    const view = renderHook(() => useSessionTokenRate("s1", true));
    expect(view.result.current).toBeNull();

    act(() => {
      noteLiveEvent("s1", { type: "thought_delta", stepId: "one", thinkingTokens: 100 }); // 100 tokens over 5s
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
    });
    expect(view.result.current).toBe(20);

    act(() => {
      noteLiveEvent("s1", { type: "message_delta", stepId: "one", outputTokens: 50 }); // 50 tokens over the next 5s
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
    });
    expect(view.result.current).toBe(10);
  });

  it("ignores output that belongs to another session", () => {
    const view = renderHook(() => useSessionTokenRate("s1", true));
    act(() => {
      noteLiveEvent("s2", { type: "thought_delta", stepId: "one", thinkingTokens: 100 });
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
    });
    expect(view.result.current).toBeNull();
  });

  it("clears the measured speed when a window produces no output", () => {
    const view = renderHook(() => useSessionTokenRate("s1", true));
    act(() => {
      noteLiveEvent("s1", { type: "thought_delta", stepId: "one", thinkingTokens: 100 });
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
    });
    expect(view.result.current).toBe(20);

    act(() => vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS));
    expect(view.result.current).toBeNull();
  });

  it("runs no timer and reports nothing while the session is idle", () => {
    const view = renderHook(() => useSessionTokenRate("s1", false));
    expect(vi.getTimerCount()).toBe(0);
    expect(view.result.current).toBeNull();

    act(() => {
      noteLiveEvent("s1", { type: "thought_delta", stepId: "one", thinkingTokens: 100 });
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS * 3);
    });
    expect(view.result.current).toBeNull();
  });

  it("clears the reading and the timer when the session stops working", () => {
    const view = renderHook(
      ({ working }: { working: boolean }) =>
        useSessionTokenRate("s1", working),
      { initialProps: { working: true } },
    );
    act(() => {
      noteLiveEvent("s1", { type: "thought_delta", stepId: "one", thinkingTokens: 100 });
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
    });
    expect(view.result.current).toBe(20);

    view.rerender({ working: false });
    expect(view.result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
