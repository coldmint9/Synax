import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  agentRuntimeApi,
  type AgentRun,
} from "../../../../lib/api/agentRuntime";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { usePendingSubmissionStore } from "../state/pendingSubmissionStore";
import { SessionTranscript } from "../SessionTranscript";

vi.mock("../../../../lib/api/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
vi.mock("../SessionNavigationPanel", () => ({
  SessionNavigationPanel: () => null,
}));
vi.mock("../useTranscriptScroll", () => ({
  useTranscriptScroll: vi.fn(() => ({ scrollToBottom: vi.fn() })),
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
beforeEach(() => {
  vi.restoreAllMocks();
  usePendingSubmissionStore.setState({ items: {} });
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    selectedSessionId: "s1",
    detailLoading: true,
    refreshSessions: vi.fn(async () => {}),
    refreshDetail: vi.fn(async () => {}),
  });
});

it("renders a sent message and the thinking grid before the request completes, without waiting for history", async () => {
  let finish!: (result: { run: AgentRun; reused: boolean }) => void;
  vi.spyOn(agentRuntimeApi, "submitRun").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { container } = render(<SessionTranscript />);
  let sending!: Promise<void>;
  act(() => {
    sending = useAgentSessionStore
      .getState()
      .sendSessionMessage("s1", { message: "Immediate message" });
  });
  expect(screen.getByText("Immediate message")).toBeVisible();
  expect(container.querySelectorAll(".loading-state-cell")).toHaveLength(9);
  await act(async () => {
    finish({ run, reused: false });
    await sending;
  });
  expect(screen.getByText("Immediate message")).toBeVisible();
  expect(container.querySelectorAll(".loading-state-cell")).toHaveLength(9);
});

it("shows one real message when it arrives before the run-start linkage and HTTP response", async () => {
  let finish!: (result: { run: AgentRun; reused: boolean }) => void;
  vi.spyOn(agentRuntimeApi, "submitRun").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<SessionTranscript />);
  let sending!: Promise<void>;
  act(() => {
    sending = useAgentSessionStore.getState().sendSessionMessage("s1", { message: "我上一轮说了啥" });
  });
  const pending = usePendingSubmissionStore.getState().items.s1;
  act(() => useAgentSessionStore.setState({
    detailLoading: false,
    messages: [{ ...pending.message, id: "persisted", runId: null, metadata: { requestId: pending.requestId } }],
    runs: [],
  }));
  expect(screen.getAllByText("我上一轮说了啥")).toHaveLength(1);
  expect(screen.getByRole("status")).toHaveTextContent("正在思考");
  await act(async () => {
    finish({ run, reused: false });
    await sending;
  });
  expect(screen.getAllByText("我上一轮说了啥")).toHaveLength(1);
});

it("deduplicates an SSE confirmation arriving before the POST response and keeps identical earlier messages", async () => {
  let finish!: (result: { run: AgentRun; reused: boolean }) => void;
  vi.spyOn(agentRuntimeApi, "submitRun").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<SessionTranscript />);
  let sending!: Promise<void>;
  act(() => {
    sending = useAgentSessionStore
      .getState()
      .sendSessionMessage("s1", { message: "Same message" });
  });
  const pending = usePendingSubmissionStore.getState().items.s1;
  act(() =>
    useAgentSessionStore.setState({
      detailLoading: false,
      runs: [
        {
          ...run,
          status: "completed",
          triggerMessageId: "server-message",
          metadata: { runtime: { requestId: pending.requestId } },
        },
      ],
      messages: [
        { ...pending.message, id: "older-message", runId: "previous-run" },
        { ...pending.message, id: "server-message" },
      ],
    }),
  );
  await waitFor(() =>
    expect(usePendingSubmissionStore.getState().items.s1).toBeUndefined(),
  );
  expect(screen.getAllByText("Same message")).toHaveLength(2);
  await act(async () => {
    finish({ run, reused: false });
    await sending;
  });
  expect(screen.getAllByText("Same message")).toHaveLength(2);
});

it("rolls back only the failed session's temporary message after switching sessions", async () => {
  let reject!: (error: Error) => void;
  vi.spyOn(agentRuntimeApi, "submitRun").mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  render(<SessionTranscript />);
  let sending!: Promise<void>;
  act(() => {
    sending = useAgentSessionStore
      .getState()
      .sendSessionMessage("s1", { message: "Old session input" });
  });
  const failure = sending.catch((error) => error);
  act(() =>
    useAgentSessionStore.setState({
      selectedSessionId: "s2",
      detailLoading: false,
    }),
  );
  expect(screen.queryByText("Old session input")).not.toBeInTheDocument();
  await act(async () => {
    reject(new Error("Send failed"));
    await failure;
  });
  expect(usePendingSubmissionStore.getState().items.s1).toBeUndefined();
  expect(useAgentSessionStore.getState().selectedSessionId).toBe("s2");
});

it("keeps the scrollport keyboard-accessible without rendering focus hints", () => {
  const { container } = render(<SessionTranscript />);
  const scroll = screen.getByLabelText("对话记录");
  expect(scroll).toHaveAttribute("tabindex", "0");
  expect(container.querySelector(".session-transcript-focus-hint")).toBeNull();
  expect(
    screen.queryByText(/键盘滚动|Keyboard scrolling/),
  ).not.toBeInTheDocument();
});
