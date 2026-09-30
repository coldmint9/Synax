import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  TOKEN_RATE_SAMPLE_MS,
  useSessionTokenRate,
} from "../useSessionTokenRate";
import {
  estimateStreamTokens,
  noteStreamedOutput,
  readStreamedTokens,
  resetStreamedTokensForTests,
} from "../../../../lib/streamThroughput";

describe("streamThroughput", () => {
  beforeEach(resetStreamedTokensForTests);

  it("estimates latin at four characters per token and CJK at one", () => {
    expect(estimateStreamTokens("")).toBe(0);
    expect(estimateStreamTokens("abcd")).toBe(1);
    expect(estimateStreamTokens("你好")).toBe(2);
  });

  it("keeps accumulating across step boundaries", () => {
    noteStreamedOutput("s1", "abcd");
    noteStreamedOutput("s1", "efgh");
    expect(readStreamedTokens("s1")).toBe(2);
  });

  it("counts each session separately", () => {
    noteStreamedOutput("s1", "abcd");
    noteStreamedOutput("s2", "abcd".repeat(4));
    expect(readStreamedTokens("s1")).toBe(1);
    expect(readStreamedTokens("s2")).toBe(4);
    expect(readStreamedTokens("s3")).toBe(0);
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
      noteStreamedOutput("s1", "a".repeat(400)); // 100 tokens over 5s
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
    });
    expect(view.result.current).toBe(20);

    act(() => {
      noteStreamedOutput("s1", "a".repeat(200)); // 50 tokens over the next 5s
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
    });
    expect(view.result.current).toBe(10);
  });

  it("ignores output that belongs to another session", () => {
    const view = renderHook(() => useSessionTokenRate("s1", true));
    act(() => {
      noteStreamedOutput("s2", "a".repeat(400));
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
    });
    expect(view.result.current).toBeNull();
  });

  it("keeps the last measured speed when a window produces no output", () => {
    const view = renderHook(() => useSessionTokenRate("s1", true));
    act(() => {
      noteStreamedOutput("s1", "a".repeat(400));
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
    });
    expect(view.result.current).toBe(20);

    act(() => vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS));
    expect(view.result.current).toBe(20);
  });

  it("runs no timer and reports nothing while the session is idle", () => {
    const view = renderHook(() => useSessionTokenRate("s1", false));
    expect(vi.getTimerCount()).toBe(0);
    expect(view.result.current).toBeNull();

    act(() => {
      noteStreamedOutput("s1", "a".repeat(400));
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
      noteStreamedOutput("s1", "a".repeat(400));
      vi.advanceTimersByTime(TOKEN_RATE_SAMPLE_MS);
    });
    expect(view.result.current).toBe(20);

    view.rerender({ working: false });
    expect(view.result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
