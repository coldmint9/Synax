import { beforeEach, expect, it, vi } from "vitest";
import type { AgentSession, AgentRunStep, ToolCallRecord } from "../../../../adapters/transport/agentRuntime";
import { ensureSessionLiveSubscription } from "../../../../adapters/transport/sessionLiveClient";
import { captureRunRealtimeCheckpoint } from "../../../../adapters/transport/runRealtime";
import { useAgentSessionStore as store, type SessionDetailCacheEntry } from "../agentSessionStore";
import { EMPTY_STREAMING_BUFFERS } from "../../streamingLiveBlocks";

vi.mock("../../../../adapters/transport/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(), releaseSessionLiveSubscription: vi.fn(),
}));
vi.mock("../../../../adapters/transport/runRealtime", () => ({ captureRunRealtimeCheckpoint: vi.fn() }));

const checkpoint = { sessionId: "a", runId: "run-a", projection: {
  cursor: 40, stepId: "step-a", completedSteps: [], stateKey: "running",
} };
const sessions = [
  { id: "a", projectId: "p", status: "running", activeRunId: "run-a", sessionMetadata: {} },
  { id: "b", projectId: "p", status: "completed", activeRunId: null, sessionMetadata: {} },
] as AgentSession[];
const page = (): SessionDetailCacheEntry => ({
  cachedAt: Date.now(), runs: [], steps: [], messages: [], toolCalls: [], events: [], permissions: [],
  sessionStats: null, sessionTodos: [], sessionInvocationUsage: null,
  historyWindow: { revision: 1, epoch: 1, hasEarlier: false, latest: true, detailsTruncated: false, syncCursor: "history-1" },
});
const step = { id: "step-a", runId: "run-a", sessionId: "a", index: 1, status: "running", startedAt: "2026-10-28T01:00:00Z" } as AgentRunStep;
const call = { id: "call-a", sessionId: "a", stepId: "step-a", runId: "run-a", toolId: "bash", category: "shell", mutability: "read", status: "running", inputSummary: "npm test", startedAt: step.startedAt } as ToolCallRecord;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(captureRunRealtimeCheckpoint).mockReturnValue(checkpoint);
  store.setState({ ...store.getInitialState(), projectId: "p", sessions, selectedSessionId: "a", panelOpen: true,
    sessionDetailCache: { a: page(), b: page() }, detailLoading: false,
    refreshDetail: vi.fn(async () => {}), loadInputQueue: vi.fn(async () => {}),
    streamingStepId: step.id, steps: [step],
  });
});

it("restores the exact cached calls, pending reasoning and cursor before background reconciliation", () => {
  store.getState().applyLiveEvent({ type: "tool_call", stepId: step.id, toolCall: call }, "a");
  // This delta is still in the 32ms batch when the user switches away.
  store.getState().applyLiveEvent({ type: "thought_delta", stepId: step.id, delta: "buffered reasoning" }, "a");
  const calls = store.getState().toolCalls;
  store.getState().openPanel("b");
  const cached = store.getState().sessionDetailCache.a;
  expect(cached.toolCalls).toBe(calls);
  expect(cached.live?.streamingLive.pendingThinking).toBe("buffered reasoning");
  expect(cached.live?.checkpoint).toBe(checkpoint);
  expect(store.getState().toolCalls).toEqual([]);
  expect(store.getState().streamingLive).toBe(EMPTY_STREAMING_BUFFERS);
  store.getState().openPanel("a");
  expect(store.getState().toolCalls).toBe(calls);
  expect(store.getState().streamingLive).toBe(cached.live?.streamingLive);
  expect(store.getState().streamingStepId).toBe(step.id);
  expect(store.getState().detailLoading).toBe(false);
  expect(ensureSessionLiveSubscription).toHaveBeenLastCalledWith("a", expect.any(Function), checkpoint);
  store.getState().applyLiveEvent({ type: "tool_result", stepId: step.id, toolCall: { ...call, status: "completed", outputSummary: "pass" } }, "a");
  expect(store.getState().streamingLive.blocks[0]).toMatchObject({ type: "tool_call", call: { id: "call-a", status: "completed", outputSummary: "pass" } });
  store.getState().applyLiveEvent({ type: "tool_call", stepId: step.id, toolCall: { ...call, id: "call-new" } }, "a");
  expect(store.getState().toolCalls.map(item => [item.id, item.status])).toEqual([["call-a", "completed"], ["call-new", "running"]]);
});

it("never restores an earlier run's live projection into a new run", () => {
  store.getState().openPanel("b");
  store.getState().patchSession("a", { activeRunId: "run-new" });
  store.getState().openPanel("a");
  expect(store.getState().streamingStepId).toBeNull();
  expect(store.getState().streamingLive).toBe(EMPTY_STREAMING_BUFFERS);
  expect(ensureSessionLiveSubscription).toHaveBeenLastCalledWith("a", expect.any(Function));
});

it("invalidates cached live state on a history rewrite", () => {
  store.getState().openPanel("b");
  expect(store.getState().sessionDetailCache.a.live).toBeDefined();
  store.getState().resetConversationHistory("a");
  expect(store.getState().sessionDetailCache.a.live).toBeUndefined();
  store.getState().openPanel("a");
  expect(store.getState().streamingStepId).toBeNull();
  expect(ensureSessionLiveSubscription).toHaveBeenLastCalledWith("a", expect.any(Function));
});
