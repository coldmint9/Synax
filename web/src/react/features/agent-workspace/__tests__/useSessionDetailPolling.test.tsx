import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useApiConnectivityStore } from "../../../../lib/apiConnectivity";
import {
  agentRuntimeApi as api,
  type AgentSession,
  type AgentSessionStatus,
  type SessionStats,
} from "../../../../lib/api/agentRuntime";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import {
  useSessionDetailPolling,
  ACTIVE_SESSION_POLL_MS as POLL_MS,
} from "../useSessionDetailPolling";

function makeSession(id: string, status: AgentSessionStatus): AgentSession {
  return {
    id,
    projectId: "p1",
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: "goal",
    status,
    title: null,
    prompt: "test",
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
    sessionMetadata: null,
  };
}

const stats = (): SessionStats =>
  ({
    status: "running",
    runningDuration: 1000,
    tokenUsage: { input: 1, output: 1, total: 2 },
    contextLimit: 1000,
    contextUsedPercent: 0,
    toolCallCount: 0,
    activeSubAgentCount: 0,
  }) as SessionStats;

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state === "hidden",
  });
}

function dispatchVisibility(state: DocumentVisibilityState) {
  setVisibility(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Server-side session status returned by subsequent listSessions calls. */
let serverStatus: AgentSessionStatus = "running";

function primeStore(status: AgentSessionStatus = "running") {
  serverStatus = status;
  store.setState({
    ...store.getInitialState(),
    projectId: "p1",
    panelOpen: true,
    selectedSessionId: "s1",
    sessions: [makeSession("s1", status)],
  });
}

/** Flush settled promises so refresh tails and their `finally` blocks run. */
async function flush() {
  // `await act(async () => {})` drains the microtask queue, including the
  // detached transcript task the store kicks off, so its `set()` calls land
  // inside act and do not emit warnings.
  await act(async () => {});
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
  useApiConnectivityStore.setState({ apiReachable: "reachable" });
  vi.spyOn(api, "listSessions").mockImplementation(async () => ({
    items: [makeSession("s1", serverStatus)],
  }));
  vi.spyOn(api, "getSessionStats").mockResolvedValue(stats());
  vi.spyOn(api, "getSessionTodos").mockResolvedValue({ items: [] });
  vi.spyOn(api, "getSessionInvocationUsage").mockResolvedValue({
    items: [],
    totalCalls: 0,
  });
  for (const key of [
    "listSessionSteps",
    "listRuns",
    "listEvents",
    "listMessages",
    "listToolCalls",
    "listPermissions",
  ] as const) {
    vi.spyOn(api, key).mockResolvedValue({ items: [] });
  }
  primeStore();
});

afterEach(() => {
  // Reset while the hook is still mounted, so wrap it: an unwrapped store
  // change here would re-render the harness after the test and warn.
  act(() => {
    store.setState(store.getInitialState());
    useApiConnectivityStore.setState({ apiReachable: "unknown" });
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useSessionDetailPolling", () => {
  it("refreshes the session list and detail immediately on activation", async () => {
    renderHook(() => useSessionDetailPolling());
    await flush();

    expect(api.listSessions).toHaveBeenCalledTimes(1);
    expect(api.getSessionStats).toHaveBeenCalledTimes(1);
    expect(api.listPermissions).toHaveBeenCalledTimes(1);
  });

  it("refreshes again on each interval", async () => {
    renderHook(() => useSessionDetailPolling());
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await flush();
    expect(api.listSessions).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await flush();
    expect(api.listSessions).toHaveBeenCalledTimes(3);
  });

  it("does not start a new cycle while the awaited refresh is still in flight", async () => {
    let resolveList!: (value: { items: AgentSession[] }) => void;
    vi.mocked(api.listSessions).mockReturnValueOnce(
      new Promise((r) => {
        resolveList = r;
      }),
    );

    renderHook(() => useSessionDetailPolling());
    await flush();
    expect(api.listSessions).toHaveBeenCalledTimes(1);

    // Several intervals elapse while listSessions is unresolved: no tick may start.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    await flush();
    expect(api.listSessions).toHaveBeenCalledTimes(1);
    expect(api.getSessionStats).toHaveBeenCalledTimes(1);

    resolveList({ items: [makeSession("s1", "running")] });
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await flush();
    expect(api.listSessions).toHaveBeenCalledTimes(2);
  });

  it("pauses while the document is hidden and refreshes immediately when visible again", async () => {
    renderHook(() => useSessionDetailPolling());
    await flush();
    expect(api.listSessions).toHaveBeenCalledTimes(1);

    act(() => {
      dispatchVisibility("hidden");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    });
    await flush();
    // No background polling happened.
    expect(api.listSessions).toHaveBeenCalledTimes(1);
    expect(api.getSessionStats).toHaveBeenCalledTimes(1);

    act(() => {
      dispatchVisibility("visible");
    });
    await flush();
    // Resume is immediate: no timer advance needed.
    expect(api.listSessions).toHaveBeenCalledTimes(2);
    expect(api.getSessionStats).toHaveBeenCalledTimes(2);

    // Regular cadence resumes afterwards.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await flush();
    expect(api.listSessions).toHaveBeenCalledTimes(3);
  });

  it("performs no network work when mounted while the document is hidden", async () => {
    setVisibility("hidden");
    renderHook(() => useSessionDetailPolling());
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    await flush();
    expect(api.listSessions).not.toHaveBeenCalled();
    expect(api.getSessionStats).not.toHaveBeenCalled();

    act(() => {
      dispatchVisibility("visible");
    });
    await flush();
    expect(api.listSessions).toHaveBeenCalledTimes(1);
  });

  it("stops once the session reaches a terminal status, keeping the final refresh", async () => {
    renderHook(() => useSessionDetailPolling());
    await flush();
    expect(api.listSessions).toHaveBeenCalledTimes(1);

    serverStatus = "completed";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await flush();
    // The tick that observed completion still refreshed both list and detail.
    expect(api.listSessions).toHaveBeenCalledTimes(2);
    expect(api.getSessionStats).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    await flush();
    expect(api.listSessions).toHaveBeenCalledTimes(2);
    expect(api.getSessionStats).toHaveBeenCalledTimes(2);
  });

  it("keeps polling sessions waiting on a permission so replies surface", async () => {
    primeStore("waiting_permission");
    renderHook(() => useSessionDetailPolling());
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    });
    await flush();
    expect(api.listPermissions).toHaveBeenCalledTimes(3);
    expect(api.listSessions).toHaveBeenCalledTimes(3);
  });

  it("does not poll without an active selection or while unreachable", async () => {
    primeStore("completed");
    const { unmount } = renderHook(() => useSessionDetailPolling());
    await flush();
    expect(api.listSessions).not.toHaveBeenCalled();
    unmount();

    primeStore("running");
    useApiConnectivityStore.setState({ apiReachable: "unreachable" });
    renderHook(() => useSessionDetailPolling());
    await flush();
    expect(api.listSessions).not.toHaveBeenCalled();
  });

  it("stops scheduling after unmount", async () => {
    const { unmount } = renderHook(() => useSessionDetailPolling());
    await flush();
    expect(api.listSessions).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    });
    await flush();
    expect(api.listSessions).toHaveBeenCalledTimes(1);
  });

  /**
   * Polling must join unfinished transcripts without starving slow responses.
   */
  it("joins the detached transcript instead of issuing an overlapping request", async () => {
    let resolveRuns!: (value: { items: never[] }) => void;
    vi.mocked(api.listRuns).mockReturnValueOnce(
      new Promise((r) => {
        resolveRuns = r;
      }),
    );

    renderHook(() => useSessionDetailPolling());
    await flush();
    expect(api.listRuns).toHaveBeenCalledTimes(1);

    // The list may refresh again, but the slow transcript stays in flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await flush();
    expect(api.listSessions).toHaveBeenCalledTimes(2);
    expect(api.listRuns).toHaveBeenCalledTimes(1);

    resolveRuns({ items: [] });
    await flush();
  });
});

it("shares one poller between consumers and keeps it alive until the last unmount", async () => {
  const first = renderHook(() => useSessionDetailPolling());
  const second = renderHook(() => useSessionDetailPolling());
  await flush();
  expect(api.getSessionStats).toHaveBeenCalledTimes(1);
  first.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  });
  expect(api.getSessionStats).toHaveBeenCalledTimes(2);
  second.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
  });
  expect(api.getSessionStats).toHaveBeenCalledTimes(2);
});
