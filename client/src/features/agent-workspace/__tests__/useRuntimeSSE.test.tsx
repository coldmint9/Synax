import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRuntimeSSE } from "../useRuntimeSSE";
import {
  clearScheduledSessionRefresh,
  resetWorkspaceSessionCache,
  useAgentSessionStore,
} from "../state/agentSessionStore";
import {
  agentRuntimeApi,
  type AgentSession,
} from "../../../adapters/transport/agentRuntime";
import { resetSessionListCache } from "../state/sessionListCache";
import { resetSessionStatusReconcile } from "../sessionStatusReconcile";
const bus = vi.hoisted(() => ({
  changed: (_event: MessageEvent) => {},
  archived: (_event: MessageEvent) => {},
  created: (_event: MessageEvent) => {},
  deleted: (_event: MessageEvent) => {},
  step: (_event: MessageEvent) => {},
  connect: () => {},
}));
vi.mock("../../../adapters/transport/runtimeEventBus", () => ({
  subscribe: ({
    events,
    onConnect,
  }: {
    events: {
      session_changed: (event: MessageEvent) => void;
      session_archived: (event: MessageEvent) => void;
      session_created: (event: MessageEvent) => void;
      session_deleted: (event: MessageEvent) => void;
      session_step_completed: (event: MessageEvent) => void;
    };
    onConnect?: () => void;
  }) => {
    bus.changed = events.session_changed;
    bus.archived = events.session_archived;
    bus.created = events.session_created;
    bus.deleted = events.session_deleted;
    bus.step = events.session_step_completed;
    bus.connect = onConnect ?? (() => {});
    return () => {};
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  resetWorkspaceSessionCache();
  resetSessionListCache();
  clearScheduledSessionRefresh();
  resetSessionStatusReconcile();
});
afterEach(() => {
  clearScheduledSessionRefresh();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetWorkspaceSessionCache();
  resetSessionStatusReconcile();
});

it('invalidates an off-screen content revision without fetching it, while title changes stay hot', async () => {
  const refreshDetail = vi.fn(async () => {});
  const cached = { messages: [], runs: [], steps: [], events: [], toolCalls: [], permissions: [],
    sessionStats: null, sessionTodos: [], sessionInvocationUsage: null, cachedAt: Date.now() };
  useAgentSessionStore.setState({ ...useAgentSessionStore.getInitialState(), selectedSessionId: 'open',
    sessions: [row('open'), row('cached', { status: 'completed', activeRunId: null })],
    sessionDetailCache: { cached }, refreshDetail });
  renderHook(useRuntimeSSE);
  act(() => bus.changed({ data: JSON.stringify({ sessionId: 'cached', patch: { title: 'Renamed', updatedAt: '2026-10-28' } }) } as MessageEvent));
  expect(useAgentSessionStore.getState().sessionDetailCache.cached).toBe(cached);
  act(() => bus.changed({ data: JSON.stringify({ sessionId: 'cached', patch: { historyRevision: 2 } }) } as MessageEvent));
  expect(useAgentSessionStore.getState().sessionDetailCache.cached.invalidated).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
  expect(refreshDetail).not.toHaveBeenCalled();
});

const row = (id: string, overrides: Partial<AgentSession> = {}) =>
  ({
    id,
    projectId: "one",
    status: "running",
    title: id,
    activeRunId: "r1",
    sessionMetadata: { mode: "chat" },
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }) as AgentSession;

it("patches generated titles and statuses in place instead of reloading the list", async () => {
  const session = row("s1");
  const refreshSessions = vi.fn(async () => {});
  const refreshDetail = vi.fn(async () => {});
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    selectedSessionId: "s1",
    sessions: [session, row("s2")],
    refreshSessions,
    refreshDetail,
  });
  renderHook(useRuntimeSSE);
  const emit = (sessionId: string, patch: Partial<AgentSession>) =>
    act(() =>
      bus.changed({
        data: JSON.stringify({ sessionId, patch }),
      } as MessageEvent),
    );
  emit("s2", {
    title: "Other title",
    updatedAt: "2026-01-02T00:00:00Z",
    status: "running",
    activeRunId: "r1",
    sessionMetadata: { mode: "chat", titleSummarized: true },
  });
  emit("s1", {
    title: "Current title",
    updatedAt: "2026-01-02T00:00:00Z",
    status: "running",
    activeRunId: "r1",
    sessionMetadata: { mode: "chat", titleSummarized: true },
  });
  expect(useAgentSessionStore.getState().sessions.map((s) => s.title)).toEqual([
    "Current title",
    "Other title",
  ]);
  emit("s1", {
    title: "Current title",
    status: "completed",
    activeRunId: null,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  // The row is the only thing that changed: the open transcript reconciles, the
  // page is never re-read.
  expect(useAgentSessionStore.getState().sessions[0]?.status).toBe("completed");
  expect(refreshSessions).not.toHaveBeenCalled();
  expect(refreshDetail).toHaveBeenCalledTimes(1);
});

it("reads just the session a callback names when its row was never loaded", async () => {
  const refreshSessions = vi.fn(async () => {});
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: "one",
    sessions: [row("known")],
    refreshSessions,
  });
  const summary = vi
    .spyOn(agentRuntimeApi, "getSessionSummary")
    .mockResolvedValue({ session: row("created", { updatedAt: "2026-01-03" }) } as never);
  renderHook(useRuntimeSSE);

  await act(async () => {
    bus.created({ data: JSON.stringify({ sessionId: "created" }) } as MessageEvent);
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(summary).toHaveBeenCalledWith("created");
  expect(
    useAgentSessionStore.getState().sessions.map((session) => session.id),
  ).toEqual(["created", "known"]);
  expect(refreshSessions).not.toHaveBeenCalled();
});

it("drops deleted and archived rows locally instead of re-reading the page", () => {
  const refreshSessions = vi.fn(async () => {});
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: "one",
    sessions: [row("archived"), row("deleted"), row("kept")],
    refreshSessions,
  });
  renderHook(useRuntimeSSE);

  act(() =>
    bus.archived({
      data: JSON.stringify({ sessionId: "archived" }),
    } as MessageEvent),
  );
  act(() =>
    bus.deleted({ data: JSON.stringify({ sessionId: "deleted" }) } as MessageEvent),
  );

  expect(
    useAgentSessionStore.getState().sessions.map((session) => session.id),
  ).toEqual(["kept"]);
  expect(refreshSessions).not.toHaveBeenCalled();
});

it("keeps a step callback to the open transcript only", async () => {
  const refreshSessions = vi.fn(async () => {});
  const refreshDetail = vi.fn(async () => {});
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: "one",
    selectedSessionId: "s1",
    sessions: [row("s1"), row("s2")],
    refreshSessions,
    refreshDetail,
  });
  renderHook(useRuntimeSSE);

  act(() =>
    bus.step({ data: JSON.stringify({ sessionId: "s2", runId: "r1" }) } as MessageEvent),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });

  expect(refreshSessions).not.toHaveBeenCalled();
  expect(refreshDetail).not.toHaveBeenCalled();
});

it('keeps intermediate lifecycle with realtime but applies the terminal session patch', async () => {
  const { setRunRealtimeObservation } = await import('../../../adapters/transport/runRealtime');
  const refreshDetail = vi.fn(async () => {});
  useAgentSessionStore.setState({ ...useAgentSessionStore.getInitialState(), selectedSessionId: 's1',
    sessions: [row('s1')], refreshDetail });
  setRunRealtimeObservation('s1', 'r1');
  try {
    renderHook(useRuntimeSSE);
    act(() => bus.changed({ data: JSON.stringify({ sessionId: 's1', patch: {
      title: 'Updated title', status: 'completed', activeRunId: null,
    } }) } as MessageEvent));
    expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({ title: 'Updated title', status: 'completed', activeRunId: null });
    act(() => bus.step({ data: JSON.stringify({ sessionId: 's1' }) } as MessageEvent));
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(refreshDetail).not.toHaveBeenCalled();
  } finally { setRunRealtimeObservation('s1', null); }
});

it('lets a row outside the open transcript follow the durable lifecycle even while its run stream is attached', async () => {
  const { setRunRealtimeObservation } = await import('../../../adapters/transport/runRealtime');
  const refreshDetail = vi.fn(async () => {});
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: 'one',
    selectedSessionId: 'open',
    sessions: [
      row('open', { status: 'completed', activeRunId: null }),
      row('dock', { status: 'queued' }),
    ],
    refreshDetail,
  });
  // The Dock (or a stream that is about to be released) holds the run stream
  // for a session this page lists but does not render.
  setRunRealtimeObservation('dock', 'r1');
  try {
    renderHook(useRuntimeSSE);
    act(() =>
      bus.changed({
        data: JSON.stringify({
          sessionId: 'dock',
          patch: { status: 'running', activeRunId: 'r1' },
        }),
      } as MessageEvent),
    );
    expect(
      useAgentSessionStore.getState().sessions.find((s) => s.id === 'dock')
        ?.status,
    ).toBe('running');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    // The row converges without hydrating a transcript it does not own.
    expect(refreshDetail).not.toHaveBeenCalled();
  } finally {
    setRunRealtimeObservation('dock', null);
  }
});

it("settles a row whose terminal callback was missed while the stream was down", async () => {
  // The loader is rendered from `status` alone, and a settle is reported once.
  // A callback that never arrives (reconnect, unmounted workbench, sleeping
  // window) used to leave the row animating until the user opened it.
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: "one",
    sessions: [row("running")],
  });
  const summary = vi
    .spyOn(agentRuntimeApi, "getSessionSummary")
    .mockResolvedValue({
      session: row("running", {
        status: "completed",
        activeRunId: null,
        updatedAt: "2026-01-03T00:00:00Z",
      }),
    } as never);
  renderHook(useRuntimeSSE);

  await act(async () => {
    bus.connect();
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(summary).toHaveBeenCalledWith("running");
  expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({
    status: "completed",
    activeRunId: null,
  });
});

it("settles an animated row when the stream never reported the settle", async () => {
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: "one",
    sessions: [row("running")],
  });
  const summary = vi
    .spyOn(agentRuntimeApi, "getSessionSummary")
    .mockResolvedValue({
      session: row("running", {
        status: "completed",
        activeRunId: null,
        updatedAt: "2026-01-03T00:00:00Z",
      }),
    } as never);
  renderHook(useRuntimeSSE);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });

  expect(summary).toHaveBeenCalledWith("running");
  expect(useAgentSessionStore.getState().sessions[0]?.status).toBe("completed");
});

it("keeps the watchdog silent while every row is settled", async () => {
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: "one",
    sessions: [row("done", { status: "completed", activeRunId: null })],
  });
  const summary = vi.spyOn(agentRuntimeApi, "getSessionSummary");
  renderHook(useRuntimeSSE);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(90_000);
  });

  expect(summary).not.toHaveBeenCalled();
});
