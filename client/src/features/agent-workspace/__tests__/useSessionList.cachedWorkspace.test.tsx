import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import type { AgentSession } from "../../../adapters/transport/agentRuntime";
import {
  resetWorkspaceSessionCache,
  useAgentSessionStore,
} from "../state/agentSessionStore";
import { rememberSessionList } from "../state/sessionListCache";
import { useSessionList } from "../useSessionList";

function row(id: string, projectId: string): AgentSession {
  return {
    id,
    projectId,
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: "synax",
    status: "completed",
    title: id,
    prompt: id,
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
    sessionMetadata: { mode: "chat", source: "session-page" },
  } as AgentSession;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>{children}</MemoryRouter>
);

function listedIds(result: { current: ReturnType<typeof useSessionList> }) {
  return result.current.groups.flatMap((group) =>
    group.sessions.map((node) => node.session.id),
  );
}

describe("useSessionList across workspaces", () => {
  beforeEach(() => {
    resetWorkspaceSessionCache();
    useAgentSessionStore.setState(useAgentSessionStore.getInitialState());
  });

  afterEach(() => {
    resetWorkspaceSessionCache();
    // Reset while the hook is still mounted so the harness is not updated
    // outside act() after the test.
    act(() => {
      useAgentSessionStore.setState(useAgentSessionStore.getInitialState());
    });
  });

  it("paints the route workspace's remembered rows before the store binds it", () => {
    // The layout still points the store at the workspace we just left.
    useAgentSessionStore.setState({
      projectId: "alpha",
      sessions: [row("a1", "alpha")],
      sessionListTotal: 1,
      sessionListOffset: 1,
      sessionListLoadedAt: Date.now(),
    });
    rememberSessionList("beta", {
      sessions: [row("b1", "beta")],
      total: 1,
      offset: 1,
      loadedAt: Date.now(),
    });

    const { result } = renderHook(
      () => useSessionList("zh", "sessions", "beta"),
      { wrapper },
    );

    expect(result.current.isProjectReady).toBe(false);
    expect(listedIds(result)).toEqual(["b1"]);
    // A painted snapshot is not a load: no skeleton, no stale error banner.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("keeps the loading state for a workspace with no snapshot yet", () => {
    useAgentSessionStore.setState({
      projectId: "alpha",
      sessions: [row("a1", "alpha")],
    });

    const { result } = renderHook(
      () => useSessionList("zh", "sessions", "beta"),
      { wrapper },
    );

    expect(listedIds(result)).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });
});
