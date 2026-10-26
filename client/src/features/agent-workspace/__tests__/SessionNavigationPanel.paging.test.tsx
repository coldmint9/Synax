import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { SessionNavigationPanel } from "../SessionNavigationPanel";
import { mergeRefreshedHistory, prependHistory } from "../state/historyWindowMerge";
import { seedTimelineIndex } from "../state/timelineHistoryIndex";
import type { SessionDetailCacheEntry } from "../state/agentSessionStore";

afterEach(() => { cleanup(); store.setState(store.getInitialState(), true); });

it("renders navigation for the current window without fetching older history on mount", () => {
  const loadTimelineIndex = vi.fn();
  const loadOlderHistory = vi.fn();
  const message = { id: "recent", sessionId: "s", runId: null, stepId: null, role: "user" as const, content: "Recent question", metadata: {}, createdAt: "2026-10-22" };
  store.setState({
    ...store.getInitialState(), selectedSessionId: "s", messages: [message],
    loadTimelineIndex, loadOlderHistory,
    sessionDetailCache: { s: {
      messages: [message], runs: [], steps: [], toolCalls: [], events: [], permissions: [],
      cachedAt: Date.now(), sessionStats: null, sessionTodos: [], sessionInvocationUsage: null,
      historyWindow: { epoch: 1, revision: 50, hasEarlier: true, olderCursor: "older", syncCursor: "current", latest: true, detailsTruncated: false },
    } },
  });
  const view = render(<SessionNavigationPanel scrollRootRef={{ current: null }} />);
  expect(view.container.querySelector("nav")).not.toBeNull();
  expect(loadTimelineIndex).not.toHaveBeenCalled();
  expect(loadOlderHistory).not.toHaveBeenCalled();
});

it("keeps three loaded turn markers after returning to the bottom and refreshing the latest window", () => {
  const messages = Array.from({ length: 200 }, (_, i) => ({
    id: `m${i}`, sessionId: "s", sequence: i, runId: null, stepId: null,
    role: [0, 100, 150].includes(i) ? "user" as const : "system" as const,
    content: `Question ${i}`, metadata: {}, createdAt: new Date(i * 1000).toISOString(),
  }));
  const tail: SessionDetailCacheEntry = {
    messages: messages.slice(100), runs: [], steps: [], toolCalls: [], events: [], permissions: [],
    cachedAt: Date.now(), sessionStats: null, sessionTodos: [], sessionInvocationUsage: null,
    historyWindow: { epoch: 1, generation: 1, revision: 1, hasEarlier: true, olderCursor: "older", latest: true, detailsTruncated: false },
  };
  store.setState({ ...store.getInitialState(), selectedSessionId: "s", messages: tail.messages, sessionDetailCache: { s: tail } });
  const view = render(<SessionNavigationPanel scrollRootRef={{ current: null }} />);
  const markers = () => view.container.querySelectorAll(".session-nav-float-mark");
  expect(markers()).toHaveLength(2);
  const loaded = prependHistory(tail, { ...tail, messages: messages.slice(0, 100), historyWindow: { ...tail.historyWindow!, hasEarlier: false, olderCursor: undefined } });
  act(() => store.setState({ messages: loaded.messages, sessionDetailCache: { s: loaded } }));
  expect(markers()).toHaveLength(3);
  act(() => store.getState().compactHistoryTail());
  expect(markers()).toHaveLength(3);
  const latest = { ...tail, ...seedTimelineIndex({ ...tail, historyWindow: tail.historyWindow! }), historyWindow: { ...tail.historyWindow!, revision: 2 } };
  const merged = mergeRefreshedHistory(store.getState().sessionDetailCache.s, latest);
  act(() => store.setState({ messages: merged.messages, sessionDetailCache: { s: merged } }));
  expect(markers()).toHaveLength(3);
  expect(store.getState().messages).toHaveLength(200);
  expect(store.getState().sessionDetailCache.s.historyWindow?.olderCursor).toBeUndefined();
});
