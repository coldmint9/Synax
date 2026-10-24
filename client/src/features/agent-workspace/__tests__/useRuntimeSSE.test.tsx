import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRuntimeSSE } from "../useRuntimeSSE";
import {
  resetWorkspaceSessionCache,
  useAgentSessionStore,
} from "../state/agentSessionStore";
import {
  agentRuntimeApi,
  type AgentSession,
} from "../../../adapters/transport/agentRuntime";
import { resetSessionListCache } from "../state/sessionListCache";
const bus = vi.hoisted(() => ({
  changed: (_event: MessageEvent) => {},
  archived: (_event: MessageEvent) => {},
  created: (_event: MessageEvent) => {},
  deleted: (_event: MessageEvent) => {},
  step: (_event: MessageEvent) => {},
}));
vi.mock("../../../adapters/transport/runtimeEventBus", () => ({
  subscribe: ({
    events,
  }: {
    events: {
      session_changed: (event: MessageEvent) => void;
      session_archived: (event: MessageEvent) => void;
      session_created: (event: MessageEvent) => void;
      session_deleted: (event: MessageEvent) => void;
      session_step_completed: (event: MessageEvent) => void;
    };
  }) => {
    bus.changed = events.session_changed;
    bus.archived = events.session_archived;
    bus.created = events.session_created;
    bus.deleted = events.session_deleted;
    bus.step = events.session_step_completed;
    return () => {};
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  resetWorkspaceSessionCache();
  resetSessionListCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetWorkspaceSessionCache();
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

it('leaves selected run lifecycle to realtime and does not trigger full detail hydration', async () => {
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
    expect(useAgentSessionStore.getState().sessions[0]).toMatchObject({ title: 'Updated title', status: 'running', activeRunId: 'r1' });
    act(() => bus.step({ data: JSON.stringify({ sessionId: 's1' }) } as MessageEvent));
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(refreshDetail).not.toHaveBeenCalled();
  } finally { setRunRealtimeObservation('s1', null); }
});
