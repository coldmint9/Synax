import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentSessionStore as store } from "../agentSessionStore";
import { materializeLiveBlocks } from "../../streamingLiveBlocks";
import type { AgentSession } from "../../../../../lib/api/agentRuntime";
import type { ToolCallRecord } from "../../../../../lib/api/agentRuntime";

vi.mock("../../../../../lib/api/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
import {
  ensureSessionLiveSubscription,
  releaseSessionLiveSubscription,
} from "../../../../../lib/api/sessionLiveClient";

/**
 * Regression: a stale live stream (its session no longer selected) must never
 * render its steps, deltas or tool calls into the newly selected session's
 * transcript slot. The subscription singleton can still be attached to the
 * previous session between a synchronous selection change and the React
 * effect that releases it.
 */

const row = (id: string, status: AgentSession["status"]): AgentSession =>
  ({
    id,
    projectId: "p",
    parentSessionId: null,
    childSessionIds: [],
    status,
    profileId: "synax",
    title: id,
    prompt: "",
    updatedAt: "2026-09-24T00:00:00Z",
    sessionMetadata: { mode: "chat" },
  }) as AgentSession;

const toolCall = {
  id: "tool-stale",
  sessionId: "session-a",
  runId: "run-a",
  stepId: "step-a",
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

const staleStep = {
  id: "step-a",
  sessionId: "session-a",
  runId: "run-a",
  index: 1,
  status: "running",
  startedAt: "2026-01-01T00:00:00Z",
  completedAt: null,
} as never;

beforeEach(() => {
  vi.useFakeTimers();
  store.setState({
    ...store.getInitialState(),
    selectedSessionId: "session-b",
    sessions: [row("session-a", "running"), row("session-b", "completed")],
  });
});
afterEach(() => {
  store.setState(store.getInitialState());
  vi.useRealTimers();
});

it("drops a stale stream's step_started instead of seeding the selected transcript", () => {
  store
    .getState()
    .applyLiveEvent(
      { type: "step_started", stepId: "step-a", stepIndex: 1, step: staleStep },
      "session-a",
    );

  expect(store.getState().streamingStepId).toBeNull();
  expect(store.getState().steps).toEqual([]);
  expect(store.getState().streamingCompletedSteps).toEqual([]);
});

it("drops a stale stream's deltas and tool records after its step_started", () => {
  // Even if a stale step_started slipped through before selection moved, the
  // following chunks must not extend its turn inside the selected session.
  store
    .getState()
    .applyLiveEvent({ type: "step_started", stepId: "step-a", stepIndex: 1 });
  store
    .getState()
    .applyLiveEvent(
      { type: "message_delta", stepId: "step-a", delta: "Wrong session text" },
      "session-a",
    );
  store
    .getState()
    .applyLiveEvent(
      { type: "tool_call", stepId: "step-a", toolCall },
      "session-a",
    );
  vi.advanceTimersByTime(100);

  expect(materializeLiveBlocks(store.getState().streamingLive)).toEqual([]);
  expect(store.getState().toolCalls).toEqual([]);
});

it("still applies a stream's own events when it matches the selected session", () => {
  store
    .getState()
    .applyLiveEvent(
      { type: "step_started", stepId: "step-b", stepIndex: 1 },
      "session-b",
    );
  store
    .getState()
    .applyLiveEvent(
      { type: "message_delta", stepId: "step-b", delta: "Right session" },
      "session-b",
    );
  vi.advanceTimersByTime(100);

  expect(store.getState().streamingStepId).toBe("step-b");
  expect(materializeLiveBlocks(store.getState().streamingLive)).toEqual([
    { type: "text", content: "Right session" },
  ]);
});

it("keeps runtime_state patches session-scoped for background sessions", () => {
  store
    .getState()
    .applyLiveEvent(
      {
        type: "runtime_state",
        sessionId: "session-a",
        patch: { status: "waiting_permission" },
        reset: true,
        refresh: false,
      },
      "session-a",
    );

  expect(
    store.getState().sessions.find((s) => s.id === "session-a")?.status,
  ).toBe("waiting_permission");
  // A background session's reset must not clear the selected session's state.
  expect(store.getState().streamingStepId).toBeNull();
});

it("releases the previous session's live subscription when switching to an inactive session", () => {
  store.setState({
    ...store.getInitialState(),
    selectedSessionId: "session-a",
    sessions: [row("session-a", "running"), row("session-b", "completed")],
    panelOpen: true,
  });
  vi.mocked(releaseSessionLiveSubscription).mockClear();
  vi.mocked(ensureSessionLiveSubscription).mockClear();

  // Switching to a completed session: no ensureLiveStream, but the stale
  // singleton must be dropped synchronously inside openPanel.
  store.getState().openPanel("session-b");

  expect(releaseSessionLiveSubscription).toHaveBeenCalledTimes(1);
  expect(ensureSessionLiveSubscription).not.toHaveBeenCalled();
  expect(store.getState().selectedSessionId).toBe("session-b");
});
