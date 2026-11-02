import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeApi, type AgentSession } from "../../../adapters/transport/agentRuntime";
import {
  clearScheduledSessionRefresh,
  resetWorkspaceSessionCache,
  useAgentSessionStore,
} from "../state/agentSessionStore";
import { resetSessionListCache } from "../state/sessionListCache";
import {
  reconcileUnsettledSessionRows,
  resetSessionStatusReconcile,
} from "../sessionStatusReconcile";

vi.mock("../../../adapters/transport/agentRuntime", () => ({
  agentRuntimeApi: {
    listSessions: vi.fn(async () => ({ items: [], totalCount: 0, countByStatus: {} })),
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
    status: "running",
    title: id,
    prompt: id,
    contextSnapshotId: null,
    thinkingMode: "standard",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
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

function bind(sessions: AgentSession[], projectId = "alpha") {
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId,
    sessions,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearScheduledSessionRefresh();
  resetWorkspaceSessionCache();
  resetSessionListCache();
  resetSessionStatusReconcile();
  useAgentSessionStore.setState(useAgentSessionStore.getInitialState());
});

afterEach(() => {
  clearScheduledSessionRefresh();
  resetWorkspaceSessionCache();
  resetSessionListCache();
  resetSessionStatusReconcile();
  vi.useRealTimers();
});

describe("unsettled session rows reconcile", () => {
  it("re-reads a row that still animates and settles it with the durable status", async () => {
    bind([row("stale", "alpha"), row("done", "alpha", { status: "completed", activeRunId: null })]);
    vi.mocked(agentRuntimeApi.getSessionSummary).mockResolvedValue({
      session: row("stale", "alpha", {
        status: "completed",
        activeRunId: null,
        updatedAt: "2026-01-03T00:00:00Z",
      }),
    } as never);

    reconcileUnsettledSessionRows();
    await vi.advanceTimersByTimeAsync(0);

    expect(agentRuntimeApi.getSessionSummary).toHaveBeenCalledTimes(1);
    expect(agentRuntimeApi.getSessionSummary).toHaveBeenCalledWith("stale");
    expect(
      useAgentSessionStore.getState().sessions.find((s) => s.id === "stale")?.status,
    ).toBe("completed");
  });

  it("leaves settled rows and other workspaces alone", async () => {
    bind([
      row("done", "alpha", { status: "completed", activeRunId: null }),
      row("failed", "alpha", { status: "failed", activeRunId: null }),
      row("elsewhere", "beta"),
    ]);

    reconcileUnsettledSessionRows();
    await vi.advanceTimersByTimeAsync(0);

    expect(agentRuntimeApi.getSessionSummary).not.toHaveBeenCalled();
  });

  it("coalesces the reconnect and visibility reports of one gap into a single read", async () => {
    bind([row("stale", "alpha")]);
    vi.mocked(agentRuntimeApi.getSessionSummary).mockResolvedValue({
      session: row("stale", "alpha"),
    } as never);

    reconcileUnsettledSessionRows();
    reconcileUnsettledSessionRows();
    await vi.advanceTimersByTimeAsync(0);
    reconcileUnsettledSessionRows();
    await vi.advanceTimersByTimeAsync(0);

    expect(agentRuntimeApi.getSessionSummary).toHaveBeenCalledTimes(1);

    // A later gap is a new report, not a repeat of the same one.
    await vi.advanceTimersByTimeAsync(2_100);
    reconcileUnsettledSessionRows();
    await vi.advanceTimersByTimeAsync(0);

    expect(agentRuntimeApi.getSessionSummary).toHaveBeenCalledTimes(2);
  });


  it("reads a long backlog a page at a time instead of starving its tail", async () => {
    bind(Array.from({ length: 10 }, (_, index) => row(`s${index}`, "alpha")));
    vi.mocked(agentRuntimeApi.getSessionSummary).mockImplementation(
      async (sessionId: string) => ({ session: row(sessionId, "alpha") }) as never,
    );

    reconcileUnsettledSessionRows();
    await vi.advanceTimersByTimeAsync(0);
    expect(agentRuntimeApi.getSessionSummary).toHaveBeenCalledTimes(8);

    await vi.advanceTimersByTimeAsync(2_100);
    reconcileUnsettledSessionRows();
    await vi.advanceTimersByTimeAsync(0);
    const readIds = vi
      .mocked(agentRuntimeApi.getSessionSummary)
      .mock.calls.map(([sessionId]) => sessionId);
    // The rows the first pass could not fit are read next, not skipped again.
    expect(readIds.slice(8, 10)).toEqual(["s8", "s9"]);
    expect(new Set(readIds).size).toBe(10);
  });

  it("stays quiet while no workspace is bound", async () => {
    useAgentSessionStore.setState({
      ...useAgentSessionStore.getInitialState(),
      projectId: null,
      sessions: [row("stale", "alpha")],
    });

    reconcileUnsettledSessionRows();
    await vi.advanceTimersByTimeAsync(0);

    expect(agentRuntimeApi.getSessionSummary).not.toHaveBeenCalled();
  });
});
