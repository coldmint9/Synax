import { afterEach, expect, it, vi } from "vitest";
import {
  agentRuntimeApi,
  type HistoryWindowResponse,
} from "../../../../../lib/api/agentRuntime";
import { useAgentSessionStore as store } from "../agentSessionStore";
vi.mock("../../../../../lib/api/agentRuntime", () => ({
  agentRuntimeApi: { historyWindow: vi.fn() },
}));
function windowResult(id: string, latest: boolean): HistoryWindowResponse {
  return {
    messages: [
      {
        id,
        sessionId: "session",
        runId: null,
        stepId: null,
        role: "assistant",
        content: id,
        metadata: {},
        createdAt: "now",
      },
    ],
    runs: [],
    steps: [],
    toolCalls: [],
    events: [],
    permissions: [],
    historyWindow: {
      epoch: 1,
      revision: 2,
      cursor: latest ? undefined : "older",
      olderCursor: "next",
      hasEarlier: true,
      latest,
      detailsTruncated: false,
    },
  };
}
afterEach(() => {
  vi.clearAllMocks();
  store.setState({
    selectedSessionId: null,
    sessionDetailCache: {},
    messages: [],
    detailLoading: false,
  });
});
it("replaces rather than concatenating older and latest windows", async () => {
  store.setState({
    selectedSessionId: "session",
    messages: windowResult("new", true).messages,
  });
  vi.mocked(agentRuntimeApi.historyWindow)
    .mockResolvedValueOnce(windowResult("old", false))
    .mockResolvedValueOnce(windowResult("new", true));
  await store.getState().navigateHistory("older");
  expect(store.getState().messages.map((message) => message.id)).toEqual([
    "old",
  ]);
  expect(
    store.getState().sessionDetailCache.session.historyWindow?.latest,
  ).toBe(false);
  await store.getState().navigateHistory();
  expect(store.getState().messages.map((message) => message.id)).toEqual([
    "new",
  ]);
});
it("resets a stale branch cursor to the latest window", async () => {
  store.setState({ selectedSessionId: "session" });
  vi.mocked(agentRuntimeApi.historyWindow)
    .mockRejectedValueOnce({ code: "HISTORY_STALE" })
    .mockResolvedValueOnce(windowResult("retained-branch", true));
  await store.getState().navigateHistory("discarded-branch");
  expect(agentRuntimeApi.historyWindow).toHaveBeenLastCalledWith("session");
  expect(store.getState().messages[0].id).toBe("retained-branch");
  expect(
    store.getState().sessionDetailCache.session.historyWindow?.latest,
  ).toBe(true);
});
