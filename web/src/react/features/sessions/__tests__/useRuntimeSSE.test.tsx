import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useRuntimeSSE } from "../useRuntimeSSE";
import { useAgentSessionStore } from "../agentSessionStore";
import type { AgentSession } from "../../../../lib/api/agentRuntime";
const bus = vi.hoisted(() => ({ changed: (_event: MessageEvent) => {} }));
vi.mock("../../../../lib/api/runtimeEventBus", () => ({
  subscribe: ({
    events,
  }: {
    events: { session_changed: (event: MessageEvent) => void };
  }) => {
    bus.changed = events.session_changed;
    return () => {};
  },
}));

it("patches generated titles in place without reloading the list/transcript, but reconciles real status changes", () => {
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
  expect(refreshSessions).not.toHaveBeenCalled();
  expect(refreshDetail).not.toHaveBeenCalled();
  emit("s1", {
    title: "Current title",
    status: "completed",
    activeRunId: null,
  });
  expect(refreshSessions).toHaveBeenCalledTimes(1);
  expect(refreshDetail).toHaveBeenCalledTimes(1);
});
