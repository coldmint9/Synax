import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRuntimeSSE } from "../useRuntimeSSE";
import { useAgentSessionStore } from "../state/agentSessionStore";
import type { AgentSession } from "../../../../lib/api/agentRuntime";
const bus = vi.hoisted(() => ({
  changed: (_event: MessageEvent) => {},
  archived: (_event: MessageEvent) => {},
}));
vi.mock("../../../../lib/api/runtimeEventBus", () => ({
  subscribe: ({
    events,
  }: {
    events: {
      session_changed: (event: MessageEvent) => void;
      session_archived: (event: MessageEvent) => void;
    };
  }) => {
    bus.changed = events.session_changed;
    bus.archived = events.session_archived;
    return () => {};
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it("patches generated titles in place without reloading the list/transcript, but reconciles real status changes with one trailing refresh", async () => {
  const session = {
    id: "s1",
    projectId: "one",
    status: "running",
    title: "new session",
    activeRunId: "r1",
    sessionMetadata: { mode: "chat" },
    updatedAt: "old",
  } as AgentSession;
  const refreshSessions = vi.fn(async () => {});
  const refreshDetail = vi.fn(async () => {});
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    selectedSessionId: "s1",
    sessions: [session, { ...session, id: "s2" }],
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
    updatedAt: "new",
    status: "running",
    activeRunId: "r1",
    sessionMetadata: { mode: "chat", titleSummarized: true },
  });
  emit("s1", {
    title: "Current title",
    updatedAt: "new",
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
  // Title-only patches stay quiet; the real status change coalesces into one
  // trailing refresh per target after the debounce window.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });
  expect(refreshSessions).toHaveBeenCalledTimes(1);
  expect(refreshDetail).toHaveBeenCalledTimes(1);
});

it("treats archive events as removal without a deleted-session error", () => {
  const session = {
    id: "archived",
    projectId: "one",
    status: "completed",
    title: "archived",
    activeRunId: null,
    sessionMetadata: {},
    updatedAt: "now",
  } as AgentSession;
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: "one",
    sessions: [session],
    refreshSessions: vi.fn(async () => {}),
  });
  renderHook(useRuntimeSSE);

  act(() =>
    bus.archived({
      data: JSON.stringify({ sessionId: session.id }),
    } as MessageEvent),
  );

  expect(useAgentSessionStore.getState().sessions).toEqual([]);
});
