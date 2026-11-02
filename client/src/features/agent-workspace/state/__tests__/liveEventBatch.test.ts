import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentSessionStore as store } from "../agentSessionStore";
import type { LiveEventInput } from "../liveEventQueue";
import type { SessionLiveEvent } from "../../../../adapters/transport/sessionLive";
import type { AgentSession } from "../../../../adapters/transport/agentRuntime";

const message = (id: string): SessionLiveEvent =>
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

const batch = (...events: SessionLiveEvent[]): LiveEventInput[] =>
  events.map((event) => ({ event, streamSessionId: "s" }));

function seed() {
  store.setState({
    ...store.getInitialState(),
    selectedSessionId: "s",
    sessions: [
      {
        id: "s",
        projectId: "p",
        status: "queued",
        activeRunId: null,
        sessionMetadata: {},
      } as AgentSession,
    ],
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  seed();
});

afterEach(() => {
  store.getState().applyLiveEvent({
    type: "runtime_state",
    sessionId: "s",
    patch: {},
    reset: true,
    refresh: false,
  });
  store.setState(store.getInitialState());
  vi.useRealTimers();
});

it("commits a whole frame of records as one transition", () => {
  const notify = vi.fn();
  const unsubscribe = store.subscribe(notify);
  try {
    store.getState().applyLiveEvents(batch(
      { type: "step_started", stepId: "step", stepIndex: 1 },
      {
        type: "tool_call",
        stepId: "step",
        toolCall: {
          id: "tool",
          sessionId: "s",
          runId: "run",
          stepId: "step",
          toolId: "file.read",
          category: "read",
          mutability: "read",
          inputSummary: "README.md",
          outputSummary: null,
          status: "running",
          startedAt: "2026-01-01T00:00:00Z",
          endedAt: null,
          error: null,
        },
      } as SessionLiveEvent,
      message("m1"),
      message("m2"),
    ));
    // One commit for four records: this is what keeps a burst to one render.
    expect(notify).toHaveBeenCalledTimes(1);
    const state = store.getState();
    expect(state.streamingStepId).toBe("step");
    expect(state.toolCalls.map((call) => call.id)).toEqual(["tool"]);
    expect(state.messages.map((item) => item.id)).toEqual(["m1", "m2"]);
  } finally {
    unsubscribe();
  }
});

it("keeps records in order and joins buffered text with its step handoff", () => {
  store.getState().applyLiveEvents(batch(
    { type: "step_started", stepId: "first", stepIndex: 1 },
    { type: "message_delta", stepId: "first", delta: "Streaming answer" },
    { type: "step_started", stepId: "second", stepIndex: 2 },
    message("m1"),
  ));
  const state = store.getState();
  expect(state.streamingStepId).toBe("second");
  expect(state.streamingCompletedSteps[0]?.blocks).toEqual([
    { type: "text", content: "Streaming answer" },
  ]);
  expect(state.messages.map((item) => item.id)).toEqual(["m1"]);
  // Nothing was committed after the batch: the buffered text is not flushed
  // again by its own timer.
  vi.advanceTimersByTime(100);
  expect(store.getState().streamingCompletedSteps[0]?.blocks).toEqual([
    { type: "text", content: "Streaming answer" },
  ]);
});

it("runs a store action inside the batch without losing the staged frame", () => {
  const notify = vi.fn();
  const unsubscribe = store.subscribe(notify);
  try {
    store.getState().applyLiveEvents(batch(
      message("m1"),
      message("m2"),
      {
        type: "runtime_state",
        sessionId: "s",
        patch: { status: "running" },
        reset: false,
        refresh: false,
      } as SessionLiveEvent,
    ));
    const state = store.getState();
    // Both records land in the first transition. The session action then makes
    // its own writes, so a frame costs a transition per action — never one per
    // record.
    expect(notify.mock.calls[0]?.[0].messages.map((item: { id: string }) => item.id))
      .toEqual(["m1", "m2"]);
    expect(notify.mock.calls.length).toBeLessThanOrEqual(3);
    expect(state.messages.map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(state.sessions.find((item) => item.id === "s")?.status).toBe("running");
  } finally {
    unsubscribe();
  }
});

it("keeps the single-record entry point synchronous", () => {
  store.getState().applyLiveEvent(message("m1"), "s");
  expect(store.getState().messages.map((item) => item.id)).toEqual(["m1"]);
});

it("ignores records from a stream that no longer owns the selection", () => {
  store.getState().applyLiveEvents([
    { event: message("stale"), streamSessionId: "other" },
  ]);
  expect(store.getState().messages).toEqual([]);
});
