import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentSessionStore as store } from "../agentSessionStore";

/**
 * Live → history handoff must never leave a rendered step with neither a live
 * buffer nor a snapshot: that gap removes the row for one commit and puts it
 * back on the next, which is the "command keeps flashing" symptom.
 */
const start = (stepId: string) => {
  store.getState().applyLiveEvent({
    type: "step_started",
    stepId,
    stepIndex: 1,
    step: {
      id: stepId,
      runId: "run",
      index: 1,
      status: "running",
      model: "gpt",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: null,
      durationMs: null,
    } as never,
  });
};
const delta = (text: string) =>
  store.getState().applyLiveEvent({ type: "message_delta", stepId: "step", delta: text });

/** Snapshot the store as one rendered frame would read it. */
const frame = () => {
  const state = store.getState();
  return {
    streamingStepId: state.streamingStepId,
    liveBlocks: state.streamingLive.blocks.length + (state.streamingLive.pendingText ? 1 : 0),
    snapshotIds: state.streamingCompletedSteps.map((step) => step.stepId),
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  store.setState({ ...store.getInitialState(), selectedSessionId: "s" });
  start("step");
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

it("keeps the running turn visible when the same step is announced again", () => {
  delta("Partial answer");
  vi.advanceTimersByTime(100);
  expect(frame().liveBlocks).toBe(1);

  // Bridges replay `step_started` for the step that is already streaming.
  start("step");

  const during = frame();
  expect(
    during.liveBlocks > 0 || during.snapshotIds.includes("step"),
    `rendered nothing for the running step: ${JSON.stringify(during)}`,
  ).toBe(true);
});
