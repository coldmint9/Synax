import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  agentRuntimeApi as api,
  type SessionEnvironment,
} from "../../../adapters/transport/agentRuntime";
import { useSessionEnvironment } from "../useSessionEnvironment";
import { refreshWorkspace } from "../workspaceRefresh";

const runtime = vi.hoisted(() => ({
  active: true,
  handlers: new Set<{
    events: Record<string, (event: MessageEvent) => void>;
    onConnect?: () => void;
  }>(),
}));
vi.mock("../../../app/layouts/CachedWorkbenchPage", () => ({
  useWorkbenchPageActive: () => runtime.active,
}));
vi.mock("../../../adapters/transport/runtimeEventBus", () => ({
  subscribe: (subscription: Parameters<typeof runtime.handlers.add>[0]) => {
    runtime.handlers.add(subscription);
    return () => runtime.handlers.delete(subscription);
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  runtime.active = true;
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  runtime.handlers.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const environment = (sessionId: string) =>
  ({ sessionId, branch: sessionId, subagents: [], refreshedAt: "first" }) as unknown as SessionEnvironment;
const advance = async (ms = 0) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};
const emit = (type: string, sessionId: string, patch?: Record<string, unknown>) => {
  act(() => {
    for (const subscriber of runtime.handlers) subscriber.events[type]?.(
      new MessageEvent("message", { data: JSON.stringify({ sessionId, patch }) }),
    );
  });
};
const visibility = (hidden: boolean) => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
};
function deferred() {
  let resolve!: (value: SessionEnvironment) => void;
  const promise = new Promise<SessionEnvironment>((done) => { resolve = done; });
  return { promise, resolve };
}

it("shares concurrent requests and restores cached snapshots without crossing session boundaries", async () => {
  const request = deferred();
  const fetch = vi.spyOn(api, "getSessionEnvironment")
    .mockReturnValueOnce(request.promise).mockResolvedValue(environment("env-b"));
  const first = renderHook(({ id }) => useSessionEnvironment(id), { initialProps: { id: "env-a" } });
  const second = renderHook(() => useSessionEnvironment("env-a"));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(first.result.current.loading).toBe(true);
  await act(async () => { request.resolve(environment("env-a")); });
  expect(first.result.current.environment?.sessionId).toBe("env-a");
  expect(second.result.current.environment?.sessionId).toBe("env-a");
  first.rerender({ id: "env-b" });
  expect(first.result.current.environment).toBeNull();
  await advance();
  expect(first.result.current.environment?.sessionId).toBe("env-b");
  fetch.mockRejectedValue(new Error("offline"));
  first.rerender({ id: "env-a" });
  expect(first.result.current.environment?.sessionId).toBe("env-a");
  await advance();
  expect(first.result.current.loading).toBe(false);
  expect(first.result.current.environment?.sessionId).toBe("env-a");
});

it("filters unrelated sessions and metadata churn, and batches relevant parent/child events", async () => {
  const snapshot = { ...environment("parent"), subagents: [{ id: "child", status: "running" }] } as SessionEnvironment;
  const fetch = vi.spyOn(api, "getSessionEnvironment").mockResolvedValue(snapshot);
  const hook = renderHook(() => useSessionEnvironment("parent"));
  await advance();
  emit("session_changed", "unrelated", { status: "completed" });
  emit("session_changed", "parent", { title: "renamed", updatedAt: "now" });
  emit("session_changed", "parent", { sessionMetadata: { contextCompaction: { stage: "running" } } });
  await advance(5_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValue({ ...snapshot, subagents: [{ ...snapshot.subagents[0], status: "completed" }] });
  emit("session_changed", "child", { status: "completed" });
  emit("session_step_completed", "parent");
  emit("session_changed", "parent", { status: "idle" });
  await advance(250);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(hook.result.current.environment?.subagents[0].status).toBe("completed");
});

it("does not repeatedly refresh for unchanged workspace metadata in full metadata patches", async () => {
  const fetch = vi.spyOn(api, "getSessionEnvironment").mockResolvedValue(environment("metadata"));
  renderHook(() => useSessionEnvironment("metadata"));
  await advance();
  const backend = { workDir: "/repo", workspaceRoots: [{ id: "root" }] };
  emit("session_changed", "metadata", { sessionMetadata: { backend, preview: "first" } });
  await advance(5_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  emit("session_changed", "metadata", { sessionMetadata: { backend, preview: "second" } });
  await advance(5_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  emit("session_changed", "metadata", { sessionMetadata: { backend: { ...backend, workDir: "/new" } } });
  await advance(250);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("bounds continuous events without starving refreshes", async () => {
  const fetch = vi.spyOn(api, "getSessionEnvironment").mockResolvedValue(environment("continuous"));
  renderHook(() => useSessionEnvironment("continuous"));
  await advance();
  for (let index = 0; index < 100; index++) {
    emit("session_step_completed", "continuous");
    await advance(100);
  }
  expect(fetch).toHaveBeenCalledTimes(3); // initial plus one at 5s and 10s
});

it("keeps background refresh quiet and preserves identity when only the timestamp changes", async () => {
  const snapshot = environment("quiet");
  const fetch = vi.spyOn(api, "getSessionEnvironment").mockResolvedValue(snapshot);
  const hook = renderHook(() => useSessionEnvironment("quiet"));
  await advance();
  const request = deferred();
  fetch.mockReturnValueOnce(request.promise);
  emit("session_step_completed", "quiet");
  await advance(5_000);
  expect(hook.result.current.loading).toBe(false);
  await act(async () => { request.resolve({ ...snapshot, refreshedAt: "second" }); });
  expect(hook.result.current.environment).toBe(snapshot);
  const manual = deferred();
  fetch.mockReturnValueOnce(manual.promise);
  let refresh!: Promise<void>;
  act(() => { refresh = hook.result.current.reload(); });
  expect(hook.result.current.loading).toBe(true);
  await act(async () => { manual.resolve({ ...snapshot, branch: "new" }); await refresh; });
  expect(hook.result.current.loading).toBe(false);
  expect(hook.result.current.environment?.branch).toBe("new");
});

it("queues one trailing refresh for invalidations during a request", async () => {
  const initial = deferred();
  const fetch = vi.spyOn(api, "getSessionEnvironment").mockReturnValueOnce(initial.promise)
    .mockResolvedValue({ ...environment("trailing"), branch: "latest" });
  const hook = renderHook(() => useSessionEnvironment("trailing"));
  emit("session_step_completed", "trailing");
  act(() => { refreshWorkspace("trailing"); refreshWorkspace("trailing"); });
  await advance(10_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { initial.resolve(environment("trailing")); });
  await advance(4_999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(hook.result.current.environment?.branch).toBe("latest");
});

it("suspends hidden-page events and polling, then catches up once", async () => {
  const fetch = vi.spyOn(api, "getSessionEnvironment").mockResolvedValue(environment("hidden"));
  renderHook(() => useSessionEnvironment("hidden"));
  await advance();
  visibility(true);
  emit("session_step_completed", "hidden");
  act(() => { refreshWorkspace("hidden"); });
  await advance(300_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  visibility(false);
  await advance();
  expect(fetch).toHaveBeenCalledTimes(2);
  visibility(true);
  await advance(1_000);
  visibility(false);
  await advance();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("defers initial reads until visible and refreshes stale snapshots on resume", async () => {
  visibility(true);
  const fetch = vi.spyOn(api, "getSessionEnvironment").mockResolvedValue(environment("initial-hidden"));
  renderHook(() => useSessionEnvironment("initial-hidden"));
  await advance(120_000);
  expect(fetch).not.toHaveBeenCalled();
  visibility(false);
  await advance();
  expect(fetch).toHaveBeenCalledTimes(1);
  visibility(true);
  await advance(30_000);
  visibility(false);
  await advance();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("polls every two minutes and resets the safety net after event refreshes", async () => {
  const fetch = vi.spyOn(api, "getSessionEnvironment").mockResolvedValue(environment("poll"));
  renderHook(() => useSessionEnvironment("poll"));
  await advance(119_999);
  expect(fetch).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  await advance(60_000);
  emit("session_step_completed", "poll");
  await advance(250);
  expect(fetch).toHaveBeenCalledTimes(3);
  await advance(119_999);
  expect(fetch).toHaveBeenCalledTimes(3);
  await advance(1);
  expect(fetch).toHaveBeenCalledTimes(4);
});

it("stops subscriptions and timers while inactive and after unmount", async () => {
  const fetch = vi.spyOn(api, "getSessionEnvironment").mockResolvedValue(environment("inactive"));
  const hook = renderHook(() => useSessionEnvironment("inactive"));
  await advance();
  runtime.active = false;
  hook.rerender();
  expect(runtime.handlers.size).toBe(0);
  act(() => { refreshWorkspace("inactive"); });
  await advance(300_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  runtime.active = true;
  hook.rerender();
  await advance();
  expect(fetch).toHaveBeenCalledTimes(2);
  hook.unmount();
  await advance(300_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not apply an old request to a newly selected session", async () => {
  const old = deferred();
  vi.spyOn(api, "getSessionEnvironment").mockReturnValueOnce(old.promise).mockResolvedValue(environment("new-session"));
  const hook = renderHook(({ id }) => useSessionEnvironment(id), { initialProps: { id: "old-session" } });
  hook.rerender({ id: "new-session" });
  await advance();
  await act(async () => { old.resolve(environment("old-session")); });
  expect(hook.result.current.environment?.sessionId).toBe("new-session");
  expect(hook.result.current.loading).toBe(false);
});

it("catches up after reconnecting even when a pre-reconnect request is pending", async () => {
  const snapshot = environment("reconnect");
  const request = deferred();
  const fetch = vi.spyOn(api, "getSessionEnvironment").mockResolvedValueOnce(snapshot)
    .mockReturnValueOnce(request.promise).mockResolvedValue({ ...snapshot, branch: "reconnected" });
  const hook = renderHook(() => useSessionEnvironment("reconnect"));
  await advance(120_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  act(() => { for (const subscription of runtime.handlers) subscription.onConnect?.(); });
  await act(async () => { request.resolve(snapshot); });
  await advance(5_000);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(hook.result.current.environment?.branch).toBe("reconnected");
});

it("recovers after a failed automatic read without a retry loop", async () => {
  const snapshot = environment("failure");
  const fetch = vi.spyOn(api, "getSessionEnvironment").mockResolvedValueOnce(snapshot)
    .mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ...snapshot, branch: "recovered" });
  const hook = renderHook(() => useSessionEnvironment("failure"));
  await advance(120_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(hook.result.current.environment).toBe(snapshot);
  expect(hook.result.current.loading).toBe(false);
  await advance(120_000);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(hook.result.current.environment?.branch).toBe("recovered");
});
