import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { SessionNavigationPanel } from "../SessionNavigationPanel";

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
