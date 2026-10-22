import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InterleavedTurn } from "../buildInterleavedTurns";
import type { ConversationGitReference } from "../gitMergeTranscript";
import { TurnContent } from "../TurnBody";
import { TranscriptSessionProvider } from "../SessionTranscriptContext";
import { useAgentSessionStore as store } from "../state/agentSessionStore";

vi.mock("../SessionEnvironmentContext", () => ({
  useSessionWorkspaceEnvironment: () => ({ sessionId: "parent-session", environment: null }),
}));
vi.mock("../git-merge/ConversationGitCard", () => ({
  default: ({ reference, readOnly }: { reference: ConversationGitReference; readOnly?: boolean }) => (
    <details data-testid="git-card" data-owner={reference.sessionId} data-readonly={String(readOnly)}>
      <summary>{reference.title}</summary>
      <span>{reference.objectId}</span>
    </details>
  ),
}));

const reference: ConversationGitReference = {
  schema: "synax.git-merge", schemaVersion: 1, objectId: "git-task", sessionId: "child-session",
  projectId: "project", title: "审核合并结果",
};
const blocks = (value = reference): InterleavedTurn["blocks"] => [{
  type: "git_merge", reference: value, messageId: "stable-message",
}];

beforeEach(() => store.setState(store.getInitialState()));
afterEach(() => act(() => store.setState(store.getInitialState())));

it("keeps a live native card in the reading lane and preserves its DOM identity on an anchor update", async () => {
  const view = (title: string, isStreaming: boolean) => (
    <TranscriptSessionProvider sessionId={reference.sessionId}>
      <TurnContent blocks={blocks({ ...reference, title })} isStreaming={isStreaming} />
    </TranscriptSessionProvider>
  );
  const { container, rerender } = render(view("正在检查合并方案", true));
  const card = await screen.findByTestId("git-card");
  expect(card.closest(".session-answer-region")).not.toBeNull();
  expect(container.querySelector(".session-activity-group")).toBeNull();
  (card as HTMLDetailsElement).open = true;
  rerender(view("检查完成，等待确认", false));
  expect(await screen.findByTestId("git-card")).toBe(card);
  expect(card).toHaveTextContent("检查完成，等待确认");
  expect((card as HTMLDetailsElement).open).toBe(true);
});

it("uses the child task's history window rather than the selected parent session", async () => {
  store.setState({
    selectedSessionId: "parent-session",
    sessionDetailCache: {
      [reference.sessionId]: {
        messages: [], runs: [], steps: [], toolCalls: [], events: [], permissions: [],
        sessionStats: null, sessionTodos: [], sessionInvocationUsage: null, cachedAt: 1,
        historyWindow: { revision: 1, epoch: 1, hasEarlier: true, latest: false, detailsTruncated: false },
      },
    },
  });
  render(<TranscriptSessionProvider sessionId={reference.sessionId}><TurnContent blocks={blocks()} /></TranscriptSessionProvider>);
  const card = await screen.findByTestId("git-card");
  expect(card).toHaveAttribute("data-owner", reference.sessionId);
  expect(card).toHaveAttribute("data-readonly", "true");
  act(() => store.setState({ sessionDetailCache: {} }));
  expect(card).toHaveAttribute("data-readonly", "false");
});

it("does not render an actionable card in a different owner's transcript", () => {
  render(<TranscriptSessionProvider sessionId="parent-session"><TurnContent blocks={blocks()} /></TranscriptSessionProvider>);
  expect(screen.queryByTestId("git-card")).toBeNull();
});

it("keeps an unscoped standalone render read-only", async () => {
  render(<TranscriptSessionProvider sessionId={null}><TurnContent blocks={blocks()} /></TranscriptSessionProvider>);
  expect(await screen.findByTestId("git-card")).toHaveAttribute("data-readonly", "true");
});
