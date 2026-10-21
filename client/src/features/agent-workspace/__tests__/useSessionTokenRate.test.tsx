import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  TOKEN_RATE_SAMPLE_MS,
  useSessionTokenRate,
} from "../useSessionTokenRate";
import {
  noteLiveEvent,
  readStreamedTokens,
  readStreamedTokenRate,
  TOKEN_RATE_IDLE_MS,
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

  it("counts a restarted request even when it reuses the step with smaller totals", () => {
    noteLiveEvent("s1", { type: "message_delta", stepId: "step-1", outputTokens: 80 });
    noteLiveEvent("s1", { type: "thought_delta", stepId: "step-1", thinkingTokens: 20 });
    noteLiveEvent("s1", { type: "retry_status", stepId: "step-1", retry: { phase: "waiting" } });
    noteLiveEvent("s1", { type: "retry_status", stepId: "step-1", retry: { phase: "group_wait" } });
    noteLiveEvent("s1", { type: "message_delta", stepId: "step-1", outputTokens: 3 });
    noteLiveEvent("s1", { type: "thought_delta", stepId: "step-1", thinkingTokens: 4 });
    noteLiveEvent("s1", { type: "retry_status", stepId: "step-1", retry: { phase: "recovered" } });
    noteLiveEvent("s1", { type: "message_delta", stepId: "step-1", outputTokens: 5 });
    expect(readStreamedTokens("s1")).toBe(109);
  });

  it("replaces the baseline when a request restarted while disconnected", () => {
    noteLiveEvent("s1", { type: "message_delta", stepId: "step-1", outputTokens: 80 });
    noteLiveEvent("s1", { type: "runtime_snapshot", liveChunks: [
      { type: "message_delta", stepId: "step-1", outputTokens: 3 },
      { type: "thought_delta", stepId: "step-1", thinkingTokens: 4 },
    ] });
    expect(readStreamedTokens("s1")).toBe(80);
    noteLiveEvent("s1", { type: "message_delta", stepId: "step-1", outputTokens: 5 });
    noteLiveEvent("s1", { type: "thought_delta", stepId: "step-1", thinkingTokens: 6 });
    expect(readStreamedTokens("s1")).toBe(84);
  });
});

describe("useSessionTokenRate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    resetStreamedTokensForTests();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function emit(tokens: number, sessionId = "s1") {
    noteLiveEvent(sessionId, { type: "message_delta", stepId: "one", outputTokens: tokens });
  }
  function generate(tokensPerTick: number, ticks = 4, start = 1) {
    act(() => {
      emit(start);
      for (let index = 1; index <= ticks; index++) {
        vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
        emit(start + tokensPerTick * index);
      }
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
    });
  }

  it("shows generation speed within a second and excludes a long first-token wait", () => {
    const view = renderHook(() => useSessionTokenRate("s1", true));
    act(() => vi.advanceTimersByTime(20_000));
    expect(view.result.current).toBeNull();
    generate(10, 3);
    expect(view.result.current).toBe(40);
  });

  it("uses a rolling window instead of mixing a previous faster phase into the result", () => {
    const view = renderHook(() => useSessionTokenRate("s1", true));
    generate(25, 8);
    expect(view.result.current).toBe(100);
    act(() => {
      for (let index = 1; index <= 12; index++) {
        vi.advanceTimersByTime(250);
        emit(201 + 5 * index);
      }
      vi.advanceTimersByTime(250);
    });
    expect(view.result.current).toBe(20);
  });

  it("requires elapsed samples and never invents a rate from a single burst", () => {
    const view = renderHook(() => useSessionTokenRate("s1", true));
    act(() => { emit(4000); vi.advanceTimersByTime(500); });
    expect(view.result.current).toBeNull();
    expect(readStreamedTokenRate("s1")).toBeNull();
  });

  it("clears on inactivity, and a resumed interval excludes the tool pause", () => {
    const view = renderHook(() => useSessionTokenRate("s1", true));
    generate(10);
    expect(view.result.current).toBe(40);
    act(() => vi.advanceTimersByTime(TOKEN_RATE_IDLE_MS));
    expect(view.result.current).toBeNull();
    generate(5, 4, 100);
    expect(view.result.current).toBe(20);
  });

  it("seeds reconnect baselines without counting historical tokens as new generation", () => {
    const view = renderHook(() => useSessionTokenRate("s1", true));
    generate(10);
    act(() => {
      noteLiveEvent("s1", { type: "runtime_snapshot", liveChunks: [{ type: "message_delta", stepId: "one", outputTokens: 4000 }] });
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
    });
    expect(view.result.current).toBeNull();
    generate(5, 4, 4001);
    expect(view.result.current).toBe(20);
  });

  it("clears on retry and permission wait without using display updates as tokens", () => {
    const view = renderHook(() => useSessionTokenRate("s1", true));
    generate(10);
    act(() => {
      noteLiveEvent("s1", { type: "runtime_state", patch: { status: "waiting_permission" } });
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
    });
    expect(view.result.current).toBeNull();
    act(() => noteLiveEvent("s1", { type: "retry_status", stepId: "one", retry: { phase: "waiting" } }));
    generate(5);
    expect(view.result.current).toBe(20);
    expect(readStreamedTokens("s1")).toBe(62);
  });

  it("ignores another session and resets on selection change", () => {
    const view = renderHook(({ id }) => useSessionTokenRate(id, true), { initialProps: { id: "s2" } });
    generate(10);
    expect(view.result.current).toBeNull();
    view.rerender({ id: "s1" });
    expect(view.result.current).toBe(40);
    view.rerender({ id: "s3" });
    expect(view.result.current).toBeNull();
  });

  it("runs no timer while idle and stops its timer when generation finishes", () => {
    const view = renderHook(({ working }) => useSessionTokenRate("s1", working), { initialProps: { working: false } });
    expect(vi.getTimerCount()).toBe(0);
    view.rerender({ working: true });
    generate(10);
    expect(view.result.current).toBe(40);
    view.rerender({ working: false });
    expect(view.result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
