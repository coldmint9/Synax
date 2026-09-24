import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStaticTimeline } from "../SessionStaticTimeline";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { EMPTY_STREAMING_BUFFERS } from "../streamingLiveBlocks";
import type {
  AgentRun,
  AgentRunStep,
  AgentSession,
  ToolCallRecord,
} from "../../../../lib/api/agentRuntime";

const session = {
  id: "session",
  projectId: "project",
  parentSessionId: null,
  childSessionIds: [],
  nodeId: null,
  profileId: "planner",
  status: "running",
  title: "Live session",
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

const toolCall = (status: ToolCallRecord["status"]) =>
  ({
    id: "t1",
    sessionId: "session",
    runId: "run",
    stepId: "step-live",
    toolId: "file.read",
    category: "read",
    mutability: "read",
    inputSummary: "README.md",
    outputSummary: "ok",
    status,
    startedAt: "2026-01-01T00:00:10Z",
    endedAt: status === "completed" ? "2026-01-01T00:00:11Z" : null,
    error: null,
  }) as ToolCallRecord;

const DELTA_FLUSH_MS = 80;
/** Advance across the reveal/release timer chain in React-sized steps. */
const advance = (totalMs: number) => {
  for (let elapsed = 0; elapsed < totalMs; elapsed += 40)
    act(() => vi.advanceTimersByTime(Math.min(40, totalMs - elapsed)));
};

afterEach(() => {
  act(() => store.setState(store.getInitialState()));
  vi.useRealTimers();
});

/**
 * The final summary of a round streams on the live step right after its tool
 * work. It must appear progressively as Markdown — a paragraph without a
 * newline keeps revealing as tokens arrive — instead of freezing and dumping
 * everything once the reply (or the run) finishes.
 */
it("streams the final summary progressively while the run is live", () => {
  vi.useFakeTimers();
  act(() => {
    store.setState({
      ...store.getInitialState(),
      selectedSessionId: "session",
      sessions: [session],
      runs: [run],
      steps: [liveStep],
      streamingStepId: "step-live",
      streamingLive: EMPTY_STREAMING_BUFFERS,
    });
  });
  const apply = store.getState().applyLiveEvent;
  act(() =>
    apply({ type: "thought_delta", stepId: "step-live", delta: "先确认实现。" }),
  );
  act(() =>
    apply({
      type: "tool_call",
      stepId: "step-live",
      toolCall: toolCall("completed"),
    }),
  );

  const props = {
    unifiedLive: true,
    session,
    runs: [run],
    steps: [liveStep],
    messages: [],
    toolCalls: [],
    excludeStepId: "step-live",
    isRunning: true,
  };
  const { container, rerender } = render(<SessionStaticTimeline {...props} />);

  const regions = () => container.querySelectorAll(".session-answer-region");
  const answerText = () => regions()[regions().length - 1]?.textContent ?? "";

  // The summary opens with a Markdown heading after the tool round. It must
  // become visible once streaming starts (the work-log collapse grace period
  // is bounded), not only when the whole reply is done.
  act(() =>
    apply({ type: "message_delta", stepId: "step-live", delta: "# 总结\n" }),
  );
  advance(DELTA_FLUSH_MS + 500);
  expect(container.querySelector("h1")).toHaveTextContent("总结");

  // A long paragraph streams in token bursts without any newline. Every burst
  // must become visible as it arrives…
  const paragraph =
    "本次修复让最后的总结按 Markdown 流式渲染，段落内容随令牌到达逐步显示，不再整段卡住后一次性出现。";
  let fed = "# 总结\n";
  for (const chunk of [16, 34, paragraph.length]) {
    const next = `# 总结\n${paragraph.slice(0, chunk)}`;
    act(() =>
      apply({ type: "message_delta", stepId: "step-live", delta: next.slice(fed.length) }),
    );
    fed = next;
    advance(DELTA_FLUSH_MS);
    // Each burst must be visible as plain-text tail while it has no newline.
    expect(
      container.querySelector(".markdown-stream-tail"),
    ).toHaveTextContent(paragraph.slice(Math.max(0, chunk - 4), chunk));
    // eslint-disable-next-line no-console
    expect(answerText()).toContain(paragraph.slice(0, 6));
  }
  expect(answerText()).toContain("本次修复");

  // …and once the run settles, the same text renders as parsed Markdown with
  // no streaming tail left behind.
  rerender(<SessionStaticTimeline {...props} isRunning={false} />);
  advance(DELTA_FLUSH_MS);
  expect(answerText()).toContain("本次修复");
  expect(
    container.querySelectorAll(".markdown-stream-tail"),
  ).toHaveLength(0);
  expect(container.querySelector("h1")).toHaveTextContent("总结");
});
