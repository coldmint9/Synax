import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  clearScheduledSessionRefresh,
  SESSION_INACTIVE_PAGE_CACHE_TTL_MS,
  setSessionDetailsVisible,
  scheduleSessionRefresh,
  useAgentSessionStore as store,
} from "../state/agentSessionStore";
import { EMPTY_STREAMING_BUFFERS } from "../streamingLiveBlocks";
import { SESSION_TAIL_RETAIN } from "../state/sessionTailWindow";
import {
  agentRuntimeApi as api,
  type AgentRuntimeMessage,
  type PermissionDecision,
  type AgentSession,
  type HistoryWindowResponse,
  type SessionStats,
  type ToolCallRecord,
} from "../../../adapters/transport/agentRuntime";
import { RuntimeStreamProjector } from "../../../adapters/transport/runtimeStream";
vi.mock("../../../adapters/transport/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
const session = {
  id: "refresh-session",
  projectId: "p",
  status: "running",
  childSessionIds: [],
} as unknown as AgentSession;
const message = (id: string): AgentRuntimeMessage => ({
  id,
  sessionId: session.id,
  runId: null,
  stepId: null,
  role: "assistant",
  content: id,
  metadata: {},
  createdAt: "2026-01-01T00:00:00Z",
});
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
  clearScheduledSessionRefresh();
  setSessionDetailsVisible(true);
  store.getState().resetSessionDetailForDraft();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(globalThis, "fetch");
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
    "listInputQueue",
  ] as const)
    vi.spyOn(api, key).mockResolvedValue({ items: [] });
});
afterEach(() => {
  const networkCalls = [...vi.mocked(globalThis.fetch).mock.calls];
  // Store resets alone do not clear the coordinator's module-level timer.
  clearScheduledSessionRefresh();
  setSessionDetailsVisible(true);
  store.getState().resetSessionDetailForDraft();
  store.setState(store.getInitialState());
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  expect(networkCalls).toEqual([]);
});
describe("versioned transcript refresh", () => {
  it("opens an uncached historical session from its summary and one window only", async () => {
    store.setState({ projectId: "p", sessions: [] });
    const execution = vi.spyOn(api, "getSession").mockRejectedValue(new Error("execution must remain cold"));
    const summary = vi.spyOn(api, "getSessionSummary").mockResolvedValue({ session: {
      ...session, status: "completed", sessionMetadata: { historyStorage: 3 },
    } });
    const history = vi.spyOn(api, "historyWindow").mockResolvedValue({
      messages: [message("recent")], runs: [], steps: [], toolCalls: [], events: [], permissions: [],
      historyWindow: { epoch: 1, revision: 100, generation: 1, olderCursor: "older", syncCursor: "latest", hasEarlier: true, latest: true, detailsTruncated: false },
    });
    await store.getState().refreshDetail();
    await vi.waitFor(() => expect(store.getState().messages).toHaveLength(1));
    expect(summary).toHaveBeenCalledWith(session.id);
    expect(history).toHaveBeenCalledTimes(1);
    expect(execution).not.toHaveBeenCalled();
    expect(api.listMessages).not.toHaveBeenCalled();
    expect(api.listInputQueue).not.toHaveBeenCalled();
    expect(api.getSessionStats).not.toHaveBeenCalled();
    expect(api.getSessionTodos).not.toHaveBeenCalled();
    expect(api.getSessionInvocationUsage).not.toHaveBeenCalled();
  });
  it("retries a stale latest read without surfacing a transient detail error", async () => {
    const versionedSession = {
      ...session,
      sessionMetadata: { historyStorage: 3 },
    } as AgentSession;
    const window = {
      messages: [], runs: [], steps: [], toolCalls: [], events: [], permissions: [],
      historyWindow: {
        revision: 2, epoch: 1, hasEarlier: false,
        latest: true, detailsTruncated: false,
      },
    } satisfies HistoryWindowResponse;
    store.setState({ sessions: [versionedSession] });
    const fetchWindow = vi.spyOn(api, "historyWindow")
      .mockRejectedValueOnce({ code: "HISTORY_STALE" })
      .mockResolvedValueOnce(window);

    await store.getState().refreshDetail();
    await vi.waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(store.getState().sessionDetailCache[session.id].cachedAt).toBeGreaterThan(0),
    );
    expect(fetchWindow.mock.calls).toEqual([[session.id], [session.id]]);
    expect(store.getState().detailError).toBeNull();
  });

  it("does not retry non-stale latest read errors", async () => {
    const versionedSession = {
      ...session,
      sessionMetadata: { historyStorage: 3 },
    } as AgentSession;
    store.setState({ sessions: [versionedSession] });
    const fetchWindow = vi.spyOn(api, "historyWindow")
      .mockRejectedValueOnce(new Error("offline"));

    await store.getState().refreshDetail();
    await vi.waitFor(() =>
      expect(store.getState().detailError).toContain("offline"),
    );
    expect(fetchWindow).toHaveBeenCalledTimes(1);
  });

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
  it.each([false, true])("keeps all browsed messages and navigation on refresh at the bottom (incremental=%s)", async incremental => {
    const messages = Array.from({ length: 300 }, (_, i) => message(`m${i}`));
    const historyWindow = { revision: 1, generation: 1, epoch: 1, syncCursor: "sync",
      hasEarlier: false, latest: true, detailsTruncated: false };
    store.setState({
      sessions: [{ ...session, sessionMetadata: { historyStorage: 3 } }], messages,
      sessionDetailCache: { [session.id]: {
        messages, runs: [], steps: [], toolCalls: [], events: [], permissions: [],
        sessionStats: null, sessionTodos: [], sessionInvocationUsage: null,
        cachedAt: Date.now(), historyPagesLoaded: true, historyWindow,
        timelineMessages: messages,
      } },
    });
    vi.spyOn(api, "historyWindow").mockResolvedValue({
      messages: incremental ? [message("m300")] : [...messages.slice(-99), message("m300")],
      runs: [], steps: [], toolCalls: [], events: [], permissions: [],
      historyWindow: { ...historyWindow, revision: 2, incremental, syncCursor: "next",
        hasEarlier: !incremental, olderCursor: incremental ? undefined : "recent-boundary" },
    });
    await store.getState().refreshDetail();
    await vi.waitFor(() => expect(store.getState().detailRefreshing).toBe(false));
    const cached = store.getState().sessionDetailCache[session.id];
    expect(store.getState().messages.map(message => message.id)).toEqual([...messages.map(message => message.id), "m300"]);
    expect(cached.timelineMessages?.map(message => message.id)).toEqual(store.getState().messages.map(message => message.id));
    expect(cached.historyWindow?.olderCursor).toBeUndefined();
    expect(cached.historyPagesLoaded).toBe(true);
  });

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
          messages: [message("old")], runs: [], steps: [], toolCalls: [],
          events: [], permissions: [], sessionStats: null, sessionTodos: [],
          sessionInvocationUsage: null, cachedAt: Date.now(), historyPagesLoaded: true,
          historyWindow: { revision: 1, epoch: 1, hasEarlier: false,
            latest: true, detailsTruncated: false },
        },
      },
    });
    vi.spyOn(api, "historyWindow").mockResolvedValue({
      messages: [message("latest")], runs: [], steps: [], toolCalls: [],
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
          messages: [message("discarded")], runs: [], steps: [], toolCalls: [],
          events: [], permissions: [], sessionStats: null, sessionTodos: [],
          sessionInvocationUsage: null, cachedAt: Date.now(), historyPagesLoaded: true,
          historyWindow: { revision: 1, epoch: 1, olderCursor: "old", hasEarlier: true,
            latest: true, detailsTruncated: false },
        },
      },
    });
    vi.spyOn(api, "historyWindow").mockResolvedValue({
      messages: [message("replacement")], runs: [], steps: [], toolCalls: [],
      events: [], permissions: [],
      historyWindow: { revision: 2, epoch: 2, hasEarlier: false, latest: true,
        detailsTruncated: false },
    });

    await store.getState().refreshDetail();
    await vi.waitFor(() => expect(store.getState().messages.map((m) => m.id)).toEqual(["replacement"]));
    expect(store.getState().sessionDetailCache[session.id].historyPagesLoaded).toBeUndefined();
  });
});

describe("session switch loading snapshot", () => {
  it("keeps a cached inactive transcript visible during a background refresh", () => {
    const completed = {
      ...session,
      id: "completed",
      status: "completed",
    } as AgentSession;
    const cachedMessage = { ...message("cached"), sessionId: completed.id };
    store.setState({
      projectId: "p",
      panelOpen: true,
      selectedSessionId: session.id,
      sessions: [session, completed],
      sessionDetailCache: {
        [completed.id]: {
          runs: [], steps: [], events: [], messages: [cachedMessage],
          toolCalls: [], permissions: [], sessionStats: null, sessionTodos: [],
          sessionInvocationUsage: null, cachedAt: 1,
        },
      },
    });
    vi.mocked(api.listMessages).mockImplementationOnce(
      () => new Promise(() => {}),
    );

    store.getState().openPanel(completed.id, { forceFresh: true });
    expect(store.getState().messages.map((item) => item.id)).toEqual(["cached"]);
    expect(store.getState().detailLoading).toBe(false);
    expect(store.getState().detailRefreshing).toBe(true);
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
    await vi.waitFor(() => expect(api.getSessionStats).toHaveBeenCalledOnce());
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
  expect(store.getState().sessionDetailCache[session.id]?.cachedAt ?? 0).toBe(0);
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
  expect(store.getState().sessionDetailCache[session.id]?.cachedAt ?? 0).toBe(0);
});

it("replaces live output only when both persisted steps and messages are ready", async () => {
  const completedStep = { id: "step", runId: "run", status: "completed" } as never;
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
  expect(store.getState().streamingCompletedSteps[0]?.blocks).toEqual([
    { type: "text", content: "Answer" },
  ]);
  const states: Array<{
    snapshot: number;
    messages: number;
    steps: number;
  }> = [];
  const unsubscribe = store.subscribe((s) =>
    states.push({
      snapshot: s.streamingCompletedSteps.length,
      messages: s.messages.length,
      steps: s.steps.length,
    }),
  );
  resolve({
    items: [{ id: "answer", role: "assistant", content: "Answer", stepId: "step", metadata: {} } as never],
  });
  await vi.waitFor(() => expect(store.getState().streamingCompletedSteps).toEqual([]));
  unsubscribe();
  expect(
    states.every((s) => s.snapshot !== 0 || (s.steps === 1 && s.messages === 1)),
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
  await vi.waitFor(() =>
    expect(store.getState().streamingCompletedSteps[0]?.blocks).toEqual([
      { type: "text", content: "Final answer" },
    ]),
  );
  expect(store.getState().streamingStepId).toBeNull();
});

it("retains a completed step's final reply until the matching message is persisted", async () => {
  const step = { id: "step", runId: "run", status: "completed" } as never;
  vi.mocked(api.listSessionSteps).mockResolvedValue({ items: [step] });
  store.setState({
    sessions: [{ ...session, status: "running", activeRunId: "run" }],
  });
  store.getState().applyLiveEvent({
    type: "step_started", stepId: "step", stepIndex: 1,
  });
  store.getState().applyLiveEvent({
    type: "message_delta", stepId: "step", delta: "# Summary\nFinal answer",
  });
  store.getState().applyLiveEvent({
    type: "runtime_state", sessionId: session.id,
    patch: { status: "completed", activeRunId: null },
    reset: true, refresh: false,
  });

  await store.getState().refreshDetail();
  await vi.waitFor(() => expect(store.getState().steps).toEqual([step]));
  expect(store.getState().messages).toEqual([]);
  expect(store.getState().streamingCompletedSteps[0]?.blocks).toEqual([
    { type: "text", content: "# Summary\nFinal answer" },
  ]);

  vi.mocked(api.listMessages).mockResolvedValue({
    items: [{
      id: "final", sessionId: session.id, runId: "run", stepId: "step",
      role: "assistant", content: "# Summary\nFinal answer", metadata: {},
      createdAt: "2026-01-01T00:00:00Z",
    }],
  });
  await store.getState().refreshDetail();
  await vi.waitFor(() => expect(store.getState().streamingCompletedSteps).toEqual([]));
  expect(store.getState().messages).toHaveLength(1);
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
    store.setState({ streamingStepId: "step-1" });
    const call: ToolCallRecord = {
      id: "call-1",
      sessionId: session.id,
      runId: null,
      stepId: "step-1",
      toolId: "file.read",
      category: "file",
      mutability: "read",
      inputSummary: "Read a file",
      outputSummary: null,
      status: "running",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
      error: null,
    };
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

describe("inactive session page cache", () => {
  const cachedEntry = (lastVisitedAt: number, cachedAt = Date.now()) => ({
    runs: [],
    steps: [],
    events: [],
    messages: [],
    toolCalls: [],
    permissions: [],
    sessionStats: null,
    sessionTodos: [],
    sessionInvocationUsage: null,
    cachedAt,
    lastVisitedAt,
  });

  it("reuses a completed page without fetching its transcript again", async () => {
    const completed = { ...session, status: "completed" } as AgentSession;
    store.setState({
      panelOpen: false,
      selectedSessionId: null,
      sessions: [completed],
      sessionDetailCache: { [completed.id]: cachedEntry(Date.now()) },
    });
    vi.mocked(api.listMessages).mockClear();

    store.getState().openPanel(completed.id);
    await Promise.resolve();

    expect(api.listMessages).not.toHaveBeenCalled();
    expect(store.getState().detailLoading).toBe(false);
  });

  it("renders a stale completed page from cache and refreshes it in the background", async () => {
    const completed = { ...session, status: "completed" } as AgentSession;
    store.setState({
      panelOpen: false,
      selectedSessionId: null,
      sessions: [completed],
      sessionDetailCache: {
        [completed.id]: cachedEntry(
          Date.now(),
          Date.now() - SESSION_INACTIVE_PAGE_CACHE_TTL_MS - 1,
        ),
      },
    });

    store.getState().openPanel(completed.id);

    expect(store.getState().detailLoading).toBe(false);
    expect(store.getState().detailRefreshing).toBe(true);
    await vi.waitFor(() => expect(api.listMessages).toHaveBeenCalled());
  });

  it("retains the selected page plus the eight most recently visited inactive pages", async () => {
    const active = {
      ...session,
      id: "active",
      status: "completed",
    } as AgentSession;
    store.setState({
      sessions: [active],
      selectedSessionId: active.id,
      sessionDetailCache: {
        active: cachedEntry(0),
        old: cachedEntry(1),
        recent1: cachedEntry(2),
        recent2: cachedEntry(3),
        recent3: cachedEntry(4),
        recent4: cachedEntry(5),
        recent5: cachedEntry(6),
        recent6: cachedEntry(7),
        recent7: cachedEntry(8),
        recent8: cachedEntry(9),
      },
    });

    await store.getState().fetchSessionStats();

    expect(Object.keys(store.getState().sessionDetailCache).sort()).toEqual(
      ["active", "recent1", "recent2", "recent3", "recent4", "recent5", "recent6", "recent7", "recent8"].sort(),
    );
  });
});

describe('incremental history pages', () => {
  function window(messages: AgentRuntimeMessage[], cursor: string, incremental = false, more = false): HistoryWindowResponse {
    return {messages, runs:[], steps:[], toolCalls:[], events:[], permissions:[],
      historyWindow:{revision:2,epoch:1,generation:1,messageLimit:SESSION_TAIL_RETAIN,syncCursor:cursor,olderCursor:incremental ? undefined : 'older-page',
        incremental,hasMoreChanges:more,hasEarlier:!incremental,latest:true,detailsTruncated:false}};
  }
  it('paints each change page before the next arrives and never refetches cached history', async () => {
    store.setState({sessions:[{...session,sessionMetadata:{historyStorage:3}}]});
    const history = vi.spyOn(api,'historyWindow').mockResolvedValueOnce(window([message('cached')],'sync-1'));
    await store.getState().refreshDetail();
    await vi.waitFor(() => expect(store.getState().messages.map(m=>m.id)).toEqual(['cached']));
    let resolve!: (page: HistoryWindowResponse) => void;
    history.mockResolvedValueOnce(window([message('first-change')],'sync-2',true,true))
      .mockReturnValueOnce(new Promise(r=>{resolve=r;}));
    await store.getState().refreshDetail();
    await vi.waitFor(() => expect(store.getState().messages.map(m=>m.id)).toEqual(['cached','first-change']));
    await vi.waitFor(() => expect(history.mock.calls.slice(1)).toEqual([[session.id,undefined,'sync-1'],[session.id,undefined,'sync-2']]));
    expect(store.getState().detailRefreshing).toBe(true);
    expect(api.listMessages).not.toHaveBeenCalled();
    resolve({...window([message('second-change')],'sync-3',true),removed:[{collection:'messages',id:'first-change'}]});
    await vi.waitFor(() => expect(store.getState().messages.map(m=>m.id)).toEqual(['cached','second-change']));
    expect(store.getState().detailRefreshing).toBe(false);
    expect(store.getState().sessionDetailCache[session.id].historyWindow?.olderCursor).toBe('older-page');
    const pageCount=history.mock.calls.length;
    vi.spyOn(api,'historyIndexPage').mockResolvedValue(window([],'sync-3'));
    vi.mocked(api.historyIndexPage).mockResolvedValue({...window([],'sync-3'),historyWindow:{...window([],'sync-3').historyWindow,olderCursor:undefined,hasEarlier:false}});
    await store.getState().loadTimelineIndex();
    expect(history).toHaveBeenCalledTimes(pageCount);
  });
  it('keeps completed pages when a later change page fails, then resumes at its last cursor', async () => {
    store.setState({sessions:[{...session,sessionMetadata:{historyStorage:3}}]});
    const history=vi.spyOn(api,'historyWindow').mockResolvedValueOnce(window([message('cached')],'sync-1'));
    await store.getState().refreshDetail();
    await vi.waitFor(()=>expect(store.getState().messages).toHaveLength(1));
    history.mockResolvedValueOnce(window([message('saved')],'sync-2',true,true)).mockRejectedValueOnce(new Error('offline'));
    await store.getState().refreshDetail();
    await vi.waitFor(()=>expect(store.getState().detailError).toContain('offline'));
    expect(store.getState().detailRefreshing).toBe(false);
    expect(store.getState().messages.map(m=>m.id)).toEqual(['cached','saved']);
    history.mockResolvedValueOnce(window([],'sync-3',true));
    await store.getState().refreshDetail();
    await vi.waitFor(()=>expect(store.getState().detailError).toBeNull());
    expect(history).toHaveBeenLastCalledWith(session.id,undefined,'sync-2');
  });
  it('stops automatic refresh after a permanent history failure and allows explicit retry', async () => {
    const id='permanent-history';
    store.setState({selectedSessionId:id,sessions:[{...session,id,sessionMetadata:{historyStorage:3}}]});
    const history=vi.spyOn(api,'historyWindow').mockRejectedValueOnce(Object.assign(new Error('record unavailable'),{code:'HISTORY_ENTITY_TOO_LARGE',statusCode:413}));
    await store.getState().refreshDetail();
    await vi.waitFor(()=>expect(store.getState().detailError).toContain('record unavailable'));
    for(let i=0;i<4;i++) await store.getState().refreshDetail({joinPending:true});
    expect(history).toHaveBeenCalledOnce();
    history.mockResolvedValueOnce(window([],'sync-1'));
    await store.getState().refreshDetail({forceFresh:true});
    await vi.waitFor(()=>expect(store.getState().detailError).toBeNull());
    expect(history).toHaveBeenCalledTimes(2);
  });
});

describe("live transcript history requests", () => {
  const page = (messages: AgentRuntimeMessage[] = []): HistoryWindowResponse => ({
    messages, runs: [], steps: [], toolCalls: [], events: [], permissions: [],
    historyWindow: { revision: 1, epoch: 1, generation: 1, syncCursor: "sync-1",
      hasEarlier: false, latest: true, detailsTruncated: false, incremental: false },
  });
  const liveSession = { ...session, activeRunId: "run", sessionMetadata: { historyStorage: 3 } } as AgentSession;

  it("applies complete stream messages without history requests from background invalidations", async () => {
    store.setState({ sessions: [liveSession] });
    const history = vi.spyOn(api, "historyWindow").mockResolvedValue(page(
      Array.from({ length: 130 }, (_, index) => message(`old-${index}`)),
    ));
    await store.getState().refreshDetail();
    await vi.waitFor(() => expect(store.getState().messages).toHaveLength(130));
    vi.useFakeTimers();
    const projector = new RuntimeStreamProjector();
    projector.snapshot({ session: liveSession, run: null, cursor: 0, liveChunks: [], completedStepIds: [] });
    const answer = { ...message("live-answer"), runId: "run", content: "完整回答".repeat(4000),
      metadata: { source: "assistant", custom: "preserved" } };
    for (let sequence = 1; sequence <= 4; sequence++) {
      for (const event of projector.record({ sequence, sessionId: session.id, runId: "run", state: liveSession,
        chunk: { type: "message", message: { ...answer, content: answer.content + sequence } } }))
        store.getState().applyLiveEvent(event, session.id);
      scheduleSessionRefresh(session.id, "detail");
      await vi.advanceTimersByTimeAsync(1200);
    }
    expect(history).toHaveBeenCalledOnce();
    expect(api.getSessionStats).not.toHaveBeenCalled();
    expect(store.getState().messages).toHaveLength(131);
    expect(store.getState().messages[0].id).toBe("old-0");
    expect(store.getState().messages.at(-1)).toEqual({ ...answer, content: answer.content + "4" });
    expect(store.getState().sessionDetailCache[session.id].messages).toEqual(store.getState().messages);
    expect(store.getState().detailRefreshing).toBe(false);
  });

  it("loads a cold live session and permits explicit recovery and terminal reconciliation", async () => {
    store.setState({ sessions: [liveSession] });
    const history = vi.spyOn(api, "historyWindow").mockResolvedValue(page());
    await store.getState().refreshDetail({ background: true });
    await vi.waitFor(() => expect(store.getState().sessionDetailCache[session.id]?.cachedAt).toBeGreaterThan(0));
    await store.getState().refreshDetail({ background: true, joinPending: true });
    expect(history).toHaveBeenCalledOnce();
    await store.getState().refreshDetail({ forceFresh: true, background: true });
    await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    await store.getState().refreshDetail();
    await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(3));
    store.getState().patchSession(session.id, { status: "completed", activeRunId: null });
    await store.getState().refreshDetail({ background: true });
    await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(4));
  });

  it("keeps live records received while the initial history window is in flight", async () => {
    store.setState({ sessions: [liveSession] });
    let resolve!: (value: HistoryWindowResponse) => void;
    vi.spyOn(api, "historyWindow").mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await store.getState().refreshDetail();
    const answer = { ...message("live-answer"), runId: "run" };
    store.getState().applyLiveEvent({ type: "message", message: answer }, session.id);
    resolve(page([message("older")]));
    await vi.waitFor(() => expect(store.getState().detailRefreshing).toBe(false));
    expect(store.getState().messages).toEqual([message("older"), answer]);
    expect(store.getState().sessionDetailCache[session.id].messages).toEqual([message("older"), answer]);
  });

  it("joins a slow initial history request instead of restarting it for every live invalidation", async () => {
    store.setState({ sessions: [liveSession] });
    let resolve!: (value: HistoryWindowResponse) => void;
    const history = vi.spyOn(api, "historyWindow").mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await store.getState().refreshDetail();
    const refreshes = Array.from({ length: 4 }, () => store.getState().refreshDetail({ background: true }));
    expect(history).toHaveBeenCalledOnce();
    resolve(page([message("loaded")]));
    await Promise.all(refreshes);
    expect(store.getState().messages).toEqual([message("loaded")]);
    expect(store.getState().detailLoading).toBe(false);
  });

  it("updates pending and resolved permissions from the stream without a history query", async () => {
    store.setState({ sessions: [liveSession] });
    const history = vi.spyOn(api, "historyWindow").mockResolvedValue(page());
    await store.getState().refreshDetail();
    await vi.waitFor(() => expect(store.getState().sessionDetailCache[session.id]?.cachedAt).toBeGreaterThan(0));
    const projector = new RuntimeStreamProjector();
    projector.snapshot({ session: liveSession, run: null, cursor: 0, liveChunks: [], completedStepIds: [] });
    const permission = { id: "permission", sessionId: session.id, runId: "run", action: "ask", resolvedAt: null } as PermissionDecision;
    for (const event of projector.record({ sequence: 1, sessionId: session.id, runId: "run",
      state: { ...liveSession, status: "waiting_permission" }, chunk: { type: "permission_requested", permission } }))
      store.getState().applyLiveEvent(event, session.id);
    expect(store.getState().permissions).toEqual([permission]);
    const resolved = { ...permission, resolvedAt: "2026-10-21T00:00:01Z" };
    for (const event of projector.record({ sequence: 2, sessionId: session.id, runId: "run",
      state: liveSession, chunk: { type: "permission_resolved", permission: resolved } }))
      store.getState().applyLiveEvent(event, session.id);
    await store.getState().refreshDetail({ background: true });
    expect(store.getState().permissions).toEqual([resolved]);
    expect(store.getState().sessionDetailCache[session.id].permissions).toEqual([resolved]);
    expect(history).toHaveBeenCalledOnce();
  });
});
