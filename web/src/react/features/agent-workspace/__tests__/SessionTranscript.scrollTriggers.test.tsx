import { act, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentRun, AgentRuntimeMessage } from "../../../../lib/api/agentRuntime";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { usePendingSubmissionStore } from "../state/pendingSubmissionStore";
import { SessionTranscript } from "../SessionTranscript";

const { scrollToBottom } = vi.hoisted(() => ({ scrollToBottom: vi.fn() }));

vi.mock("../useTranscriptScroll", () => ({
  useTranscriptScroll: vi.fn(() => ({ scrollToBottom })),
}));
vi.mock("../../../../lib/api/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
vi.mock("../SessionNavigationPanel", () => ({
  SessionNavigationPanel: () => null,
}));
vi.mock("../AgentConversationView", () => ({
  AgentConversationView: ({ messages, liveTurn }: any) => (
    <>
      {messages.map((message: any) => (
        <p key={message.id}>{message.content}</p>
      ))}
      {liveTurn}
    </>
  ),
}));

const run: AgentRun = {
  id: "run-1",
  sessionId: "s1",
  status: "queued",
  startedAt: "",
  completedAt: null,
  triggerMessageId: null,
  currentStep: 0,
  stopReason: null,
  model: null,
  metadata: {},
};

function beginPending(requestId: string) {
  const message: AgentRuntimeMessage = {
    id: `pending-${requestId}`,
    sessionId: "s1",
    runId: null,
    stepId: null,
    role: "user",
    content: `Message ${requestId}`,
    metadata: {},
    createdAt: "",
  };
  act(() => {
    usePendingSubmissionStore
      .getState()
      .begin("s1", { requestId, message });
  });
}

beforeEach(() => {
  scrollToBottom.mockClear();
  usePendingSubmissionStore.setState({ items: {} });
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    selectedSessionId: "s1",
    detailLoading: false,
    refreshSessions: vi.fn(async () => {}),
    refreshDetail: vi.fn(async () => {}),
  });
});

it("scrolls to the bottom when a message is sent", () => {
  render(<SessionTranscript />);
  expect(scrollToBottom).not.toHaveBeenCalled();
  beginPending("req-1");
  expect(scrollToBottom).toHaveBeenCalledWith(true);
});

it("scrolls to the bottom on the AI's first response only", () => {
  render(<SessionTranscript />);
  beginPending("req-1");
  scrollToBottom.mockClear();
  act(() => useAgentSessionStore.setState({ streamingStepId: "step-1" }));
  expect(scrollToBottom).toHaveBeenCalledTimes(1);
  expect(scrollToBottom).toHaveBeenCalledWith(true);
  act(() => useAgentSessionStore.setState({ streamingStepId: "step-2" }));
  expect(scrollToBottom).toHaveBeenCalledTimes(1);
  act(() => useAgentSessionStore.setState({ streamingStepId: null }));
  act(() => useAgentSessionStore.setState({ streamingStepId: "step-3" }));
  expect(scrollToBottom).toHaveBeenCalledTimes(2);
});

it("scrolls to the bottom when the run finishes", () => {
  render(<SessionTranscript />);
  act(() =>
    useAgentSessionStore.setState({ runs: [{ ...run, status: "running" }] }),
  );
  expect(scrollToBottom).not.toHaveBeenCalled();
  act(() =>
    useAgentSessionStore.setState({ runs: [{ ...run, status: "completed" }] }),
  );
  expect(scrollToBottom).toHaveBeenCalledWith(true);
});

it("does not scroll on mount into a session whose run already finished", () => {
  useAgentSessionStore.setState({
    runs: [{ ...run, status: "completed" }],
  });
  render(<SessionTranscript />);
  expect(scrollToBottom).not.toHaveBeenCalled();
});
