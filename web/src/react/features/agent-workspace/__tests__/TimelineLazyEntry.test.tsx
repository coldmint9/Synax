import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TimelineLazyEntry } from "../TimelineLazyEntry";
import type { ConversationTimelineEntry } from "../buildConversationTimeline";

type ObserverCallback = (
  records: Array<{ isIntersecting: boolean; target: Element }>,
) => void;

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: ObserverCallback;
  targets: Element[] = [];
  disconnected = false;

  constructor(callback: ObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: Element) {
    this.targets.push(target);
  }

  unobserve(target: Element) {
    this.targets = this.targets.filter((item) => item !== target);
  }

  disconnect() {
    this.disconnected = true;
  }

  emit(isIntersecting: boolean) {
    this.callback(this.targets.map((target) => ({ isIntersecting, target })));
  }
}

function userEntry(id: string, content: string): ConversationTimelineEntry {
  return {
    id,
    kind: "user",
    createdAt: "2026-01-01T00:00:00Z",
    label: id,
    content,
  };
}

describe("TimelineLazyEntry", () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeIntersectionObserver.instances = [];
  });

  it("reserves height and defers the body until it reaches the viewport", async () => {
    render(
      <TimelineLazyEntry entryId="e1" cacheKey="user-e1" estimate={240}>
        <span>body</span>
      </TimelineLazyEntry>,
    );

    const anchor = document.getElementById("session-entry-e1");
    expect(anchor).not.toBeNull();
    expect(anchor?.style.minHeight).toBe("240px");
    expect(screen.queryByText("body")).toBeNull();

    await act(async () => {
      FakeIntersectionObserver.instances[0]?.emit(true);
    });

    expect(screen.getByText("body")).toBeTruthy();
    expect(document.getElementById("session-entry-e1")?.style.minHeight).toBe(
      "",
    );
  });

  it("keeps the rendered body mounted after it leaves the viewport again", async () => {
    render(
      <TimelineLazyEntry entryId="e2" cacheKey="user-e2" estimate={120}>
        <span>cached body</span>
      </TimelineLazyEntry>,
    );

    await act(async () => {
      FakeIntersectionObserver.instances[0]?.emit(true);
    });
    await act(async () => {
      FakeIntersectionObserver.instances[0]?.emit(false);
    });

    expect(screen.getByText("cached body")).toBeTruthy();
    expect(document.getElementById("session-entry-e2")?.style.minHeight).toBe(
      "",
    );
  });

  it("renders eagerly when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);

    render(
      <TimelineLazyEntry entryId="e3" cacheKey="user-e3" estimate={100}>
        <span>eager body</span>
      </TimelineLazyEntry>,
    );

    expect(screen.getByText("eager body")).toBeTruthy();
    expect(userEntry("e3", "eager body").kind).toBe("user");
  });

  it("never reserves placeholder height for live rows, including after they settle", () => {
    const { rerender } = render(
      <TimelineLazyEntry entryId="live" cacheKey="live" estimate={240} eager>
        <span>live answer</span>
      </TimelineLazyEntry>,
    );
    const original = screen.getByText("live answer");
    expect(document.getElementById("session-entry-live")?.style.minHeight).toBe(
      "",
    );
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
    rerender(
      <TimelineLazyEntry entryId="live" cacheKey="live" estimate={240}>
        <span>live answer</span>
      </TimelineLazyEntry>,
    );
    expect(screen.getByText("live answer")).toBe(original);
  });
});

it("shares a viewport observer between entries and releases it on unmount", () => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  const { unmount } = render(
    <>
      <TimelineLazyEntry entryId="shared-a" cacheKey="shared-a" estimate={100}>
        A
      </TimelineLazyEntry>
      <TimelineLazyEntry entryId="shared-b" cacheKey="shared-b" estimate={100}>
        B
      </TimelineLazyEntry>
    </>,
  );
  expect(FakeIntersectionObserver.instances).toHaveLength(1);
  expect(FakeIntersectionObserver.instances[0].targets).toHaveLength(2);
  unmount();
  expect(FakeIntersectionObserver.instances[0].disconnected).toBe(true);
  vi.unstubAllGlobals();
});
