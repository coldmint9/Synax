import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { EMPTY_STREAMING_BUFFERS } from "../streamingLiveBlocks";
import {
  agentRuntimeApi as api,
  type AgentSession,
  type HistoryWindowResponse,
  type SessionStats,
} from "../../../../lib/api/agentRuntime";
vi.mock("../../../../lib/api/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
const session = {
  id: "refresh-session",
  projectId: "p",
  status: "running",
  childSessionIds: [],
} as unknown as AgentSession;
const stats = (status: "running" | "completed") =>
  ({
    status,
    runningDuration: 1000,
    tokenUsage: { input: 1, output: 1, total: 2 },
    contextLimit: 1000,
    contextUsedPercent: 0,
    toolCallCount: 0,
    activeSubAgentCount: 0,
  }) as SessionStats;
beforeEach(() => {
  store.setState({
    ...store.getInitialState(),
    sessions: [session],
    selectedSessionId: session.id,
  });
  vi.spyOn(api, "getSessionStats").mockResolvedValue(stats("completed"));
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
  ] as const)
    vi.spyOn(api, key).mockResolvedValue({ items: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  store.setState(store.getInitialState());
});
describe("versioned transcript refresh", () => {
  it("loads the latest page instead of retaining a previously cached history cursor", async () => {
    const versionedSession = {
      ...session,
      sessionMetadata: { historyStorage: 3 },
    } as AgentSession;
    const window = {
      messages: [], runs: [], steps: [], toolCalls: [], events: [], permissions: [],
      historyWindow: {
        revision: 1, epoch: 1, cursor: "latest-page", hasEarlier: true,
        latest: true, detailsTruncated: false,
      },
    } satisfies HistoryWindowResponse;
    store.setState({
      sessions: [versionedSession],
      sessionDetailCache: {
        [session.id]: {
          runs: [], steps: [], events: [], messages: [], toolCalls: [], permissions: [],
          sessionStats: null, sessionTodos: [], sessionInvocationUsage: null,
          cachedAt: Date.now(),
          historyWindow: { ...window.historyWindow, cursor: "old-page", latest: false },
        } as never,
      },
    });
    const fetchWindow = vi.spyOn(api, "historyWindow").mockResolvedValue(window);

    await store.getState().refreshDetail();
    await vi.waitFor(() => expect(fetchWindow).toHaveBeenCalledWith(session.id));
    expect(fetchWindow).not.toHaveBeenCalledWith(session.id, "old-page");
    await vi.waitFor(() =>
      expect(store.getState().sessionDetailCache[session.id].historyWindow?.latest).toBe(true),
    );
  });
});

describe("loaded history across refreshes", () => {
  it("keeps browsed older pages when the latest window refreshes in the same epoch", async () => {
    const versioned = { ...session, sessionMetadata: { historyStorage: 3 } } as AgentSession;
    const older = { id: "old", content: "old" } as never;
    const recent = { id: "recent", content: "recent" } as never;
    store.setState({
      sessions: [versioned],
      sessionDetailCache: {
        [session.id]: {
          messages: [older, recent], runs: [], steps: [], toolCalls: [], events: [],
          permissions: [], sessionStats: null, sessionTodos: [], sessionInvocationUsage: null,
          cachedAt: Date.now(), historyPagesLoaded: true,
          historyWindow: { revision: 1, epoch: 1, olderCursor: "earliest-cursor",
            hasEarlier: true, latest: true, detailsTruncated: false },
        },
      },
    });
    const response = {
      messages: [recent, { id: "new", content: "new" } as never],
      runs: [], steps: [], toolCalls: [], events: [], permissions: [],
      historyWindow: { revision: 2, epoch: 1, olderCursor: "newer-cursor",
        hasEarlier: true, latest: true, detailsTruncated: false },
    } satisfies HistoryWindowResponse;
    vi.spyOn(api, "historyWindow").mockResolvedValue(response);

    await store.getState().refreshDetail();
    await vi.waitFor(() => expect(store.getState().messages.map((m) => m.id)).toEqual([
      "old", "recent", "new",
    ]));
    expect(store.getState().sessionDetailCache[session.id].historyWindow?.olderCursor).toBe("earliest-cursor");
  });

  it("restarts from the latest cursor if new messages have no overlap with loaded history", async () => {
    const versioned = { ...session, sessionMetadata: { historyStorage: 3 } } as AgentSession;
    store.setState({
      sessions: [versioned],
      sessionDetailCache: {
        [session.id]: {
          messages: [{ id: "old" } as never], runs: [], steps: [], toolCalls: [],
          events: [], permissions: [], sessionStats: null, sessionTodos: [],
          sessionInvocationUsage: null, cachedAt: Date.now(), historyPagesLoaded: true,
          historyWindow: { revision: 1, epoch: 1, hasEarlier: false,
            latest: true, detailsTruncated: false },
        },
      },
    });
    vi.spyOn(api, "historyWindow").mockResolvedValue({
      messages: [{ id: "latest" } as never], runs: [], steps: [], toolCalls: [],
      events: [], permissions: [],
      historyWindow: { revision: 2, epoch: 1, olderCursor: "bridge", hasEarlier: true,
        latest: true, detailsTruncated: false },
    });

    await store.getState().refreshDetail();
    await vi.waitFor(() => expect(store.getState().messages.map((m) => m.id)).toEqual(["latest"]));
    expect(store.getState().sessionDetailCache[session.id].historyWindow?.olderCursor).toBe("bridge");
  });

  it("drops browsed pages when the history epoch changes", async () => {
    const versioned = { ...session, sessionMetadata: { historyStorage: 3 } } as AgentSession;
    store.setState({
      sessions: [versioned],
      sessionDetailCache: {
        [session.id]: {
          messages: [{ id: "discarded" } as never], runs: [], steps: [], toolCalls: [],
          events: [], permissions: [], sessionStats: null, sessionTodos: [],
          sessionInvocationUsage: null, cachedAt: Date.now(), historyPagesLoaded: true,
          historyWindow: { revision: 1, epoch: 1, olderCursor: "old", hasEarlier: true,
            latest: true, detailsTruncated: false },
        },
      },
    });
    vi.spyOn(api, "historyWindow").mockResolvedValue({
      messages: [{ id: "replacement" } as never], runs: [], steps: [], toolCalls: [],
      events: [], permissions: [],
      historyWindow: { revision: 2, epoch: 2, hasEarlier: false, latest: true,
        detailsTruncated: false },
    });

    await store.getState().refreshDetail();
    await vi.waitFor(() => expect(store.getState().messages.map((m) => m.id)).toEqual(["replacement"]));
    expect(store.getState().sessionDetailCache[session.id].historyPagesLoaded).toBeUndefined();
  });
});

describe("detail refresh freshness", () => {
  it("performs a trailing refresh when completion arrives during a running stats request", async () => {
    let resolve!: (value: SessionStats) => void;
    vi.mocked(api.getSessionStats).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const first = store.getState().refreshDetail();
    store.getState().patchSession(session.id, { status: "completed" });
    const trailing = store.getState().refreshDetail();
    resolve(stats("running"));
    await Promise.all([first, trailing]);
    expect(api.getSessionStats).toHaveBeenCalledTimes(2);
    expect(store.getState().sessionStats?.status).toBe("completed");
  });
  it("does not let a detached old transcript response replace a newer one", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.listMessages>>) => void;
    vi.mocked(api.listMessages)
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        }),
      )
      .mockResolvedValueOnce({
        items: [{ id: "new", content: "newest" } as never],
      });
    await store.getState().refreshDetail();
    await store.getState().refreshDetail();
    resolve({ items: [{ id: "old", content: "stale" } as never] });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().messages.map((message) => message.id)).toEqual([
      "new",
    ]);
  });
});

it("does not mark a profile-only cache entry as a loaded transcript", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.listMessages>>) => void;
  vi.mocked(api.listMessages).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await store.getState().refreshDetail();
  expect(store.getState().sessionDetailCache[session.id].cachedAt).toBe(0);
  expect(store.getState().detailLoading).toBe(true);
  resolve({ items: [] });
  await vi.waitFor(() => expect(store.getState().detailLoading).toBe(false));
  expect(
    store.getState().sessionDetailCache[session.id].cachedAt,
  ).toBeGreaterThan(0);
});

it("retains existing content and exposes failure instead of permanently loading", async () => {
  vi.mocked(api.listMessages).mockRejectedValueOnce(new Error("offline"));
  await store.getState().refreshDetail();
  await vi.waitFor(() =>
    expect(store.getState().detailError).toContain("offline"),
  );
  expect(store.getState().detailLoading).toBe(false);
  expect(store.getState().sessionDetailCache[session.id].cachedAt).toBe(0);
});

it("replaces live output only when both persisted steps and messages are ready", async () => {
  const completedStep = { id: "step", status: "completed" } as never;
  store.setState({
    sessions: [{ ...session, status: "completed" }],
    streamingStepId: "step",
    streamingLive: { ...EMPTY_STREAMING_BUFFERS, pendingText: "Answer" },
  });
  let resolve!: (value: Awaited<ReturnType<typeof api.listMessages>>) => void;
  vi.mocked(api.listSessionSteps).mockResolvedValue({ items: [completedStep] });
  vi.mocked(api.listMessages).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await store.getState().refreshDetail();
  expect(store.getState().steps).toEqual([]);
  expect(store.getState().streamingLive.pendingText).toBe("Answer");
  const states: Array<{
    live: string | null;
    messages: number;
    steps: number;
  }> = [];
  const unsubscribe = store.subscribe((s) =>
    states.push({
      live: s.streamingStepId,
      messages: s.messages.length,
      steps: s.steps.length,
    }),
  );
  resolve({
    items: [{ id: "answer", content: "Answer", stepId: "step" } as never],
  });
  await vi.waitFor(() => expect(store.getState().streamingStepId).toBeNull());
  unsubscribe();
  expect(
    states.every((s) => s.live !== null || (s.steps === 1 && s.messages === 1)),
  ).toBe(true);
});

it("keeps a completed answer when an older in-flight transcript response lands", async () => {
  store.setState({
    streamingStepId: "step",
    streamingLive: { ...EMPTY_STREAMING_BUFFERS, pendingText: "Final answer" },
  });
  let resolve!: (value: Awaited<ReturnType<typeof api.listMessages>>) => void;
  vi.mocked(api.listMessages).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await store.getState().refreshDetail();
  store.getState().patchSession(session.id, { status: "completed" });
  resolve({ items: [] });
  await store.getState().refreshDetail({ joinPending: true });
  expect(store.getState().streamingStepId).toBe("step");
  expect(store.getState().streamingLive.pendingText).toBe("Final answer");
});

it("does not refresh transcript freshness when an optional profile fetch completes later", async () => {
  let resolve!: (value: SessionStats) => void;
  vi.mocked(api.getSessionStats).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = store.getState().refreshDetail();
  await vi.waitFor(() =>
    expect(
      store.getState().sessionDetailCache[session.id]?.cachedAt,
    ).toBeGreaterThan(0),
  );
  const cachedAt = store.getState().sessionDetailCache[session.id].cachedAt;
  resolve(stats("completed"));
  await pending;
  expect(store.getState().sessionDetailCache[session.id].cachedAt).toBe(
    cachedAt,
  );
});

it("lets polling join a slow transcript without repeatedly invalidating its result", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.listMessages>>) => void;
  vi.mocked(api.listMessages).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await store.getState().refreshDetail();
  const poll = store.getState().refreshDetail({ joinPending: true });
  expect(api.listMessages).toHaveBeenCalledTimes(1);
  resolve({ items: [{ id: "slow-but-valid", content: "done" } as never] });
  await poll;
  expect(store.getState().messages[0].id).toBe("slow-but-valid");
});

it("rejects an old response after switching A → B → A", async () => {
  vi.spyOn(api, "listInputQueue").mockResolvedValue({ items: [] });
  const other = { ...session, id: "other" };
  store.setState({
    projectId: "p",
    panelOpen: true,
    sessions: [session, other],
  });
  let resolve!: (value: Awaited<ReturnType<typeof api.listMessages>>) => void;
  vi.mocked(api.listMessages)
    .mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    )
    .mockResolvedValueOnce({
      items: [{ id: "b-current", sessionId: "other" } as never],
    })
    .mockResolvedValueOnce({
      items: [{ id: "a-current", sessionId: session.id } as never],
    });
  await store.getState().refreshDetail();
  store.getState().openPanel(other.id);
  await vi.waitFor(() =>
    expect(store.getState().messages[0]?.id).toBe("b-current"),
  );
  store.getState().openPanel(session.id);
  await vi.waitFor(() =>
    expect(store.getState().messages[0]?.id).toBe("a-current"),
  );
  resolve({ items: [{ id: "a-stale" } as never] });
  await Promise.resolve();
  await Promise.resolve();
  expect(store.getState().messages[0].id).toBe("a-current");
});

describe("invocation usage live refresh", () => {
  it("debounces new tool calls and does not refetch for updates to the same call", async () => {
    vi.useFakeTimers();
    try {
      store.setState({ streamingStepId: "step-1" });
      const call = {
        id: "call-1",
        stepId: "step-1",
        toolId: "file.read",
      } as never;
      store.getState().applyLiveEvent({
        type: "tool_call",
        stepId: "step-1",
        toolCall: call,
      });
      store.getState().applyLiveEvent({
        type: "tool_call",
        stepId: "step-1",
        toolCall: call,
      });

      expect(api.getSessionInvocationUsage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(api.getSessionInvocationUsage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles invocation usage immediately when a run becomes terminal", async () => {
    store.getState().applyLiveEvent({
      type: "runtime_state",
      sessionId: session.id,
      patch: { status: "completed" },
      reset: true,
      refresh: false,
    });
    await vi.waitFor(() =>
      expect(api.getSessionInvocationUsage).toHaveBeenCalledTimes(1),
    );
  });
});
