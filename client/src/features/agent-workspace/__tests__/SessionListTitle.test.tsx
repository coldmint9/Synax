import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionListTitle } from "../SessionListTitle";

const animate = vi.fn();
const cancel = vi.fn();
let resize: ResizeObserverCallback | undefined;
let running: { cancel: typeof cancel; onfinish: (() => void) | null; startTime: number | null };
let motion: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.useFakeTimers();
  running = { cancel, onfinish: null, startTime: null };
  animate.mockReset().mockReturnValue(running);
  resize = undefined;
  cancel.mockReset();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {} disconnect() {}
  });
  motion = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.spyOn(window, "matchMedia").mockReturnValue(motion as unknown as MediaQueryList);
  vi.stubGlobal("Animation", class {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(width = 150, contentWidth = 250) {
  const result = render(<SessionListTitle title="Long conversation title" prefix={<i>PIN</i>} suffix={<b>WAIT</b>} />);
  const root = result.container.querySelector<HTMLElement>(".session-list-title")!;
  const viewport = root.querySelector<HTMLElement>(".session-list-title-viewport")!;
  const text = root.querySelector<HTMLElement>(".session-list-title-text")!;
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, get: () => width },
    scrollWidth: { configurable: true, get: () => contentWidth },
  });
  Object.defineProperty(text, "scrollWidth", { configurable: true, get: () => contentWidth });
  text.animate = animate;
  act(() => resize?.([], {} as ResizeObserver));
  return { ...result, root, viewport, text };
}

it("waits 500ms then scrolls only the title at 25px/second, holding the end", () => {
  const { root, viewport, text } = setup();
  fireEvent.pointerEnter(root, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(499));
  expect(animate).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(animate).toHaveBeenCalledWith(
    [{ transform: "translateX(0)" }, { transform: "translateX(-100px)" }],
    { duration: 4000, easing: "linear", fill: "forwards", iterations: 1 },
  );
  expect(viewport.dataset.scrolling).toBe("true");
  expect(root).not.toHaveAttribute("title");
  expect(text).not.toContainElement(screen.getByText("PIN"));
  expect(text).not.toContainElement(screen.getByText("WAIT"));
});

it("never animates short titles", () => {
  const { root } = setup(250, 150);
  fireEvent.pointerEnter(root, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(1000));
  expect(animate).not.toHaveBeenCalled();
});

it("cancels a pending hover and starts a fresh delay on re-entry", () => {
  const { root } = setup();
  fireEvent.pointerEnter(root, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(300));
  fireEvent.pointerLeave(root);
  act(() => vi.advanceTimersByTime(600));
  expect(animate).not.toHaveBeenCalled();
  fireEvent.pointerEnter(root, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(500));
  expect(animate).toHaveBeenCalledTimes(1);
});

it("resets immediately on leave and restores the fading edge and full-title tooltip", () => {
  const { root, viewport } = setup();
  fireEvent.pointerEnter(root, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(500));
  fireEvent.pointerLeave(root);
  expect(cancel).toHaveBeenCalled();
  expect(viewport).not.toHaveAttribute("data-scrolling");
  expect(root).toHaveAttribute("title", "Long conversation title");
});

it("stops and remeasures when sidebar width changes", () => {
  const { root, viewport } = setup();
  fireEvent.pointerEnter(root, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(500));
  Object.defineProperty(viewport, "clientWidth", { get: () => 300 });
  act(() => resize?.([], {} as ResizeObserver));
  act(() => vi.advanceTimersByTime(1000));
  expect(cancel).toHaveBeenCalled();
  expect(animate).toHaveBeenCalledTimes(1);
  expect(viewport).not.toHaveAttribute("data-scrolling");
});

it("does not animate under reduced motion, preserving the full title", () => {
  motion.matches = true;
  const { root } = setup();
  fireEvent.pointerEnter(root, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(1000));
  expect(animate).not.toHaveBeenCalled();
  expect(root).toHaveAttribute("title", "Long conversation title");
});

it("cleans up the animation on title changes and unmount", () => {
  const { root, rerender, unmount } = setup();
  fireEvent.pointerEnter(root, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(500));
  rerender(<SessionListTitle title="Renamed" />);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(root).toHaveAttribute("title", "Renamed");
  fireEvent.pointerEnter(root, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(500));
  unmount();
  expect(cancel).toHaveBeenCalledTimes(2);
});

it("ignores touch pointers", () => {
  const { root } = setup();
  fireEvent.pointerEnter(root, { pointerType: "touch" });
  act(() => vi.advanceTimersByTime(1000));
  expect(animate).not.toHaveBeenCalled();
});

it("stops a running title if reduced motion is enabled", () => {
  const { root, viewport } = setup();
  fireEvent.pointerEnter(root, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(500));
  motion.matches = true;
  act(() => motion.addEventListener.mock.calls[0][1]());
  expect(cancel).toHaveBeenCalled();
  expect(viewport).not.toHaveAttribute("data-scrolling");
});


it("marks overflow before hovering and keeps the decorative blur copy out of accessibility", () => {
  const { root, viewport } = setup();
  expect(viewport.dataset.overflow).toBe("true");
  const blur = root.querySelector(".session-list-title-blur");
  expect(blur).toHaveAttribute("aria-hidden", "true");
  expect(blur?.textContent).toBe("Long conversation title");
  expect(blur?.querySelectorAll(".session-list-title-blur-text")).toHaveLength(1);
});

it("does not fade or duplicate a short title", () => {
  const { root, viewport } = setup(300, 150);
  expect(viewport).not.toHaveAttribute("data-overflow");
  expect(root.querySelector(".session-list-title-blur")?.childElementCount).toBe(0);
});

it("removes the fade and blur when the final characters become visible", () => {
  const { root, viewport } = setup();
  fireEvent.pointerEnter(root, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(500));
  expect(viewport).not.toHaveAttribute("data-at-end");
  act(() => running.onfinish?.());
  expect(viewport).toHaveAttribute("data-at-end", "true");
  fireEvent.pointerLeave(root);
  expect(viewport).not.toHaveAttribute("data-at-end");
  expect(viewport).toHaveAttribute("data-overflow", "true");
});

it("updates the fade when the sidebar is resized without hover", () => {
  const { viewport } = setup(300, 250);
  expect(viewport).not.toHaveAttribute("data-overflow");
  Object.defineProperty(viewport, "clientWidth", { get: () => 100, configurable: true });
  act(() => resize?.([], {} as ResizeObserver));
  expect(viewport).toHaveAttribute("data-overflow", "true");
  Object.defineProperty(viewport, "clientWidth", { get: () => 350 });
  act(() => resize?.([], {} as ResizeObserver));
  expect(viewport).not.toHaveAttribute("data-overflow");
  expect(animate).not.toHaveBeenCalled();
});
