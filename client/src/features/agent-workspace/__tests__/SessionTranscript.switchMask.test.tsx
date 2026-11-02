import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../adapters/transport/agentRuntime";
import {
  useAgentSessionStore,
  type SessionDetailCacheEntry,
} from "../state/agentSessionStore";
import {
  SWITCH_TRANSITION_MAX_WAIT_MS,
  SWITCH_TRANSITION_MIN_MS,
} from "../useSwitchTransition";
import { TRANSCRIPT_ENTRY_READY_EVENT } from "../TimelineLazyEntry";
import { SessionTranscript } from "../SessionTranscript";

vi.mock("../../../adapters/transport/sessionLiveClient", () => ({
  ensureSessionLiveSubscription: vi.fn(),
  releaseSessionLiveSubscription: vi.fn(),
}));
vi.mock("../SessionNavigationPanel", () => ({
  SessionNavigationPanel: () => null,
}));
vi.mock("../SessionEnvironmentContext", () => ({
  useSessionWorkspaceEnvironment: () => ({ environment: null }),
}));
vi.mock("../useTranscriptScroll", () => ({
  useTranscriptScroll: vi.fn(() => ({ scrollToBottom: vi.fn() })),
}));
vi.mock("../AgentConversationView", () => ({
  AgentConversationView: ({ messages }: { messages: { id: string; content: string }[] }) => (
    <>
      {/* Stands in for the deferred timeline rows a real session renders. */}
      <div data-session-entry="lazy-entry" data-entry-pending="true" />
      {messages.map((message) => <p key={message.id}>{message.content}</p>)}
    </>
  ),
}));

const sessions = [
  { id: "a", projectId: "p", status: "completed", activeRunId: null, sessionMetadata: {} },
  { id: "b", projectId: "p", status: "completed", activeRunId: null, sessionMetadata: {} },
] as AgentSession[];

const page = (text: string): SessionDetailCacheEntry => ({
  cachedAt: Date.now(),
  runs: [],
  steps: [],
  messages: [{ id: `${text}-m`, role: "assistant", content: text } as never],
  toolCalls: [],
  events: [],
  permissions: [],
  sessionStats: null,
  sessionTodos: [],
  sessionInvocationUsage: null,
  historyWindow: {
    revision: 1,
    epoch: 1,
    hasEarlier: false,
    latest: true,
    detailsTruncated: false,
    syncCursor: "history-1",
  },
});

function mask(container: HTMLElement) {
  const element = container.querySelector(".session-transcript-loading");
  if (!element) throw new Error("mask not rendered");
  return element;
}

function scroll(container: HTMLElement) {
  const element = container.querySelector(".session-chat-scroll");
  if (!element) throw new Error("transcript not rendered");
  return element;
}

/** Report that every deferred row of the new transcript has mounted. */
function mountRows(container: HTMLElement) {
  const node = container.querySelector('[data-session-entry="lazy-entry"]');
  if (!node) throw new Error("row stand-in not rendered");
  node.removeAttribute("data-entry-pending");
  act(() => {
    node.dispatchEvent(
      new CustomEvent(TRANSCRIPT_ENTRY_READY_EVENT, { bubbles: true }),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: "p",
    panelOpen: true,
    sessions,
    selectedSessionId: "a",
    sessionDetailCache: { a: page("answer a"), b: page("answer b") },
    messages: page("answer a").messages,
    detailLoading: false,
    detailRefreshing: false,
    refreshDetail: vi.fn(async () => {}),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

it("resolves a cached switch out of a blur only after every record row mounted", () => {
  const { container } = render(<SessionTranscript />);
  expect(mask(container).getAttribute("data-visible")).toBe("false");

  act(() => {
    useAgentSessionStore.getState().openPanel("b");
  });
  // The cached page is already rendered, so it is blurred rather than hidden
  // behind a placeholder.
  expect(mask(container).getAttribute("data-visible")).toBe("false");
  expect(scroll(container).getAttribute("data-enter")).toBe("switch");
  expect(scroll(container).getAttribute("data-preparing")).toBe("true");

  // Minimum hold alone does not finish the switch: the rows are still pending.
  act(() => vi.advanceTimersByTime(SWITCH_TRANSITION_MIN_MS + 400));
  expect(scroll(container).getAttribute("data-enter")).toBe("switch");

  mountRows(container);
  act(() => vi.advanceTimersByTime(1));
  expect(scroll(container).getAttribute("data-enter")).toBeNull();
  expect(scroll(container).getAttribute("data-preparing")).toBe("false");
});

it("keeps the blur while history is still refreshing, then releases it", () => {
  const { container } = render(<SessionTranscript />);
  act(() => {
    useAgentSessionStore.getState().openPanel("b");
  });
  act(() => useAgentSessionStore.setState({ detailRefreshing: true }));
  mountRows(container);
  act(() => vi.advanceTimersByTime(SWITCH_TRANSITION_MIN_MS + 400));
  expect(scroll(container).getAttribute("data-enter")).toBe("switch");

  act(() => useAgentSessionStore.setState({ detailRefreshing: false }));
  act(() => vi.advanceTimersByTime(1));
  expect(scroll(container).getAttribute("data-enter")).toBeNull();
});

it("releases a switch that never settles at the wait ceiling", () => {
  const { container } = render(<SessionTranscript />);
  act(() => {
    useAgentSessionStore.getState().openPanel("b");
  });
  expect(scroll(container).getAttribute("data-enter")).toBe("switch");
  act(() => vi.advanceTimersByTime(SWITCH_TRANSITION_MAX_WAIT_MS));
  expect(scroll(container).getAttribute("data-enter")).toBeNull();
  expect(scroll(container).getAttribute("data-preparing")).toBe("false");
});

it("keeps the cold-load mask until history arrives", () => {
  useAgentSessionStore.setState({
    sessionDetailCache: {},
    messages: [],
    detailLoading: true,
  });
  const { container } = render(<SessionTranscript />);
  expect(mask(container).getAttribute("data-visible")).toBe("true");
  expect(scroll(container).getAttribute("data-enter")).toBeNull();
  expect(scroll(container).getAttribute("data-preparing")).toBe("true");

  act(() => {
    useAgentSessionStore.setState({
      sessionDetailCache: { a: page("answer a") },
      messages: page("answer a").messages,
      detailLoading: false,
    });
  });
  expect(mask(container).getAttribute("data-visible")).toBe("false");
});
