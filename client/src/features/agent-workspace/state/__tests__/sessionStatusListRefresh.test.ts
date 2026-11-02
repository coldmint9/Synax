import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeApi,
  type AgentSession,
} from "../../../../adapters/transport/agentRuntime";
import {
  clearScheduledSessionRefresh,
  resetWorkspaceSessionCache,
  useAgentSessionStore,
} from "../agentSessionStore";

vi.mock("../../../../adapters/transport/agentRuntime", () => ({
  agentRuntimeApi: {
    listSessions: vi.fn(async () => ({
      items: [],
      totalCount: 0,
      countByStatus: {},
    })),
    getSessionSummary: vi.fn(async () => ({ session: null })),
    getSessionStats: vi.fn(async () => null),
    getSessionTodos: vi.fn(async () => ({ items: [] })),
    getSessionInvocationUsage: vi.fn(async () => null),
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
    status: "running",
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
    activeRunId: "run-1",
    pendingResumeToken: null,
    sessionMetadata: { mode: "chat" },
    ...overrides,
  } as AgentSession;
}

function page(items: AgentSession[]) {
  return { items, totalCount: items.length, countByStatus: {} };
}

/** Open a workspace the way the layout does and let its first read land. */
async function openWorkspace(projectId: string, items: AgentSession[]) {
  vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue(page(items));
  useAgentSessionStore.getState().setProjectId(projectId);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    useAgentSessionStore.getState().sessions.map((session) => session.id),
  ).toEqual(items.map((session) => session.id));
}

/** Wait past the trailing list refresh the store schedules on a settle. */
async function settleListRefresh() {
  await vi.advanceTimersByTimeAsync(1_300);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearScheduledSessionRefresh();
  resetWorkspaceSessionCache();
  useAgentSessionStore.setState(useAgentSessionStore.getInitialState());
});

afterEach(() => {
  clearScheduledSessionRefresh();
  resetWorkspaceSessionCache();
  vi.useRealTimers();
});

describe("session status transitions refresh the list once", () => {
  it("reads the page once when a live patch settles the session", async () => {
    await openWorkspace("alpha", [row("s1", "alpha")]);
    vi.mocked(agentRuntimeApi.listSessions).mockClear();
    vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue(
      page([row("s1", "alpha", { status: "completed", activeRunId: null })]),
    );

    useAgentSessionStore
      .getState()
      .patchSession("s1", { status: "completed", activeRunId: null });

    // The row is patched immediately; the page is re-read on the trailing edge.
    expect(useAgentSessionStore.getState().sessions[0].status).toBe("completed");
    expect(agentRuntimeApi.listSessions).not.toHaveBeenCalled();

    await settleListRefresh();

    expect(agentRuntimeApi.listSessions).toHaveBeenCalledTimes(1);
    expect(agentRuntimeApi.listSessions).toHaveBeenCalledWith({
      projectId: "alpha",
      limit: 20,
    });
  });

  it("does not read the page again for a repeated terminal patch", async () => {
    await openWorkspace("alpha", [row("s1", "alpha")]);
    useAgentSessionStore.getState().patchSession("s1", { status: "failed" });
    await settleListRefresh();
    // The page mock still reports `running`: a same-timestamp read taken
    // before the write landed must not resurrect the settled row.
    expect(useAgentSessionStore.getState().sessions[0].status).toBe("failed");
    vi.mocked(agentRuntimeApi.listSessions).mockClear();

    // Streaming sub-systems repaint the same settled row (tokens, summary).
    useAgentSessionStore.getState().patchSession("s1", { status: "failed" });
    useAgentSessionStore
      .getState()
      .patchSession("s1", { resultSummary: "done" });
    await settleListRefresh();

    expect(agentRuntimeApi.listSessions).not.toHaveBeenCalled();
  });

  it("keeps running-state transitions on the row patch", async () => {
    await openWorkspace("alpha", [row("s1", "alpha", { status: "queued" })]);
    vi.mocked(agentRuntimeApi.listSessions).mockClear();

    useAgentSessionStore
      .getState()
      .patchSession("s1", { status: "waiting_permission" });
    await settleListRefresh();

    expect(useAgentSessionStore.getState().sessions[0].status).toBe(
      "waiting_permission",
    );
    expect(agentRuntimeApi.listSessions).not.toHaveBeenCalled();
  });

  it("reads the page once when a reconnect snapshot reports the settle", async () => {
    await openWorkspace("alpha", [row("s1", "alpha")]);
    useAgentSessionStore.setState({ selectedSessionId: "s1", panelOpen: true });
    vi.mocked(agentRuntimeApi.listSessions).mockClear();
    vi.mocked(agentRuntimeApi.listSessions).mockResolvedValue(
      page([row("s1", "alpha", { status: "completed", activeRunId: null })]),
    );

    useAgentSessionStore.getState().applyLiveEvent(
      {
        type: "runtime_snapshot",
        sessionId: "s1",
        session: row("s1", "alpha", {
          status: "completed",
          activeRunId: null,
        }),
        run: null,
        cursor: 0,
        liveChunks: [],
        completedStepIds: [],
      },
      "s1",
    );

    await settleListRefresh();

    expect(agentRuntimeApi.listSessions).toHaveBeenCalledTimes(1);
    expect(useAgentSessionStore.getState().sessions[0].status).toBe("completed");
  });

  it("leaves a remembered session of another workspace to its own visit", async () => {
    await openWorkspace("alpha", [row("s1", "alpha")]);
    useAgentSessionStore.setState((state) => ({
      sessions: [...state.sessions, row("b1", "beta")],
    }));
    vi.mocked(agentRuntimeApi.listSessions).mockClear();

    useAgentSessionStore.getState().patchSession("b1", { status: "completed" });
    await settleListRefresh();

    expect(agentRuntimeApi.listSessions).not.toHaveBeenCalled();
  });
});
