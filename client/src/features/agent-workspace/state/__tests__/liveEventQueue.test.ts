import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_EVENT_BATCH_MS,
  discardQueuedLiveEvents,
  enqueueLiveEvent,
  flushLiveEvents,
  queuedLiveEventCount,
  setLiveEventDispatcher,
  type LiveEventInput,
} from "../liveEventQueue";
import type { SessionLiveEvent } from "../../../../adapters/transport/sessionLive";

const message = (id: string) =>
  ({
    type: "message",
    message: {
      id,
      sessionId: "s",
      runId: "run",
      stepId: "step",
      role: "assistant",
      content: id,
      metadata: {},
      createdAt: "2026-01-01T00:00:00Z",
    },
  }) as SessionLiveEvent;

let received: LiveEventInput[][] = [];

beforeEach(() => {
  vi.useFakeTimers();
  received = [];
  discardQueuedLiveEvents();
  setLiveEventDispatcher((items) => received.push(items));
});

afterEach(() => {
  discardQueuedLiveEvents();
  setLiveEventDispatcher(null);
  vi.useRealTimers();
});

describe("live event queue", () => {
  it("commits a frame of records as one batch, in arrival order", () => {
    enqueueLiveEvent(message("m1"), "s");
    enqueueLiveEvent(message("m2"), "s");
    enqueueLiveEvent({ type: "message_delta", stepId: "step", delta: "hi" }, "s");
    expect(received).toHaveLength(0);
    vi.advanceTimersByTime(LIVE_EVENT_BATCH_MS);
    expect(received).toHaveLength(1);
    expect(received[0].map((item) => item.event.type)).toEqual([
      "message",
      "message",
      "message_delta",
    ]);
    expect(received[0][0].streamSessionId).toBe("s");
    expect(queuedLiveEventCount()).toBe(0);
  });

  it("starts a new window after a flush instead of growing one queue", () => {
    enqueueLiveEvent(message("m1"), "s");
    vi.advanceTimersByTime(LIVE_EVENT_BATCH_MS);
    enqueueLiveEvent(message("m2"), "s");
    vi.advanceTimersByTime(LIVE_EVENT_BATCH_MS);
    expect(received).toHaveLength(2);
    expect(received[1]).toHaveLength(1);
  });

  it("drains at once when a burst is larger than one frame's worth", () => {
    const event = message("m");
    for (let index = 0; index < 300; index += 1)
      enqueueLiveEvent({ ...event, type: "message" } as SessionLiveEvent, "s");
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(300);
  });

  it("commits on demand, so a switch never parks a half-applied frame", () => {
    enqueueLiveEvent(message("m1"), "s");
    flushLiveEvents();
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
    // The pending timer must not fire a second, empty batch.
    vi.advanceTimersByTime(LIVE_EVENT_BATCH_MS * 4);
    expect(received).toHaveLength(1);
  });

  it("drops collected records when the stream no longer matters", () => {
    enqueueLiveEvent(message("m1"), "s");
    discardQueuedLiveEvents();
    vi.advanceTimersByTime(LIVE_EVENT_BATCH_MS * 4);
    expect(received).toHaveLength(0);
  });

  it("counts a record observed twice by two readers only once", () => {
    const event = message("m1");
    enqueueLiveEvent(event, "s");
    enqueueLiveEvent(event, "s");
    vi.advanceTimersByTime(LIVE_EVENT_BATCH_MS);
    expect(received[0]).toHaveLength(1);
  });
});
