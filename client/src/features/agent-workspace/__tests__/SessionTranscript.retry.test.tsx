import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentRun, AgentRunStep, AgentSession } from "../../../adapters/transport/agentRuntime";
import type { LlmRetryState } from "../../../adapters/transport/sessionLive";
import { SessionTranscript } from "../SessionTranscript";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { usePendingSubmissionStore } from "../state/pendingSubmissionStore";
import { useShellStore } from "../../../shared/state/shellStore";

vi.mock("../SessionNavigationPanel", () => ({ SessionNavigationPanel: () => null }));
vi.mock("../useTranscriptScroll", () => ({ useTranscriptScroll: () => ({ scrollToBottom: vi.fn() }) }));
vi.mock("../useTranscriptReveal", () => ({ useTranscriptReveal: () => true }));
vi.mock("../AgentConversationView", () => ({
  AgentConversationView: ({ liveTurn }: { liveTurn?: ReactNode }) => <div data-testid="conversation-stream">{liveTurn}</div>,
}));

const session = { id: "s", status: "running", activeRunId: "run" } as AgentSession;
const run = { id: "run", sessionId: "s", status: "running", metadata: {} } as AgentRun;
const step = { id: "step", runId: "run", sessionId: "s", index: 1, status: "running" } as AgentRunStep;
const retry: LlmRetryState = { reason: "upstream", phase: "waiting", group: 1, attempt: 1, maxRetries: 10, nextRetryAt: null, error: "HTTP 503" };
const emit = (state: LlmRetryState, stepId = step.id, sessionId = session.id) => store.getState().applyLiveEvent({ type: "retry_status", stepId, retry: state }, sessionId);

beforeEach(() => {
  vi.useFakeTimers();
  useShellStore.setState(state => ({ preferences: { ...state.preferences, locale: "zh" } }));
  usePendingSubmissionStore.setState({ items: {} });
  store.setState({ ...store.getInitialState(), selectedSessionId: session.id, sessions: [session], runs: [run], steps: [step],
    detailLoading: false, detailRefreshing: false, streamingStepId: step.id,
    refreshSessions: vi.fn(async () => {}), refreshDetail: vi.fn(async () => {}) });
});
afterEach(() => {
  act(() => store.getState().applyLiveEvent({ type: "runtime_state", sessionId: session.id, patch: {}, reset: true, refresh: false }));
  store.setState(store.getInitialState());
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("shows waiting/retrying in the conversation and removes the notice before the run ends", () => {
  render(<SessionTranscript />);
  act(() => emit({ ...retry, nextRetryAt: Date.now() + 2000 }));
  expect(screen.getByTestId("conversation-stream")).toContainElement(screen.getByTestId("retry-indicator"));
  expect(screen.getByText("第 1/10 次重试 · 2 秒后重试")).toBeVisible();
  expect(screen.queryByTestId("thinking-indicator")).not.toBeInTheDocument();
  act(() => emit({ ...retry, phase: "retrying" }));
  expect(screen.getByText("第 1/10 次重试 · 正在重试…")).toBeVisible();
  act(() => emit({ ...retry, phase: "recovered" }));
  expect(screen.queryByTestId("retry-indicator")).not.toBeInTheDocument();
  expect(store.getState().sessions[0].status).toBe("running");
  expect(screen.getByTestId("thinking-indicator")).toBeVisible();
});

it("restores a waiting notice from a reconnect snapshot and clears it on recovered replay", () => {
  render(<SessionTranscript />);
  const waiting = { ...retry, reason: "rate_limit" as const, nextRetryAt: Date.now() + 4000 };
  const liveChunks = [{ type: "step_started", step }, { type: "retry_status", stepId: step.id, retry: waiting }] as const;
  const snapshot = { type: "runtime_snapshot" as const, sessionId: session.id, session, run, cursor: 2, completedStepIds: [], liveChunks: [...liveChunks] };
  act(() => store.getState().applyLiveEvent(snapshot, session.id));
  expect(screen.getByRole("status")).toHaveTextContent("上游请求限流");
  act(() => store.getState().applyLiveEvent({ ...snapshot, cursor: 3,
    liveChunks: [...liveChunks, { type: "retry_status", stepId: step.id, retry: { ...waiting, phase: "recovered" } }] }, session.id));
  expect(screen.queryByTestId("retry-indicator")).not.toBeInTheDocument();
});

it("ignores retry events from another session or step and clears on cancellation", () => {
  render(<SessionTranscript />);
  act(() => { emit(retry, "old-step"); emit(retry, step.id, "other-session"); });
  expect(screen.queryByTestId("retry-indicator")).not.toBeInTheDocument();
  act(() => emit(retry));
  expect(screen.getByTestId("retry-indicator")).toBeVisible();
  act(() => store.getState().applyLiveEvent({ type: "runtime_state", sessionId: session.id, patch: { status: "cancelled" }, reset: true, refresh: false }));
  expect(screen.queryByTestId("retry-indicator")).not.toBeInTheDocument();
});
