import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import type { AgentSession } from "../../../../lib/api/agentRuntime";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useSessionList } from "../useSessionList";

function makeSession(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: "s1",
    projectId: "p1",
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: "goal",
    status: "completed",
    title: null,
    prompt: "test",
    contextSnapshotId: null,
    thinkingMode: "standard",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: null,
    ...overrides,
  };
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>{children}</MemoryRouter>
);

describe("useSessionList", () => {
  beforeEach(() => {
    useAgentSessionStore.setState({ projectId: "p1", sessions: [] });
  });

  it("lists root sessions only and keeps the group count aligned", () => {
    const parent = makeSession({
      id: "parent",
      profileId: "goal",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    const child = makeSession({
      id: "child",
      parentSessionId: "parent",
      profileId: "explorer",
      sessionMetadata: { mode: "plan" },
      updatedAt: "2026-01-03T00:00:00Z",
    });
    const older = makeSession({
      id: "older",
      profileId: "goal",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    useAgentSessionStore.setState({
      projectId: "p1",
      sessions: [older, parent, child],
    });

    const { result } = renderHook(
      () => useSessionList("zh", "sessions", "p1"),
      { wrapper },
    );

    const group = result.current.groups[0];
    expect(group.sessions.map((node) => node.session.id)).toEqual([
      "parent",
      "older",
    ]);
    expect(group.sessions).toHaveLength(group.count);
    expect(result.current.viewCounts.sessions).toBe(2);
  });
});
