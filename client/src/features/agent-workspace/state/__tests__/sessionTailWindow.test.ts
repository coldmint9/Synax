import { afterEach, expect, it, vi } from "vitest";
import { compactSessionTail, setSessionHistoryReading } from "../sessionTailWindow";
import { useAgentSessionStore as store, type SessionDetailCacheEntry } from "../agentSessionStore";
import { mergeRefreshedHistory, prependHistory } from "../historyWindowMerge";
import { historyWindowQuery, unpackHistoryCursor } from "../../../../shared/lib/historyWindowCursor";
import { toPersistedEntry } from "../sessionCache";

function entry(count: number, start = 0): SessionDetailCacheEntry {
  return {
    messages: Array.from({ length: count }, (_, i) => ({
      id: `m${start + i}`, sequence: start + i, sessionId: "s", role: "user", content: `message ${start + i}`,
      runId: null, stepId: null, metadata: {}, createdAt: `t${start + i}`,
    })), runs: [], steps: [], toolCalls: [], events: [], permissions: [],
    cachedAt: Date.now(), sessionStats: null, sessionTodos: [], sessionInvocationUsage: null,
    historyWindow: { revision: 1, generation: 1, epoch: 1, syncCursor: "sync", latest: true,
      hasEarlier: false, detailsTruncated: false },
  };
}
afterEach(() => { setSessionHistoryReading("s", false); store.setState(store.getInitialState()); vi.restoreAllMocks(); });

it("keeps append references through the buffer and evicts once per 61 new rows", () => {
  for (let count = 100; count <= 160; count++) {
    const page = entry(count);
    expect(compactSessionTail(page)).toBe(page);
  }
  const page = entry(161);
  const compacted = compactSessionTail(page);
  expect(compacted.messages).toHaveLength(100);
  expect(compacted.messages[0]).toBe(page.messages[61]);
  expect(compacted.messages.at(-1)).toBe(page.messages[160]);
  expect(compacted.historyWindow?.syncCursor).toBe("sync");
  expect(unpackHistoryCursor(compacted.historyWindow?.olderCursor).before?.rows).toEqual({ messages: "m61" });
});

it("resumes before the retained row even when the original window had no older cursor", () => {
  const original = entry(250);
  const compacted = compactSessionTail(original);
  const query = new URLSearchParams(historyWindowQuery(compacted.historyWindow?.olderCursor));
  expect(JSON.parse(query.get("before")!)).toEqual({ generation: 1, rows: { messages: "m150" } });
  expect(query.has("since")).toBe(false);
  const restored = prependHistory(compacted, { ...entry(150), historyWindow: original.historyWindow! });
  expect(restored.messages).toEqual(original.messages);
  expect(new Set(restored.messages.map(m => m.id)).size).toBe(250);
});

it("retains the runtime cursor for independently paginated collections", () => {
  const original = entry(170);
  original.historyWindow!.olderCursor = "opaque-runtime-cursor";
  const compacted = compactSessionTail(original);
  expect(unpackHistoryCursor(compacted.historyWindow?.olderCursor).cursor).toBe("opaque-runtime-cursor");
  const persisted = toPersistedEntry(compacted, "terminal", 1)!;
  expect(persisted.messages).toHaveLength(100);
  expect(persisted.historyWindow).toEqual(compacted.historyWindow);
});

it("preserves arrays for a sync watermark without changes", () => {
  const previous = entry(100);
  const latest = entry(0);
  latest.historyWindow = { ...latest.historyWindow!, incremental: true, syncCursor: "next" };
  const merged = mergeRefreshedHistory(previous, latest);
  expect(merged.messages).toBe(previous.messages);
  expect(merged.steps).toBe(previous.steps);
  expect(merged.historyWindow?.syncCursor).toBe("next");
});

it("does not evict browsed history, then compacts both cache and painted state on return to tail", () => {
  const page = entry(300);
  store.setState({ ...store.getInitialState(), selectedSessionId: "s", messages: page.messages, sessionDetailCache: { s: page } });
  setSessionHistoryReading("s", true);
  store.getState().compactHistoryTail();
  expect(store.getState().messages).toHaveLength(300);
  setSessionHistoryReading("s", false);
  store.getState().compactHistoryTail();
  expect(store.getState().messages).toHaveLength(100);
  expect(store.getState().messages).toBe(store.getState().sessionDetailCache.s.messages);
});

it("reopens a warm tail immediately without requesting history", () => {
  const page = entry(200);
  const refreshDetail = vi.fn(async () => {});
  store.setState({ ...store.getInitialState(), selectedSessionId: "s", messages: page.messages,
    sessions: [{ id: "s", status: "completed" }, { id: "other", status: "completed" }] as never,
    sessionDetailCache: { s: page, other: entry(0) }, refreshDetail });
  store.getState().openPanel("other");
  const cached = store.getState().sessionDetailCache.s.messages;
  expect(cached).toHaveLength(100);
  store.getState().openPanel("s");
  expect(store.getState().messages).toBe(cached);
  expect(store.getState().detailLoading).toBe(false);
  expect(refreshDetail).not.toHaveBeenCalled();
});

it("uses one state update per live message and only evicts after the buffer fills", () => {
  const page = entry(100);
  store.setState({ ...store.getInitialState(), selectedSessionId: "s", messages: page.messages,
    sessionDetailCache: { s: page } });
  const changed = vi.fn();
  const unsubscribe = store.subscribe(changed);
  try {
    for (let i = 100; i < 160; i++) {
      store.getState().applyLiveEvent({ type: "message", message: entry(1, i).messages[0] }, "s");
      expect(store.getState().messages[0].id).toBe("m0");
    }
    expect(changed).toHaveBeenCalledTimes(60);
    store.getState().applyLiveEvent({ type: "message", message: entry(1, 160).messages[0] }, "s");
    expect(changed).toHaveBeenCalledTimes(61);
    expect(store.getState().messages).toHaveLength(100);
    expect(store.getState().messages[0].id).toBe("m61");
    expect(store.getState().messages).toBe(store.getState().sessionDetailCache.s.messages);
  } finally { unsubscribe(); }
});

it("does not reload a short complete message tail just because another collection has history", () => {
  const page = entry(12);
  page.historyWindow = { ...page.historyWindow!, hasEarlier: true, olderCursor: "events-only", messageLimit: 100 };
  const refreshDetail = vi.fn(async () => {});
  store.setState({ ...store.getInitialState(), sessions: [{ id: "s", status: "completed" }] as never,
    sessionDetailCache: { s: page }, refreshDetail });
  store.getState().openPanel("s");
  expect(store.getState().messages).toBe(page.messages);
  expect(refreshDetail).not.toHaveBeenCalled();
});

it("does not resurrect an evicted message when its old content changes", () => {
  const previous = compactSessionTail(entry(200));
  const update = entry(1);
  update.historyWindow = { ...update.historyWindow!, incremental: true, syncCursor: "next" };
  const merged = mergeRefreshedHistory(previous, update);
  expect(merged.messages).toEqual(previous.messages);
  expect(merged.timelineMessages).toHaveLength(100);
  expect(merged.historyWindow?.syncCursor).toBe("next");
});
