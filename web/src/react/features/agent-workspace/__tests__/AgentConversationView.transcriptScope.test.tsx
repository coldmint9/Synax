import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../../lib/api/agentRuntime";
import { useTranscriptSession } from "../SessionTranscriptContext";
import { AgentConversationView } from "../AgentConversationView";

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

describe("AgentConversationView transcript scope", () => {
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
