import { act, render } from "@testing-library/react";
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

const session = {
  id: "session",
  projectId: "project",
  parentSessionId: null,
  childSessionIds: [],
  nodeId: null,
  profileId: "planner",
  status: "running",
  title: "Live session",
  prompt: "Draw the boat",
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

const toolCall = {
  id: "t1",
  sessionId: "session",
  runId: "run",
  stepId: "step-live",
  toolId: "file.read",
  category: "read",
  mutability: "read",
  inputSummary: "README.md",
  outputSummary: "ok",
  status: "running",
  startedAt: "2026-01-01T00:00:10Z",
  endedAt: null,
  error: null,
} as ToolCallRecord;

const DELTA_FLUSH_MS = 80;
const advance = (totalMs: number) => {
  for (let elapsed = 0; elapsed < totalMs; elapsed += 40)
    act(() => vi.advanceTimersByTime(Math.min(40, totalMs - elapsed)));
};

function renderLive(showThinking: boolean, isRunning = true) {
  useShellStore.setState((s) => ({ preferences: { ...s.preferences, sessionShowThinking: showThinking } }));
  store.setState({
    ...store.getInitialState(),
    selectedSessionId: session.id,
    sessions: [session],
    runs: [run],
    steps: [liveStep],
    streamingStepId: liveStep.id,
    streamingLive: EMPTY_STREAMING_BUFFERS,
  });
  const view = render(
    <SessionStaticTimeline
      unifiedLive
      session={session}
      runs={[run]}
      steps={liveStep.status === "running" ? [liveStep] : [{ ...liveStep, status: "completed" }]}
      messages={[]}
      toolCalls={[]}
      excludeStepId={liveStep.id}
      isRunning={isRunning}
    />,
  );
  const apply = (delta: { type: "thought_delta" | "message_delta"; delta: string } | { type: "tool_call" }) =>
    act(() => store.getState().applyLiveEvent(
      delta.type === "tool_call"
        ? { type: "tool_call", stepId: liveStep.id, toolCall }
        : { ...delta, stepId: liveStep.id },
    ));
  return {
    view,
    apply,
    indicator: () => view.container.querySelectorAll('[data-testid="thinking-indicator"]'),
  };
}

afterEach(() => {
  act(() => store.setState(store.getInitialState()));
  vi.useRealTimers();
});

it("stands in for hidden reasoning after the reply text while the step runs", () => {
  vi.useFakeTimers();
  const { apply, indicator } = renderLive(false);
  apply({ type: "thought_delta", delta: "先确认结构。" });
  advance(DELTA_FLUSH_MS);
  expect(indicator()).toHaveLength(1);

  apply({ type: "message_delta", delta: "我先说一句正文。" });
  advance(DELTA_FLUSH_MS);
  expect(indicator()).toHaveLength(1);

  // The model resumes reasoning after its text: the placeholder stays one row,
  // it never stacks a second one.
  apply({ type: "thought_delta", delta: "继续推演画面。" });
  advance(DELTA_FLUSH_MS);
  expect(indicator()).toHaveLength(1);
});

it("drops the placeholder as soon as a tool record owns the activity", () => {
  vi.useFakeTimers();
  const { apply, indicator } = renderLive(false);
  apply({ type: "thought_delta", delta: "先确认结构。" });
  apply({ type: "message_delta", delta: "我先说一句正文。" });
  advance(DELTA_FLUSH_MS);
  expect(indicator()).toHaveLength(1);

  apply({ type: "tool_call" });
  advance(DELTA_FLUSH_MS);
  expect(indicator()).toHaveLength(0);
});

it("renders no extra placeholder when reasoning is visible or the run settled", () => {
  vi.useFakeTimers();
  const visible = renderLive(true);
  visible.apply({ type: "thought_delta", delta: "先确认结构。" });
  visible.apply({ type: "message_delta", delta: "我先说一句正文。" });
  advance(DELTA_FLUSH_MS);
  // The reasoning row renders itself; a second generic row would duplicate it.
  expect(visible.view.container.querySelector(".session-process-trigger")).not.toBeNull();
  expect(visible.indicator()).toHaveLength(0);
  visible.view.unmount();

  const settled = renderLive(false, false);
  settled.apply({ type: "thought_delta", delta: "先确认结构。" });
  settled.apply({ type: "message_delta", delta: "我先说一句正文。" });
  advance(DELTA_FLUSH_MS);
  expect(settled.indicator()).toHaveLength(0);
});
