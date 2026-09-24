import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../../lib/api/agentRuntime";
import { useTranscriptSession } from "../SessionTranscriptContext";
import { AgentConversationView } from "../AgentConversationView";
import { useAgentSessionStore as store } from "../state/agentSessionStore";

vi.mock("@heroui/react", () => ({
  Card: ({ children }: { children: unknown }) => <div>{children}</div>,
  Chip: ({ children }: { children: unknown }) => <span>{children}</span>,
}));

vi.mock("../SessionHistoryContext", () => ({
  SessionHistoryProvider: ({ children }: { children: unknown }) => (
    <>{children}</>
  ),
}));

vi.mock("../SessionStaticTimeline", () => ({
  SessionStaticTimeline: () => {
    const { sessionId } = useTranscriptSession();
    return <output data-testid="transcript-session">{sessionId}</output>;
  },
}));

const session = {
  id: "session-inline-visualization",
  projectId: "project-1",
  parentSessionId: null,
  childSessionIds: [],
  status: "completed",
  profileId: "synax",
  title: "Artifact preview",
  prompt: "Create a prototype",
} as AgentSession;

afterEach(() => {
  act(() => store.setState(store.getInitialState()));
});

describe("AgentConversationView transcript scope", () => {
  it("does not expose the paged reader for truncated historical messages", () => {
    const messages = [{
      id: "long-message", sessionId: session.id, runId: null, stepId: null,
      role: "user" as const, content: "Truncated preview", metadata: {},
      createdAt: "2026-09-24T00:00:00Z",
      historyProjection: { omittedFields: ["content"] },
    }];
    store.setState({
      sessionDetailCache: {
        [session.id]: {
          messages, runs: [], steps: [], toolCalls: [], events: [], permissions: [],
          sessionStats: null, sessionTodos: [], sessionInvocationUsage: null,
          cachedAt: Date.now(),
          historyWindow: {
            revision: 1, epoch: 1, hasEarlier: false,
            latest: true, detailsTruncated: false,
          },
        },
      },
    });
    render(
      <AgentConversationView
        session={session} steps={[]} toolCalls={[]} messages={messages}
      />,
    );

    expect(screen.queryByText(/长消息全文|Long message \(paged/)).toBeNull();
    expect(screen.queryByText(/读取首段|First chunk/)).toBeNull();
  });

  it("does not render the history window controls", () => {
    render(
      <AgentConversationView
        session={session}
        steps={[]}
        toolCalls={[]}
        messages={[]}
      />,
    );

    expect(screen.queryByText("Bounded history window")).toBeNull();
    expect(screen.queryByRole("button", { name: "Older" })).toBeNull();
  });

  it("provides its session id to transcript-rendered inline visualizations", () => {
    render(
      <AgentConversationView
        session={session}
        steps={[]}
        toolCalls={[]}
        messages={[]}
      />,
    );

    expect(screen.getByTestId("transcript-session")).toHaveTextContent(
      session.id,
    );
  });
});
