import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentSessionStore as store } from "../agentSessionStore";
import { materializeLiveBlocks } from "../../streamingLiveBlocks";
import type { AgentSession } from "../../../../adapters/transport/agentRuntime";
import type { ToolCallRecord } from "../../../../adapters/transport/agentRuntime";
import { agentRuntimeApi } from "../../../../adapters/transport/agentRuntime";
import { usePendingSubmissionStore } from "../pendingSubmissionStore";

vi.mock("../../../../adapters/transport/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
import {
  ensureSessionLiveSubscription,
  releaseSessionLiveSubscription,
} from "../../../../adapters/transport/sessionLiveClient";

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
  usePendingSubmissionStore.setState({ items: {} });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("sends a side chat message without replacing the main conversation or its stream", async () => {
  const submit = vi.spyOn(agentRuntimeApi, "submitRun").mockResolvedValue({
    run: { id: "run-side", sessionId: "session-a", status: "running" } as never,
    reused: false,
  });
  store.setState({ refreshSessions: vi.fn(async () => {}), refreshDetail: vi.fn(async () => {}) });
  vi.mocked(ensureSessionLiveSubscription).mockClear();
  vi.mocked(releaseSessionLiveSubscription).mockClear();

  await store.getState().sendSessionMessage("session-a", { message: "A side question" });

  expect(submit).toHaveBeenCalledWith("session-a", expect.objectContaining({ message: "A side question" }), expect.any(String), "turn");
  expect(store.getState().selectedSessionId).toBe("session-b");
  expect(store.getState().messages).toEqual([]);
  expect(ensureSessionLiveSubscription).not.toHaveBeenCalled();
  expect(releaseSessionLiveSubscription).not.toHaveBeenCalled();
  expect(store.getState().refreshDetail).not.toHaveBeenCalled();
  expect(usePendingSubmissionStore.getState().items["session-a"]?.run?.id).toBe("run-side");
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
