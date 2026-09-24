import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAgentDockBridge } from "../useAgentDockBridge";
import { useAgentDockStore } from "../../state/agentDockStore";
import { agentRuntimeApi } from "../../../../../lib/api/agentRuntime";

const listeners = vi.hoisted(() => ({
  events: [] as Array<Record<string, (event: MessageEvent) => void>>,
  live: [] as Array<(event: any) => void>,
}));
vi.mock("../../../../../lib/api/runtimeEventBus", () => ({
  subscribe: ({
    events,
  }: {
    events: Record<string, (event: MessageEvent) => void>;
  }) => {
    listeners.events.push(events);
    return () => {};
  },
}));
vi.mock("../../../../../lib/api/sessionLiveClient", () => ({
  addSessionLiveListener: (_id: string, fn: (event: any) => void) => {
    listeners.live.push(fn);
    return () => {};
  },
}));
vi.mock("../../../../../lib/api/agentRuntime", () => ({
  agentRuntimeApi: { getSession: vi.fn(), listPermissions: vi.fn() },
}));
vi.mock("../../state/agentSessionStore", () => ({
  useAgentSessionStore: { getState: () => ({ selectedSessionId: null }) },
  scheduleSessionRefresh: vi.fn(),
}));
vi.mock("../../state/agentDockStore", async () => {
  const { create } = await import("zustand");
  return {
    useAgentDockStore: create(() => ({
      dockState: "expanded",
      session: {
        sessionId: "a",
        title: "A",
        permissions: [],
        streamingText: "",
        streamingThinking: "",
      },
    })),
  };
});

it("rejects delayed titles, permission responses and stream callbacks from an old session", async () => {
  let resolveOld: (value: any) => void = () => {};
  let resolvePermissions: (value: any) => void = () => {};
  vi.mocked(agentRuntimeApi.getSession).mockImplementation((id) =>
    id === "a"
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve({ session: { title: "B" } } as any),
  );
  vi.mocked(agentRuntimeApi.listPermissions).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePermissions = resolve;
      }),
  );
  renderHook(() => useAgentDockBridge("project"));
  const oldEvent = listeners.events[0].session_changed;
  act(() =>
    oldEvent({
      data: JSON.stringify({
        sessionId: "a",
        patch: { status: "waiting_permission" },
      }),
    } as MessageEvent),
  );
  const resolveOldPermissions = resolvePermissions;
  act(() =>
    useAgentDockStore.setState((s) => ({
      session: { ...s.session, sessionId: "b", title: "B" },
    })),
  );
  await act(async () => {
    resolveOld({ session: { title: "old generated title" } });
    resolveOldPermissions({ items: [{ id: "old permission" }] });
    oldEvent({
      data: JSON.stringify({
        sessionId: "a",
        patch: { title: "old event title" },
      }),
    } as MessageEvent);
    listeners.live[0]({ type: "message_delta", delta: "old message" });
  });
  expect(useAgentDockStore.getState().session).toMatchObject({
    sessionId: "b",
    title: "B",
    permissions: [],
    streamingText: "",
  });
});
