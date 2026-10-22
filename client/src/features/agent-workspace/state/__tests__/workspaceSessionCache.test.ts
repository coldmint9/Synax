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
import { SESSION_LIST_FRESH_MS } from "../sessionListCache";

vi.mock("../../../../adapters/transport/agentRuntime", () => ({
  agentRuntimeApi: {
    listSessions: vi.fn(async () => ({
      items: [],
      totalCount: 0,
      countByStatus: {},
    })),
  },
}));

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
    sessionMetadata: { mode: "chat" },
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
    const loadedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(loadedAt + SESSION_LIST_FRESH_MS / 2);

    useAgentSessionStore.getState().setProjectId("alpha");

    // The switch is synchronous: rows and cursor are already painted.
    expect(
      useAgentSessionStore.getState().sessions.map((session) => session.id),
    ).toEqual(["a1"]);
    expect(useAgentSessionStore.getState().sessionListTotal).toBe(1);
    expect(useAgentSessionStore.getState().sessionListLoading).toBe(false);
    expect(agentRuntimeApi.listSessions).not.toHaveBeenCalled();
  });

  it("reconciles a stale snapshot in the background without a loading list", async () => {
    const base = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(base);
    await openWorkspace("alpha", [row("a1", "alpha")]);
    await openWorkspace("beta", [row("b1", "beta")]);

    vi.mocked(agentRuntimeApi.listSessions).mockClear();
    vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue(
      page([row("a2", "alpha"), row("a1", "alpha")]),
    );
    clock.mockReturnValue(base + SESSION_LIST_FRESH_MS + 1);

    useAgentSessionStore.getState().setProjectId("alpha");
    expect(
      useAgentSessionStore.getState().sessions.map((session) => session.id),
    ).toEqual(["a1"]);

    await vi.waitFor(() =>
      expect(
        useAgentSessionStore.getState().sessions.map((session) => session.id),
      ).toEqual(["a2", "a1"]),
    );
    expect(useAgentSessionStore.getState().sessionListLoading).toBe(false);
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
