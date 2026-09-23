import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { useOlderTranscriptHistory } from "../useOlderTranscriptHistory";

function Harness({ active = true }: { active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const messages = store((state) => state.messages);
  const { loading, error, retry } = useOlderTranscriptHistory(ref, "session", active);
  return (
    <div ref={ref} aria-label="Transcript">
      {loading && <span>Loading</span>}
      {error && <button onClick={() => void retry()}>Retry</button>}
      {messages.map((message) => <p key={message.id}>{message.content}</p>)}
    </div>
  );
}

function seed() {
  const messages = ["m3", "m4"].map((id) => ({
    id, sessionId: "session", runId: null, stepId: null,
    role: "user" as const, content: id, metadata: {}, createdAt: id,
  }));
  store.setState({
    ...store.getInitialState(), selectedSessionId: "session", messages,
    sessionDetailCache: {
      session: {
        messages, runs: [], steps: [], toolCalls: [], events: [], permissions: [],
        sessionStats: null, sessionTodos: [], sessionInvocationUsage: null,
        cachedAt: Date.now(),
        historyWindow: { revision: 1, epoch: 1, olderCursor: "older", hasEarlier: true,
          latest: true, detailsTruncated: false },
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  store.setState(store.getInitialState());
});

it("loads at the top and keeps the visible position after prepending messages", async () => {
  seed();
  const load = vi.fn(async () => {
    store.setState((state) => ({
      messages: [
        { ...state.messages[0], id: "m1", content: "m1" },
        ...state.messages,
      ],
      sessionDetailCache: {
        ...state.sessionDetailCache,
        session: {
          ...state.sessionDetailCache.session,
          historyWindow: { ...state.sessionDetailCache.session.historyWindow!, olderCursor: undefined, hasEarlier: false },
        },
      },
    }));
  });
  store.setState({ loadOlderHistory: load });
  const { container, rerender } = render(<Harness active={false} />);
  const viewport = screen.getByLabelText("Transcript");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, get: () => viewport.querySelectorAll("p").length * 100 },
    clientHeight: { configurable: true, value: 100 },
  });
  viewport.scrollTop = 150;
  rerender(<Harness />);
  act(() => {
    viewport.scrollTop = 20;
    fireEvent.scroll(viewport);
  });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  expect(container).toHaveTextContent("m1m3m4");
  expect(viewport.scrollTop).toBe(120);
});

it("automatically fills an initially unscrollable window", async () => {
  seed();
  const load = vi.fn(async () => {});
  store.setState({ loadOlderHistory: load });
  const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 100 });
  try {
    render(<Harness />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  } finally {
    if (originalHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalHeight);
    else delete (HTMLElement.prototype as unknown as { clientHeight?: number }).clientHeight;
  }
});

it("offers an explicit retry after an older page fails", async () => {
  seed();
  const load = vi.fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(undefined);
  store.setState({ loadOlderHistory: load });
  const { rerender } = render(<Harness active={false} />);
  const viewport = screen.getByLabelText("Transcript");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 300 },
    clientHeight: { configurable: true, value: 100 },
  });
  rerender(<Harness />);
  fireEvent.scroll(viewport);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});
