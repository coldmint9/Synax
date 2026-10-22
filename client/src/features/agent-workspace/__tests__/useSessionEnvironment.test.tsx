import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  agentRuntimeApi as api,
  type SessionEnvironmentInputs,
  type SessionEnvironmentRoots,
} from "../../../adapters/transport/agentRuntime";
import {
  invalidateSessionEnvironmentCards,
  useSessionEnvironmentInputs,
  useSessionEnvironmentRoots,
} from "../useSessionEnvironment";

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

const roots = (sessionId: string) =>
  ({
    sessionId,
    projectId: "project",
    workspacePath: "/ws",
    repositories: [],
    refreshedAt: "first",
  }) as SessionEnvironmentRoots;

const inputs = (sessionId: string) =>
  ({
    sessionId,
    projectId: "project",
    primaryRootId: "project",
    byRoot: {},
    refreshedAt: "first",
  }) as SessionEnvironmentInputs;

const emit = (
  type: string,
  payload: { sessionId?: string; projectId?: string; patch?: Record<string, unknown> },
) => {
  act(() => {
    for (const subscriber of runtime.handlers)
      subscriber.events[type]?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  });
};
const advance = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  runtime.active = true;
  runtime.handlers.clear();
  invalidateSessionEnvironmentCards();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  invalidateSessionEnvironmentCards();
  vi.restoreAllMocks();
});

it("shares one request per card and reuses it when the session comes back", async () => {
  const getRoots = vi.spyOn(api, "getSessionEnvironmentRoots").mockResolvedValue(roots("a"));
  const first = renderHook(({ id }) => useSessionEnvironmentRoots(id), {
    initialProps: { id: "a" as string | null },
  });
  const second = renderHook(() => useSessionEnvironmentRoots("a"));
  await advance();
  expect(getRoots).toHaveBeenCalledTimes(1);
  expect(first.result.current.value?.sessionId).toBe("a");
  expect(second.result.current.value?.sessionId).toBe("a");

  first.rerender({ id: "b" });
  await advance();
  expect(getRoots).toHaveBeenCalledTimes(2);

  // Switching back within the TTL paints the cached card without a request.
  first.rerender({ id: "a" });
  await advance();
  expect(first.result.current.value?.sessionId).toBe("a");
  expect(getRoots).toHaveBeenCalledTimes(2);
});

it("keeps cards independent: one card's event does not reload another", async () => {
  const getRoots = vi.spyOn(api, "getSessionEnvironmentRoots").mockResolvedValue(roots("s"));
  const getInputs = vi.spyOn(api, "getSessionEnvironmentInputs").mockResolvedValue(inputs("s"));
  renderHook(() => useSessionEnvironmentRoots("s"));
  renderHook(() => useSessionEnvironmentInputs("s"));
  await advance();
  expect(getRoots).toHaveBeenCalledTimes(1);
  expect(getInputs).toHaveBeenCalledTimes(1);

  // A completed step changes what the conversation read, never its roots.
  emit("session_step_completed", { sessionId: "s", projectId: "project" });
  await advance(300);
  expect(getInputs).toHaveBeenCalledTimes(2);
  expect(getRoots).toHaveBeenCalledTimes(1);

  // Workspace metadata is the only thing that moves the roots card.
  emit("session_changed", { sessionId: "s", patch: { title: "rename" } });
  await advance(300);
  expect(getRoots).toHaveBeenCalledTimes(1);
  emit("session_changed", {
    sessionId: "s",
    patch: { sessionMetadata: { backend: { workDir: "/other" } } },
  });
  await advance(300);
  expect(getRoots).toHaveBeenCalledTimes(2);
});

it("ignores events for other sessions and batches bursts", async () => {
  const getInputs = vi.spyOn(api, "getSessionEnvironmentInputs").mockResolvedValue(inputs("s"));
  renderHook(() => useSessionEnvironmentInputs("s"));
  await advance();
  expect(getInputs).toHaveBeenCalledTimes(1);

  emit("session_step_completed", { sessionId: "other", projectId: "project" });
  await advance(1_000);
  expect(getInputs).toHaveBeenCalledTimes(1);

  for (let index = 0; index < 5; index += 1)
    emit("session_step_completed", { sessionId: "s", projectId: "project" });
  await advance(300);
  expect(getInputs).toHaveBeenCalledTimes(2);
});

it("stops polling while the workbench page is inactive", async () => {
  const getInputs = vi.spyOn(api, "getSessionEnvironmentInputs").mockResolvedValue(inputs("s"));
  runtime.active = false;
  const hook = renderHook(() => useSessionEnvironmentInputs("s"));
  await advance(120_000);
  expect(getInputs).not.toHaveBeenCalled();
  expect(hook.result.current.loading).toBe(false);

  runtime.active = true;
  hook.rerender();
  await advance();
  expect(getInputs).toHaveBeenCalledTimes(1);
});

it("does not poll while the document is hidden, and resumes on visibility", async () => {
  const getInputs = vi.spyOn(api, "getSessionEnvironmentInputs").mockResolvedValue(inputs("s"));
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  renderHook(() => useSessionEnvironmentInputs("s"));
  await advance(5_000);
  expect(getInputs).not.toHaveBeenCalled();

  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await advance();
  expect(getInputs).toHaveBeenCalledTimes(1);
});
