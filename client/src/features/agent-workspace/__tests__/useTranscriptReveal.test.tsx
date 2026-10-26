import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTranscriptReveal } from "../useTranscriptReveal";

afterEach(() => vi.unstubAllGlobals());

it("does not hide a readable transcript behind continuously growing live output", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  const root = { current: document.createElement("div") };
  root.current.innerHTML = '<p>Saved answer</p><span data-transcript-pending="true"></span>';
  const view = renderHook(() => useTranscriptReveal(root, 'running', true, true));
  for (const now of [0, 50, 100, 150]) act(() => {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(callback => callback(now));
  });
  expect(view.result.current).toBe(true);
  expect(frames.size).toBe(0);
});

it("waits for resources and stable layout, isolates switches and stays visible during refresh", () => {
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const tick = () => act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(0));
  });
  const root = { current: document.createElement("div") };
  root.current.innerHTML = '<span data-transcript-pending="true"></span>';
  const view = renderHook(({ id, ready }) => useTranscriptReveal(root, id, ready, true), {
    initialProps: { id: "a", ready: false },
  });
  for (let i = 0; i < 5; i++) tick();
  expect(view.result.current).toBe(false);
  view.rerender({ id: "a", ready: true });
  for (let i = 0; i < 5; i++) tick();
  expect(view.result.current).toBe(false);
  root.current.innerHTML = "<p>Loaded</p>";
  for (let i = 0; i < 4; i++) tick();
  expect(view.result.current).toBe(true);
  view.rerender({ id: "a", ready: false });
  expect(view.result.current).toBe(true);
  view.rerender({ id: "b", ready: true });
  tick();
  expect(view.result.current).toBe(false);
  view.rerender({ id: "c", ready: false });
  for (let i = 0; i < 5; i++) tick();
  expect(view.result.current).toBe(false);
  view.unmount();
  expect(frames.size).toBe(0);
});
