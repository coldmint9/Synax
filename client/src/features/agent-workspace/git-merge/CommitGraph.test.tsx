import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitGraph } from "./CommitGraph";
const commits = [
  {
    oid: "a",
    parents: ["c"],
    subject: "Target",
    author: "a",
    date: "today",
    refs: ["main"],
  },
  {
    oid: "b",
    parents: ["c"],
    subject: "Feature",
    author: "b",
    date: "today",
    refs: ["feature/a"],
  },
  {
    oid: "c",
    parents: [],
    subject: "Base",
    author: "c",
    date: "today",
    refs: [],
  },
];
const pending = {
  key: "mr",
  target: "main",
  sources: ["feature/a"],
  parents: ["a", "b"],
};
let instances: Array<{
  callback: IntersectionObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}>;
let reduce: boolean;
let change: () => void;
let hidden: boolean;
let original: PropertyDescriptor | undefined;
beforeEach(() => {
  instances = [];
  reduce = false;
  hidden = false;
  change = () => {};
  original = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  vi.spyOn(window, "matchMedia").mockImplementation(
    () =>
      ({
        get matches() {
          return reduce;
        },
        addEventListener: (_type: string, callback: () => void) => {
          change = callback;
        },
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: IntersectionObserverCallback;
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        instances.push(this);
      }
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (original) Object.defineProperty(document, "visibilityState", original);
  else delete (document as any).visibilityState;
});
describe("prospective merge graph motion lifecycle", () => {
  it("draws a labelled dashed prospective merge without claiming a real commit", () => {
    const { container, unmount } = render(
      <CommitGraph commits={commits} pendingMerge={pending} />,
    );
    expect(screen.getByText("待合并")).toBeVisible();
    expect(container.querySelectorAll("path.is-pending")).toHaveLength(2);
    expect(container.textContent).not.toContain("pending:mr");
    expect(container.querySelector("[data-motion]")).toHaveAttribute(
      "data-motion",
      "paused",
    );
    unmount();
  });
  it("shares the observer, pauses offscreen/background/reduced motion, and releases the last instance", () => {
    const a = render(<CommitGraph commits={commits} pendingMerge={pending} />);
    const b = render(<CommitGraph commits={commits} pendingMerge={pending} />);
    expect(instances).toHaveLength(1);
    const element = a.container.querySelector("section")!;
    act(() =>
      instances[0].callback(
        [
          {
            target: element,
            isIntersecting: true,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      ),
    );
    expect(element).toHaveAttribute("data-motion", "running");
    act(() => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(element).toHaveAttribute("data-motion", "paused");
    act(() => {
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      reduce = true;
      change();
    });
    expect(element).toHaveAttribute("data-motion", "paused");
    act(() => {
      reduce = false;
      change();
    });
    expect(element).toHaveAttribute("data-motion", "running");
    act(() =>
      instances[0].callback(
        [
          {
            target: element,
            isIntersecting: false,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      ),
    );
    expect(element).toHaveAttribute("data-motion", "paused");
    a.unmount();
    expect(instances[0].disconnect).not.toHaveBeenCalled();
    b.unmount();
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    expect(instances[0].unobserve).toHaveBeenCalledTimes(2);
  });
  it("removes prospective state and stops observation on completion", () => {
    const { container, rerender, unmount } = render(
      <CommitGraph commits={commits} pendingMerge={pending} />,
    );
    rerender(<CommitGraph commits={commits} />);
    expect(container.querySelectorAll(".is-pending")).toHaveLength(0);
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
    unmount();
  });
});
