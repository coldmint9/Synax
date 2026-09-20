import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentSessionStore as store } from "../agentSessionStore";
import { materializeLiveBlocks } from "../../streamingLiveBlocks";
import type { ToolCallRecord } from "../../../../../lib/api/agentRuntime";

const toolCall = {
  id: "tool",
  sessionId: "s",
  runId: "run",
  stepId: "first",
  toolId: "file.read",
  category: "read",
  mutability: "read",
  inputSummary: "README.md",
  outputSummary: null,
  status: "running",
  startedAt: "2026-01-01T00:00:00Z",
  endedAt: null,
  error: null,
} as ToolCallRecord;
const start = (stepId: string) =>
  store
    .getState()
    .applyLiveEvent({ type: "step_started", stepId, stepIndex: 1 });
const delta = (
  text: string,
  type: "message_delta" | "thought_delta" = "message_delta",
  stepId = "first",
) => store.getState().applyLiveEvent({ type, stepId, delta: text });

beforeEach(() => {
  vi.useFakeTimers();
  store.setState({ ...store.getInitialState(), selectedSessionId: "s" });
  start("first");
});
afterEach(() => {
  store
    .getState()
    .applyLiveEvent({
      type: "runtime_state",
      sessionId: "s",
      patch: {},
      reset: true,
      refresh: false,
    });
  store.setState(store.getInitialState());
  vi.useRealTimers();
});

it("batches a burst without dropping text at a step boundary", () => {
  const content = "Streaming answer ".repeat(500);
  delta(content);
  start("second");
  expect(store.getState().streamingCompletedSteps[0]?.blocks).toEqual([
    { type: "text", content },
  ]);
  vi.advanceTimersByTime(100);
  expect(materializeLiveBlocks(store.getState().streamingLive)).toEqual([]);
});

it("preserves text/thought/tool ordering when events arrive before the next paint", () => {
  delta("First answer");
  delta("Then inspect", "thought_delta");
  store
    .getState()
    .applyLiveEvent({ type: "tool_call", stepId: "first", toolCall });
  delta("Final answer");
  vi.advanceTimersByTime(100);
  expect(materializeLiveBlocks(store.getState().streamingLive)).toEqual([
    { type: "text", content: "First answer" },
    { type: "thinking", content: "Then inspect" },
    expect.objectContaining({ type: "tool_call" }),
    { type: "text", content: "Final answer" },
  ]);
});

it("keeps the last answer visible while completion waits for the persisted transcript", () => {
  delta("Finished answer");
  store
    .getState()
    .applyLiveEvent({
      type: "runtime_state",
      sessionId: "s",
      patch: { status: "completed" },
      reset: true,
      refresh: false,
    });
  expect(store.getState().streamingStepId).toBe("first");
  expect(materializeLiveBlocks(store.getState().streamingLive)).toEqual([
    { type: "text", content: "Finished answer" },
  ]);
});

it("ignores late deltas from a previous step", () => {
  start("second");
  delta("Stale answer");
  delta("Current answer", "message_delta", "second");
  vi.advanceTimersByTime(100);
  expect(materializeLiveBlocks(store.getState().streamingLive)).toEqual([
    { type: "text", content: "Current answer" },
  ]);
});

it("publishes a token burst once and leaves no idle drain timer", () => {
  const listener = vi.fn();
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.streamingLive !== previous.streamingLive) listener();
  });
  for (let i = 0; i < 100; i++) delta("x");
  vi.advanceTimersByTime(100);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(store.getState().streamingLive.pendingText).toBe("x".repeat(100));
  expect(vi.getTimerCount()).toBe(0);
  unsubscribe();
});
