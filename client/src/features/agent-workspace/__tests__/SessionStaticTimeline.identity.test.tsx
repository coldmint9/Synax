import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionStaticTimeline } from "../SessionStaticTimeline";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { EMPTY_STREAMING_BUFFERS } from "../streamingLiveBlocks";
import type { ConversationTimelineEntry } from "../buildConversationTimeline";
import type { AgentRun, AgentRuntimeMessage, AgentRunStep, AgentSession } from "../../../adapters/transport/agentRuntime";

// Keep the real lazy wrapper: a remount blanks its contents until the browser's
// next IntersectionObserver delivery, which mocked wrappers cannot detect.
vi.mock("../TimelineEntryView", () => ({
  TimelineEntryView: ({ entry }: { entry: ConversationTimelineEntry }) => (
    <details data-testid={entry.id} data-completed-at={entry.kind === "agent" ? entry.turn.completedAt : undefined}>
      <summary>{entry.kind === "user" ? entry.content : entry.id}</summary>
      <span>{entry.kind === "agent" ? JSON.stringify(entry.turn.blocks) : "body"}</span>
    </details>
  ),
}));

class ViewportObserver {
  static instances: ViewportObserver[] = [];
  targets = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) {
    ViewportObserver.instances.push(this);
  }
  observe = (target: Element) => { this.targets.add(target); };
  unobserve = (target: Element) => { this.targets.delete(target); };
  disconnect = () => { this.targets.clear(); };
  static reveal() {
    act(() => {
      for (const observer of this.instances) {
        observer.callback(
          [...observer.targets].map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
          observer as unknown as IntersectionObserver,
        );
      }
    });
  }
}

const session = { id: "s", status: "running" } as AgentSession;
const history = {
  id: "history", sessionId: "s", role: "user", content: "History",
  createdAt: "2026-01-01T00:00:00Z",
} as AgentRuntimeMessage;
const props = {
  unifiedLive: true, session, runs: [{ id: "r", status: "running" } as AgentRun], steps: [], messages: [history],
  toolCalls: [], isRunning: true,
};

function version(revision: number, epoch = 1) {
  act(() => store.setState({
    sessionDetailCache: {
      s: {
        runs: [], steps: [], messages: [history], toolCalls: [], events: [],
        permissions: [], sessionStats: null, sessionTodos: [],
        sessionInvocationUsage: null, cachedAt: 0,
        historyWindow: { revision, epoch, hasEarlier: false, latest: true, detailsTruncated: false },
      },
    },
  }));
}

beforeEach(() => {
  store.setState(store.getInitialState());
  ViewportObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", ViewportObserver);
  version(1);
});
afterEach(() => {
  act(() => store.setState(store.getInitialState()));
  vi.unstubAllGlobals();
});

it("keeps visible history and disclosure state through successive reasoning revisions", () => {
  const { rerender } = render(<SessionStaticTimeline {...props} />);
  ViewportObserver.reveal();
  const original = screen.getByText("History").closest("details")!;
  original.open = true;

  for (let round = 2; round <= 4; round++) {
    act(() => store.setState({
      streamingStepId: `step-${round}`,
      streamingLive: { ...EMPTY_STREAMING_BUFFERS, pendingThinking: `Reasoning ${round}` },
    }));
    rerender(<SessionStaticTimeline {...props} excludeStepId={`step-${round}`} />);
    version(round);
    // Assert before observer delivery: history must never become a placeholder.
    expect(screen.queryByText("History")?.closest("details")).toBe(original);
    expect(original.open).toBe(true);
    act(() => store.setState({
      streamingLive: { ...EMPTY_STREAMING_BUFFERS, pendingThinking: `Reasoning ${round} delta` },
    }));
    expect(screen.queryByText("History")?.closest("details")).toBe(original);
  }

  const next = { ...history, id: "next", content: "Next message" };
  rerender(<SessionStaticTimeline {...props} messages={[history, next]} />);
  version(5);
  expect(screen.queryByText("History")?.closest("details")).toBe(original);
  ViewportObserver.reveal();
  expect(screen.getByText("Next message")).toBeTruthy();
});

it("preserves the live reply through snapshot, persistence and the next reasoning step", () => {
  store.setState({
    streamingStepId: "first",
    streamingLive: { ...EMPTY_STREAMING_BUFFERS, pendingText: "Answer" },
  });
  const { rerender } = render(<SessionStaticTimeline {...props} excludeStepId="first" />);
  const original = screen.getByTestId("first:content:0");
  original.setAttribute("open", "");
  act(() => store.setState({
    streamingStepId: null,
    streamingLive: EMPTY_STREAMING_BUFFERS,
    streamingCompletedSteps: [{ stepId: "first", stepIndex: 1, blocks: [{ type: "text", content: "Answer" }] }],
  }));
  rerender(<SessionStaticTimeline {...props} />);
  expect(screen.queryByTestId("first:content:0")).toBe(original);

  const step = {
    id: "first", sessionId: "s", runId: "r", index: 1, status: "completed",
    startedAt: "2026-01-01T00:00:01Z", completedAt: "2026-01-01T00:00:02Z",
    thinkingText: null, textOutput: "Answer", model: null, error: null,
  } as AgentRunStep;
  const messages = [history, {
    id: "reply", sessionId: "s", runId: "r", stepId: "first",
    role: "assistant", content: "Answer", metadata: {}, createdAt: "2026-01-01T00:00:02Z",
  } as AgentRuntimeMessage];
  act(() => {
    store.setState({ streamingCompletedSteps: [] });
    rerender(<SessionStaticTimeline {...props} steps={[step]} messages={messages} />);
  });
  version(2);
  expect(screen.queryByTestId("first:content:0")).toBe(original);
  expect(original.hasAttribute("open")).toBe(true);
  act(() => store.setState({
    streamingStepId: "second",
    streamingLive: { ...EMPTY_STREAMING_BUFFERS, pendingThinking: "Next reasoning" },
  }));
  rerender(<SessionStaticTimeline {...props} steps={[step]} messages={messages} excludeStepId="second" />);
  expect(screen.queryByTestId("first:content:0")).toBe(original);
});

it.each([false, true])("preserves reply nodes when persisted reasoning changes the block offset (live reasoning: %s)", (hadReasoning) => {
  store.setState({
    streamingStepId: "first",
    streamingLive: {
      ...EMPTY_STREAMING_BUFFERS,
      blocks: hadReasoning ? [{ type: "thinking", content: "Live reasoning" }] : [],
      pendingText: "Answer",
    },
  });
  const { rerender } = render(<SessionStaticTimeline {...props} excludeStepId="first" />);
  const original = screen.getByText(/"content":"Answer"/).closest("details")!;
  original.open = true;
  const step = {
    id: "first", sessionId: "s", runId: "r", index: 1, status: "completed",
    startedAt: "2026-01-01T00:00:01Z", completedAt: "2026-01-01T00:00:02Z",
    thinkingText: hadReasoning ? null : "Persisted reasoning", textOutput: "Answer",
  } as AgentRunStep;
  const reply = {
    id: "reply", sessionId: "s", runId: "r", stepId: "first", role: "assistant",
    content: "Answer", metadata: {}, createdAt: step.completedAt,
  } as AgentRuntimeMessage;
  const reasoning = {
    ...reply, id: "thought", content: "Persisted reasoning",
    createdAt: step.startedAt, metadata: { type: "thinking" },
  } as AgentRuntimeMessage;
  // Match the store's atomic snapshot-to-history handoff.
  act(() => {
    store.setState({ streamingStepId: null, streamingLive: EMPTY_STREAMING_BUFFERS });
    rerender(<SessionStaticTimeline {...props} steps={[step]} messages={hadReasoning ? [history, reply] : [history, reasoning, reply]} />);
  });
  expect(screen.getByText(/"content":"Answer"/).closest("details")).toBe(original);
  expect(original.open).toBe(true);
});

it("updates a completion stamp without remounting an unchanged reply", () => {
  const step = {
    id: "first", sessionId: "s", runId: "r", index: 1, status: "completed",
    startedAt: "2026-01-01T00:00:01Z", completedAt: null,
    thinkingText: null, textOutput: "Answer",
  } as AgentRunStep;
  const messages = [history, {
    id: "reply", sessionId: "s", runId: "r", stepId: "first", role: "assistant",
    content: "Answer", metadata: {}, createdAt: step.startedAt,
  } as AgentRuntimeMessage];
  const { rerender } = render(<SessionStaticTimeline {...props} steps={[step]} messages={messages} />);
  const original = screen.getByText(/"content":"Answer"/).closest("details")!;
  const completedAt = "2026-01-01T00:00:02Z";
  rerender(<SessionStaticTimeline {...props} steps={[{ ...step, completedAt }]} messages={messages} />);
  expect(screen.getByText(/"content":"Answer"/).closest("details")).toBe(original);
  expect(original).toHaveAttribute("data-completed-at", completedAt);
});

it("mounts the initial bottom view without waiting for intersection callbacks", () => {
  render(<SessionStaticTimeline {...props} />);
  expect(screen.getByText("History")).toBeTruthy();
});

it("mounts the bottom of long histories immediately while keeping distant history lazy", () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    ...history,
    id: `history-${index}`,
    content: `History message ${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
  render(<SessionStaticTimeline {...props} messages={messages} />);
  expect(screen.getByText("History message 99")).toBeTruthy();
  expect(screen.queryByText("History message 0")).toBeNull();
  ViewportObserver.reveal();
  expect(screen.getByText("History message 0")).toBeTruthy();
});

it("invalidates mounted history on an epoch rewrite and displays revised content", () => {
  const { rerender } = render(<SessionStaticTimeline {...props} />);
  ViewportObserver.reveal();
  const original = screen.getByText("History").closest("details")!;
  original.open = true;
  version(2, 2);
  rerender(<SessionStaticTimeline {...props} messages={[{ ...history, content: "Rewritten history" }]} />);
  ViewportObserver.reveal();
  const rewritten = screen.getByText("Rewritten history").closest("details")!;
  expect(rewritten).not.toBe(original);
  expect(rewritten.open).toBe(false);
  expect(screen.queryByText("History")).toBeNull();
});
