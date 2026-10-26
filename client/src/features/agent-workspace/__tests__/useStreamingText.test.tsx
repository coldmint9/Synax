import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { STREAM_REVEAL_MS, useStreamingText } from "../useStreamingText";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

it("reveals a burst over successive frames and stops when caught up", () => {
  const text = "这是持续输出的回复，包含中文和英文 streaming output。";
  const view = renderHook(({ text }) => useStreamingText(text, true), { initialProps: { text: "这" } });
  expect(view.result.current).toBe("这");
  view.rerender({ text });
  advance(32);
  const first = view.result.current;
  expect(first.length).toBeGreaterThan(0);
  expect(first.length).toBeLessThan(text.length);
  advance(32);
  expect(view.result.current.length).toBeGreaterThan(first.length);
  advance(STREAM_REVEAL_MS);
  expect(view.result.current).toBe(text);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps painting during faster-than-frame arrivals without delaying indefinitely", () => {
  const view = renderHook(({ text }) => useStreamingText(text, true), { initialProps: { text: "" } });
  let text = "";
  for (let index = 0; index < 50; index++) {
    text += "new delta ";
    view.rerender({ text });
    advance(8);
    if (index > 5) expect(view.result.current.length).toBeGreaterThan(0);
  }
  expect(view.result.current.length).toBeGreaterThan(text.length / 2);
  advance(STREAM_REVEAL_MS + 32);
  expect(view.result.current).toBe(text);
});

it("never splits emoji, combining marks, or joined graphemes", () => {
  const clusters = ["你", "👨‍👩‍👧‍👦", "e\u0301", "🇨🇳", "👍🏽", "好"];
  const text = clusters.join("");
  const boundaries = new Set(clusters.map((_, index) => clusters.slice(0, index + 1).join("")));
  const view = renderHook(() => useStreamingText(text, true));
  for (let index = 0; index < 12; index++) {
    advance(16);
    if (view.result.current) expect(boundaries.has(view.result.current)).toBe(true);
  }
  expect(view.result.current).toBe(text);
});

it("flushes immediately on completion and clears a replaced retry", () => {
  const view = renderHook(({ text, streaming }) => useStreamingText(text, streaming), {
    initialProps: { text: "Original answer ".repeat(20), streaming: true },
  });
  advance(32);
  view.rerender({ text: "New attempt", streaming: true });
  expect(view.result.current).not.toContain("Original");
  view.rerender({ text: "New attempt: finished", streaming: false });
  expect(view.result.current).toBe("New attempt: finished");
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds a huge burst and releases its pending frame on unmount", () => {
  const text = "long answer ".repeat(2000);
  const view = renderHook(() => useStreamingText(text, true));
  expect(text.length - view.result.current.length).toBeLessThanOrEqual(512);
  advance(STREAM_REVEAL_MS + 32);
  expect(view.result.current).toBe(text);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not animate historical content, reduced motion, or a hidden window", () => {
  const history = renderHook(() => useStreamingText("History", false));
  expect(history.result.current).toBe("History");
  expect(vi.getTimerCount()).toBe(0);
  const matchMedia = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ ...matchMedia(query), matches: true }));
  const reduced = renderHook(() => useStreamingText("Reduced motion", true));
  expect(reduced.result.current).toBe("Reduced motion");
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  const live = renderHook(() => useStreamingText("Flush when window becomes hidden", true));
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(live.result.current).toBe("Flush when window becomes hidden");
  expect(vi.getTimerCount()).toBe(0);
});

it("shows the first non-empty packet synchronously and smooths later packets", () => {
  const view = renderHook(({ text }) => useStreamingText(text, true), { initialProps: { text: "" } });
  view.rerender({ text: "首个 token 👨‍👩‍👧‍👦" });
  expect(view.result.current).toBe("首个 token 👨‍👩‍👧‍👦");
  expect(vi.getTimerCount()).toBe(0);
  view.rerender({ text: "首个 token 👨‍👩‍👧‍👦 后续继续平滑展示" });
  expect(view.result.current).toBe("首个 token 👨‍👩‍👧‍👦");
  advance(STREAM_REVEAL_MS + 32);
  expect(view.result.current).toBe("首个 token 👨‍👩‍👧‍👦 后续继续平滑展示");
});
