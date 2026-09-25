import { afterEach, expect, it, vi } from "vitest";
import { agentRuntimeApi, type HistoryWindowResponse } from "../../../../../lib/api/agentRuntime";
import { useAgentSessionStore as store } from "../agentSessionStore";

vi.mock("../../../../../lib/api/agentRuntime", () => ({
  agentRuntimeApi: { historyWindow: vi.fn() },
}));

function page(ids: string[], olderCursor?: string, cursor?: string, epoch = 1): HistoryWindowResponse {
  return {
    messages: ids.map((id) => ({
      id, sessionId: "session", runId: null, stepId: null, role: "user" as const,
      content: id, metadata: {}, createdAt: id,
    })),
    runs: [], steps: [], toolCalls: [], events: [], permissions: [],
    historyWindow: {
      epoch, revision: 2, cursor, olderCursor, hasEarlier: Boolean(olderCursor),
      latest: !cursor, detailsTruncated: false,
    },
  };
}

function loaded(latest = page(["m3", "m4"], "older")) {
  store.setState({
    ...store.getInitialState(),
    selectedSessionId: "session",
    messages: latest.messages,
    sessionDetailCache: {
      session: {
        runs: [], steps: [], events: [], messages: latest.messages,
        toolCalls: [], permissions: [], sessionStats: null, sessionTodos: [],
        sessionInvocationUsage: null, cachedAt: Date.now(),
        historyWindow: latest.historyWindow,
      },
    },
  });
}

afterEach(() => {
  vi.clearAllMocks();
  store.setState(store.getInitialState());
});

it("prepends older pages without discarding recent messages or duplicating overlap", async () => {
  loaded();
  vi.mocked(agentRuntimeApi.historyWindow).mockResolvedValue(page(["m1", "m2", "m3"], undefined, "older"));
  await store.getState().loadOlderHistory();
  expect(agentRuntimeApi.historyWindow).toHaveBeenCalledWith("session", "older");
  expect(store.getState().messages.map((message) => message.id)).toEqual(["m1", "m2", "m3", "m4"]);
  expect(store.getState().sessionDetailCache.session.historyWindow?.hasEarlier).toBe(false);
  expect(store.getState().sessionDetailCache.session.historyWindow?.latest).toBe(true);
});

it("rebuilds fresh history in order when the latest page already overlaps the oldest loaded message", async () => {
  loaded();
  vi.mocked(agentRuntimeApi.historyWindow)
    .mockRejectedValueOnce({ code: "HISTORY_STALE" })
    .mockResolvedValueOnce(page(["m3", "m5"], "fresh"))
    .mockResolvedValueOnce(page(["m1", "m2"], undefined, "fresh"));
  await store.getState().loadOlderHistory();
  expect(store.getState().messages.map((message) => message.id)).toEqual([
    "m1", "m2", "m3", "m5",
  ]);
});

it("does not load another page after reaching the start", async () => {
  loaded(page(["m1"], undefined));
  await store.getState().loadOlderHistory();
  expect(agentRuntimeApi.historyWindow).not.toHaveBeenCalled();
});

it("ignores results from a previous session", async () => {
  loaded();
  let resolve!: (value: HistoryWindowResponse) => void;
  vi.mocked(agentRuntimeApi.historyWindow).mockReturnValue(new Promise((r) => { resolve = r; }));
  const request = store.getState().loadOlderHistory();
  store.setState({ selectedSessionId: "another" });
  resolve(page(["m1"], undefined, "older"));
  await request;
  expect(store.getState().messages.map((message) => message.id)).toEqual(["m3", "m4"]);
});

it("rebuilds an invalidated cursor from the latest pages and keeps the earlier content", async () => {
  loaded();
  vi.mocked(agentRuntimeApi.historyWindow)
    .mockRejectedValueOnce({ code: "HISTORY_STALE" })
    .mockResolvedValueOnce(page(["m4", "m5"], "c2"))
    .mockResolvedValueOnce(page(["m2", "m3"], "c3", "c2"))
    .mockResolvedValueOnce(page(["m0", "m1"], undefined, "c3"));
  await store.getState().loadOlderHistory();
  expect(vi.mocked(agentRuntimeApi.historyWindow).mock.calls).toEqual([
    ["session", "older"], ["session"], ["session", "c2"], ["session", "c3"],
  ]);
  expect(store.getState().messages.map((message) => message.id)).toEqual([
    "m0", "m1", "m2", "m3", "m4", "m5",
  ]);
});

it("builds every rail point before changing the lazy transcript page", async () => {
  loaded();
  vi.mocked(agentRuntimeApi.historyWindow)
    .mockResolvedValueOnce(page(["m2", "m3"], "oldest", "older"))
    .mockResolvedValueOnce(page(["m1", "m2"], undefined, "oldest"));

  await store.getState().loadTimelineIndex();

  const state = store.getState();
  expect(state.sessionDetailCache.session.timelineMessages?.map((message) => message.id)).toEqual([
    "m1", "m2", "m3", "m4",
  ]);
  expect(state.sessionDetailCache.session.timelineIndexLoaded).toBe(true);
  expect(state.messages.map((message) => message.id)).toEqual(["m3", "m4"]);
  expect(state.sessionDetailCache.session.historyWindow?.olderCursor).toBe("older");
});

it("loads just the pages needed when jumping to an indexed older point", async () => {
  loaded();
  vi.mocked(agentRuntimeApi.historyWindow)
    .mockResolvedValueOnce(page(["m2", "m3"], "oldest", "older"))
    .mockResolvedValueOnce(page(["m1", "m2"], undefined, "oldest"));

  expect(await store.getState().loadHistoryUntil("m2")).toBe(true);
  expect(store.getState().messages.map((message) => message.id)).toEqual(["m2", "m3", "m4"]);
  expect(vi.mocked(agentRuntimeApi.historyWindow).mock.calls).toEqual([["session", "older"]]);
  expect(await store.getState().loadHistoryUntil("m1")).toBe(true);
  expect(store.getState().messages.map((message) => message.id)).toEqual(["m1", "m2", "m3", "m4"]);
});
