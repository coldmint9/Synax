import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeApi,
  type AgentSession,
} from "../../../../adapters/transport/agentRuntime";
import {
  forgetProjectSessionCache,
  resetWorkspaceSessionCache,
  useAgentSessionStore,
  type SessionDetailCacheEntry,
} from "../agentSessionStore";

vi.mock("../../../../adapters/transport/agentRuntime", () => ({
  agentRuntimeApi: {
    listSessions: vi.fn(async () => ({
      items: [],
      totalCount: 0,
      countByStatus: {},
    })),
    getSessionSummary: vi.fn(async () => ({ session: null })),
  },
}));

function row(
  id: string,
  projectId: string,
  overrides: Partial<AgentSession> = {},
): AgentSession {
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
    sessionMetadata: { mode: "chat" },
    ...overrides,
  } as AgentSession;
}

function page(items: AgentSession[], totalCount = items.length) {
  return { items, totalCount, countByStatus: {} };
}

function detailEntry(sessionId: string): SessionDetailCacheEntry {
  return {
    runs: [],
    steps: [],
    events: [],
    messages: [
      {
        id: `${sessionId}-m1`,
        sessionId,
        role: "user",
        content: "hello",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    toolCalls: [],
    permissions: [],
    sessionStats: null,
    sessionTodos: [],
    sessionInvocationUsage: null,
    cachedAt: Date.now(),
    lastVisitedAt: Date.now(),
  };
}

/** Load a workspace the way the layout does and wait for its first read. */
async function openWorkspace(projectId: string, items: AgentSession[]) {
  vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue(page(items));
  useAgentSessionStore.getState().setProjectId(projectId);
  await vi.waitFor(() =>
    expect(
      useAgentSessionStore.getState().sessions.map((session) => session.id),
    ).toEqual(items.map((session) => session.id)),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkspaceSessionCache();
  useAgentSessionStore.setState(useAgentSessionStore.getInitialState());
});

afterEach(() => {
  vi.restoreAllMocks();
  resetWorkspaceSessionCache();
});

describe("workspace session cache", () => {
  it("loads a workspace lazily on its first visit", async () => {
    await openWorkspace("alpha", [row("a1", "alpha")]);

    expect(agentRuntimeApi.listSessions).toHaveBeenCalledTimes(1);
    expect(agentRuntimeApi.listSessions).toHaveBeenCalledWith({
      projectId: "alpha",
      limit: 20,
    });
  });

  it("paints a remembered workspace without reading its list again", async () => {
    await openWorkspace("alpha", [row("a1", "alpha")]);
    await openWorkspace("beta", [row("b1", "beta")]);

    vi.mocked(agentRuntimeApi.listSessions).mockClear();

    useAgentSessionStore.getState().setProjectId("alpha");

    // The switch is synchronous: rows and cursor are already painted.
    expect(
      useAgentSessionStore.getState().sessions.map((session) => session.id),
    ).toEqual(["a1"]);
    expect(useAgentSessionStore.getState().sessionListTotal).toBe(1);
    expect(useAgentSessionStore.getState().sessionListLoading).toBe(false);
    expect(agentRuntimeApi.listSessions).not.toHaveBeenCalled();
  });

  it("never re-reads a remembered list, however long the workspace was idle", async () => {
    const base = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    await openWorkspace("alpha", [row("a1", "alpha")]);
    await openWorkspace("beta", [row("b1", "beta")]);

    vi.mocked(agentRuntimeApi.listSessions).mockClear();
    vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue(
      page([row("unexpected", "alpha")]),
    );
    // A day later the list is still the one this client painted: rows change
    // through live callbacks, not through a re-validating read.
    clock.mockReturnValue(base + 24 * 60 * 60 * 1000);

    useAgentSessionStore.getState().setProjectId("alpha");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      useAgentSessionStore.getState().sessions.map((session) => session.id),
    ).toEqual(["a1"]);
    expect(agentRuntimeApi.listSessions).not.toHaveBeenCalled();
    expect(useAgentSessionStore.getState().sessionListLoading).toBe(false);
  });

  it("retries the one initial read after it failed", async () => {
    vi.mocked(agentRuntimeApi.listSessions).mockRejectedValueOnce(
      new Error("offline"),
    );
    useAgentSessionStore.getState().setProjectId("alpha");
    await vi.waitFor(() =>
      expect(useAgentSessionStore.getState().sessionListError).toContain(
        "offline",
      ),
    );
    expect(useAgentSessionStore.getState().sessionListLoadedAt).toBe(0);

    // The workspace is already bound, so only a new mount/visit asks again.
    vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue(
      page([row("a1", "alpha")]),
    );
    await useAgentSessionStore.getState().ensureSessionsLoaded();
    expect(
      useAgentSessionStore.getState().sessions.map((session) => session.id),
    ).toEqual(["a1"]);
    expect(agentRuntimeApi.listSessions).toHaveBeenCalledTimes(2);
  });

  it("restores the transcript parked with the workspace", async () => {
    await openWorkspace("alpha", [row("a1", "alpha")]);
    useAgentSessionStore.setState({
      sessionDetailCache: { a1: detailEntry("a1") },
    });

    await openWorkspace("beta", [row("b1", "beta")]);
    expect(useAgentSessionStore.getState().sessionDetailCache).toEqual({});

    useAgentSessionStore.getState().setProjectId("alpha");
    const restored = useAgentSessionStore.getState().sessionDetailCache.a1;
    expect(restored?.messages.map((message) => message.id)).toEqual(["a1-m1"]);
  });

  it("drops a removed session from the workspace it belongs to", async () => {
    await openWorkspace("alpha", [row("a1", "alpha"), row("a2", "alpha")]);
    await openWorkspace("beta", [row("b1", "beta")]);

    useAgentSessionStore.getState().discardRemovedSessions(["a1"], "alpha");

    useAgentSessionStore.getState().setProjectId("alpha");
    expect(
      useAgentSessionStore.getState().sessions.map((session) => session.id),
    ).toEqual(["a2"]);
  });

  it("keeps a remembered row current when a live patch lands elsewhere", async () => {
    await openWorkspace("alpha", [row("p1", "alpha")]);
    await openWorkspace("beta", [row("q1", "beta")]);

    // The run finishes while the user is inside another workspace.
    useAgentSessionStore.getState().patchSession("p1", { status: "failed" });

    useAgentSessionStore.getState().setProjectId("alpha");
    expect(useAgentSessionStore.getState().sessions[0]?.status).toBe("failed");
  });

  it("paints a session a live callback names without re-reading the page", async () => {
    await openWorkspace("alpha", [row("c1", "alpha")]);
    vi.mocked(agentRuntimeApi.listSessions).mockClear();
    vi.mocked(agentRuntimeApi.getSessionSummary).mockResolvedValue({
      session: row("c2", "alpha", { updatedAt: "2026-02-01T00:00:00Z" }),
    } as never);

    await useAgentSessionStore.getState().syncSessionSummary("c2");

    expect(
      useAgentSessionStore.getState().sessions.map((session) => session.id),
    ).toEqual(["c2", "c1"]);
    expect(agentRuntimeApi.listSessions).not.toHaveBeenCalled();
  });

  it("updates the remembered row when the callback names another workspace", async () => {
    await openWorkspace("alpha", [row("d1", "alpha")]);
    await openWorkspace("beta", [row("d2", "beta")]);
    vi.mocked(agentRuntimeApi.getSessionSummary).mockResolvedValue({
      session: row("d1", "alpha", {
        status: "failed",
        updatedAt: "2026-03-01T00:00:00Z",
      }),
    } as never);

    await useAgentSessionStore.getState().syncSessionSummary("d1");

    // The workspace in view keeps its own rows.
    expect(
      useAgentSessionStore.getState().sessions.map((session) => session.id),
    ).toEqual(["d2"]);

    useAgentSessionStore.getState().setProjectId("alpha");
    expect(useAgentSessionStore.getState().sessions[0]?.status).toBe("failed");
  });

  it("does not let a late read overwrite a newer live row", async () => {
    await openWorkspace("alpha", [
      row("e1", "alpha", { updatedAt: "2026-05-01T00:00:00Z" }),
    ]);
    vi.mocked(agentRuntimeApi.getSessionSummary).mockResolvedValue({
      session: row("e1", "alpha", {
        status: "completed",
        updatedAt: "2026-04-01T00:00:00Z",
      }),
    } as never);

    await useAgentSessionStore.getState().syncSessionSummary("e1");

    expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({
      status: "completed",
      updatedAt: "2026-05-01T00:00:00Z",
    });
  });

  it("forgets a removed workspace instead of resurrecting its rows", async () => {
    await openWorkspace("alpha", [row("r1", "alpha")]);
    forgetProjectSessionCache("alpha");
    await openWorkspace("beta", [row("b1", "beta")]);

    vi.mocked(agentRuntimeApi.listSessions).mockClear();
    vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue(
      page([row("a9", "alpha")]),
    );
    useAgentSessionStore.getState().setProjectId("alpha");

    expect(useAgentSessionStore.getState().sessions).toEqual([]);
    await vi.waitFor(() =>
      expect(agentRuntimeApi.listSessions).toHaveBeenCalledWith({
        projectId: "alpha",
        limit: 20,
      }),
    );
  });
});
