import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTranscriptScroll } from "../useTranscriptScroll";

afterEach(() => vi.unstubAllGlobals());

it("keeps a first visit pinned when layout scroll events precede resize delivery", () => {
  let onResize!: ResizeObserverCallback;
  const observe = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        onResize = callback;
      }
      observe = observe;
      disconnect() {}
    },
  );
  const element = document.createElement("div");
  const content = element.appendChild(document.createElement("div"));
  let height = 1200;
  let viewportHeight = 500;
  let top = 0;
  Object.defineProperties(element, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => viewportHeight },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - viewportHeight));
      },
    },
  });
  const ref = { current: element };
  const { rerender } = renderHook(
    ({ id, ready }) => useTranscriptScroll(ref, id, undefined, ready),
    { initialProps: { id: "layout-first", ready: false } },
  );
  expect(top).toBe(0);
  rerender({ id: "layout-first", ready: true });
  expect(top).toBe(700);
  expect(observe).toHaveBeenCalledWith(content);
  expect(observe).toHaveBeenCalledWith(element);
  act(() => {
    height = 2400;
    element.dispatchEvent(new Event("scroll"));
    onResize([], {} as ResizeObserver);
  });
  expect(top).toBe(1900);
  act(() => {
    viewportHeight = 300;
    element.dispatchEvent(new Event("scroll"));
    onResize([], {} as ResizeObserver);
  });
  expect(top).toBe(2100);
  act(() => {
    height = 1800;
    element.scrollTop = top;
    element.dispatchEvent(new Event("scroll"));
    height = 2400;
    onResize([], {} as ResizeObserver);
  });
  expect(top).toBe(2100);
  rerender({ id: "layout-second", ready: true });
  expect(top).toBe(2100);
  act(() => {
    element.dispatchEvent(new Event("wheel"));
    element.scrollTop = 320;
    element.dispatchEvent(new Event("scroll"));
  });
  rerender({ id: "layout-first", ready: true });
  expect(top).toBe(2100);
  rerender({ id: "layout-second", ready: true });
  expect(top).toBe(320);
  act(() => {
    height = 3000;
    onResize([], {} as ResizeObserver);
  });
  expect(top).toBe(320);
});

it("restores reading position across session switches and does not restore into a skeleton", () => {
  const element = document.createElement("div");
  element.appendChild(document.createElement("div"));
  Object.defineProperties(element, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 500 },
  });
  const ref = { current: element };
  const onReading = vi.fn();
  const { rerender, unmount } = renderHook(
    ({ id, ready }) => useTranscriptScroll(ref, id, onReading, ready),
    { initialProps: { id: "scroll-a", ready: true } },
  );
  expect(element.scrollTop).toBe(2000);
  act(() => {
    element.dispatchEvent(new Event("wheel"));
    element.scrollTop = 320;
    element.dispatchEvent(new Event("scroll"));
  });
  rerender({ id: "scroll-b", ready: false });
  element.scrollTop = 0;
  rerender({ id: "scroll-b", ready: true });
  expect(element.scrollTop).toBe(2000);
  rerender({ id: "scroll-a", ready: true });
  expect(element.scrollTop).toBe(320);
  expect(onReading).toHaveBeenLastCalledWith(true);
  unmount();
});

it("does not jump to the bottom when the reader expands a plan or question", () => {
  let onResize!: ResizeObserverCallback;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        onResize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const element = document.createElement("div");
  const content = document.createElement("div");
  content.innerHTML =
    "<details><summary>Plan details</summary><div>Steps</div></details>";
  element.appendChild(content);
  Object.defineProperties(element, {
    scrollHeight: { value: 1200, configurable: true },
    clientHeight: { value: 500 },
  });
  const onReading = vi.fn();
  const { unmount } = renderHook(() =>
    useTranscriptScroll({ current: element }, "disclosure-scroll", onReading),
  );
  element.scrollTop = 700;
  act(() => {
    content.querySelector("summary")!.click();
    Object.defineProperty(element, "scrollHeight", { value: 2000 });
    onResize([], {} as ResizeObserver);
  });
  expect(element.scrollTop).toBe(700);
  expect(onReading).toHaveBeenLastCalledWith(true);
  unmount();
});

it("scrollToBottom(force) re-pins and lands on the bottom after the user scrolled up", () => {
  const element = document.createElement("div");
  element.appendChild(document.createElement("div"));
  let scrollHeight = 2000;
  Object.defineProperties(element, {
    scrollHeight: { get: () => scrollHeight, configurable: true },
    clientHeight: { value: 500 },
  });
  const ref = { current: element };
  const { result } = renderHook(() =>
    useTranscriptScroll(ref, "force-scroll"),
  );
  expect(element.scrollTop).toBe(2000);
  act(() => {
    element.dispatchEvent(new Event("wheel"));
    element.scrollTop = 320;
    element.dispatchEvent(new Event("scroll"));
  });
  act(() => {
    scrollHeight = 3000;
    result.current.scrollToBottom(true);
  });
  expect(element.scrollTop).toBe(3000);
});

it("scrollToBottom without force stays put while the user reads history", () => {
  const element = document.createElement("div");
  element.appendChild(document.createElement("div"));
  Object.defineProperties(element, {
    scrollHeight: { value: 2000, configurable: true },
    clientHeight: { value: 500 },
  });
  const ref = { current: element };
  const { result } = renderHook(() =>
    useTranscriptScroll(ref, "nofollow-scroll"),
  );
  act(() => {
    // Message navigation also scrolls programmatically without a wheel event.
    element.scrollTop = 320;
    element.dispatchEvent(new Event("scroll"));
  });
  act(() => {
    result.current.scrollToBottom(false);
  });
  expect(element.scrollTop).toBe(320);
  act(() => {
    result.current.scrollToBottom(true);
  });
  expect(element.scrollTop).toBe(2000);
});

it("scrollToBottom(force) ends history-reading mode", () => {
  const element = document.createElement("div");
  element.appendChild(document.createElement("div"));
  Object.defineProperties(element, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 500 },
  });
  const ref = { current: element };
  const onReading = vi.fn();
  const { result } = renderHook(() =>
    useTranscriptScroll(ref, "reading-scroll", onReading),
  );
  act(() => {
    element.dispatchEvent(new Event("wheel"));
    element.scrollTop = 100;
    element.dispatchEvent(new Event("scroll"));
  });
  expect(onReading).toHaveBeenLastCalledWith(true);
  act(() => {
    result.current.scrollToBottom(true);
  });
  expect(onReading).toHaveBeenLastCalledWith(false);
  expect(element.scrollTop).toBe(2000);
});
