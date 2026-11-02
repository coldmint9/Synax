import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStaticTimeline } from "../SessionStaticTimeline";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { EMPTY_STREAMING_BUFFERS } from "../streamingLiveBlocks";
import { useShellStore } from "../../../shared/state/shellStore";
import type {
  AgentRun,
  AgentRunStep,
  AgentSession,
  ToolCallRecord,
} from "../../../adapters/transport/agentRuntime";

// The card's stop/close controls navigate; the delegation card itself is what
// this file asserts.
vi.mock("../SubagentControls", () => ({ SubagentControls: () => null }));

const session = {
  id: "session",
  projectId: "project",
  parentSessionId: null,
  childSessionIds: [],
  nodeId: null,
  profileId: "planner",
  status: "running",
  title: "Delegating session",
  prompt: "Fix the bug",
  contextSnapshotId: null,
  thinkingMode: "standard",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  completedAt: null,
  resultSummary: null,
  blockedReason: null,
  skillIds: [],
  activeRunId: "run",
  pendingResumeToken: null,
  model: "test-model",
} as AgentSession;

const run = {
  id: "run",
  sessionId: "session",
  status: "running",
  startedAt: "2026-01-01T00:00:00Z",
  completedAt: null,
  triggerMessageId: null,
  currentStep: 2,
  stopReason: null,
  model: "test-model",
  metadata: {},
} as AgentRun;

const liveStep = {
  id: "step-live",
  sessionId: "session",
  runId: "run",
  index: 2,
  status: "running",
  startedAt: "2026-01-01T00:00:10Z",
  completedAt: null,
  finishReason: null,
  model: "test-model",
  metadata: {},
} as unknown as AgentRunStep;

const decompChild = {
  id: "child-1",
  projectId: "project",
  parentSessionId: "session",
  childSessionIds: [],
  nodeId: null,
  profileId: "subagent",
  status: "running",
  title: "",
  prompt: "筛查前端组件的改动面",
  contextSnapshotId: null,
  thinkingMode: "standard",
  createdAt: "2026-01-01T00:00:12Z",
  updatedAt: "2026-01-01T00:00:12Z",
  completedAt: null,
  resultSummary: null,
  blockedReason: null,
  skillIds: [],
  activeRunId: null,
  pendingResumeToken: null,
  model: "test-model",
  sessionMetadata: { subagentName: "前哨", roleName: "审查员" },
} as unknown as AgentSession;

function delegateCall(status: ToolCallRecord["status"]): ToolCallRecord {
  return {
    id: "call-delegate",
    sessionId: "session",
    runId: "run",
    stepId: liveStep.id,
    toolId: "subagent.delegate",
    category: "task",
    mutability: "task",
    inputSummary: "筛查前端组件的改动面",
    outputSummary: status === "completed" ? "子代理已完成筛查" : null,
    status,
    startedAt: "2026-01-01T00:00:11Z",
    endedAt: status === "completed" ? "2026-01-01T00:00:30Z" : null,
    error: null,
  } as ToolCallRecord;
}

const props = {
  unifiedLive: true,
  session,
  runs: [run],
  steps: [liveStep],
  messages: [],
  toolCalls: [],
  excludeStepId: liveStep.id,
  isRunning: true,
};

afterEach(() => {
  cleanup();
  act(() => store.setState(store.getInitialState()));
});

function renderLive(childSessions?: AgentSession[]) {
  act(() => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "zh" },
    }));
    store.setState({
      ...store.getInitialState(),
      selectedSessionId: session.id,
      sessions: [session],
      runs: [run],
      steps: [liveStep],
      streamingStepId: liveStep.id,
      streamingLive: EMPTY_STREAMING_BUFFERS,
    });
  });
  act(() =>
    store.getState().applyLiveEvent({
      type: "tool_call",
      stepId: liveStep.id,
      toolCall: delegateCall("running"),
    }),
  );
  return render(<SessionStaticTimeline {...props} childSessions={childSessions} />);
}

it("renders an interactive card for a delegation running in the live step", () => {
  const { container } = renderLive([decompChild]);
  const card = container.querySelector(".subagent-task-card");
  expect(card).not.toBeNull();
  expect(card).toHaveTextContent("筛查前端组件的改动面");
  // The card is the child's own identity, not a duplicated tool line.
  expect(card).toHaveTextContent("前哨");
  expect(
    card?.querySelector('[aria-expanded="false"]'),
  ).not.toBeNull();
});

it("keeps the plain tool row while the child session is still unknown", () => {
  const { container } = renderLive();
  expect(container.querySelector(".subagent-task-card")).toBeNull();
  expect(container).toHaveTextContent("委派子任务");
});
