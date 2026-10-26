import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TimelineVirtualWindow, anchorVirtualEntry, scrollToVirtualEntry } from "../TimelineVirtualWindow";
import type { ConversationTimelineEntry } from "../buildConversationTimeline";

const entries: ConversationTimelineEntry[] = Array.from({ length: 1000 }, (_, i) => ({
  id: `row-${i}`, kind: "user", content: `Message ${i}`, label: "", createdAt: "", injected: false,
}));
function Harness() {
  const root = useRef<HTMLDivElement>(null);
  return <div ref={root} data-testid="scroll">
    <TimelineVirtualWindow entries={entries} scrollRootRef={root} cacheKey="virtual-test"
      renderRows={rows => rows.map(entry => <div key={entry.id}>{entry.id}</div>)} />
  </div>;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("bounds mounted rows across the entire history and supports navigation to unmounted messages", async () => {
  const { container, getByTestId } = render(<Harness />);
  const root = getByTestId("scroll");
  Object.defineProperty(root, "clientHeight", { value: 600, configurable: true });
  const list = container.querySelector<HTMLElement>("[data-virtual-timeline]")!;
  list.getBoundingClientRect = () => ({ top: -root.scrollTop } as DOMRect);
  expect(container.querySelectorAll("[data-virtual-row]").length).toBeLessThan(40);
  act(() => { root.scrollTop = 0; fireEvent.scroll(root); });
  await waitFor(() => expect(container.querySelector('[data-virtual-row="row-0"]')).not.toBeNull());
  expect(container.querySelector('[data-virtual-row="row-999"]')).toBeNull();
  act(() => { expect(scrollToVirtualEntry(root, "row-500")).toBe(true); });
  await waitFor(() => expect(container.querySelector('[data-virtual-row="row-500"]')).not.toBeNull());
  expect(container.querySelector('[data-virtual-row="row-0"]')).toBeNull();
  expect(container.querySelectorAll("[data-virtual-row]").length).toBeLessThan(40);
});

it("keeps an explicit reading anchor stable as preceding virtual rows are measured again", () => {
  const observers = new Set<ResizeObserverCallback>();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) { observers.add(callback); }
    observe() {}
    disconnect() { observers.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  let rowHeight = 100;
  let root: HTMLElement | undefined;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    if (this.hasAttribute("data-virtual-timeline")) return { top: 45 - (root?.scrollTop ?? 0) } as DOMRect;
    if (this.hasAttribute("data-virtual-row")) return { height: rowHeight } as DOMRect;
    return { top: 0, height: 600 } as DOMRect;
  });
  const view = render(<Harness />);
  root = view.getByTestId("scroll");
  Object.defineProperty(root, "scrollHeight", { value: 1000000, configurable: true });
  act(() => { expect(anchorVirtualEntry(root!, "row-500", 45)).toBe(true); });
  const position = () => Number.parseFloat(view.container.querySelector<HTMLElement>('[data-virtual-row="row-500"]')!.style.top) + 45 - root!.scrollTop;
  expect(position()).toBeCloseTo(45);
  act(() => {
    rowHeight = 160;
    for (const callback of [...observers]) callback([], {} as ResizeObserver);
  });
  expect(position()).toBeCloseTo(45);
});
