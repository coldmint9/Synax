import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentSessionStore as store } from "../state/agentSessionStore";
import { useOlderTranscriptHistory } from "../useOlderTranscriptHistory";

function Harness({ active = true }: { active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const messages = store((state) => state.messages);
  const { loading, settling, error, retry } = useOlderTranscriptHistory(ref, "session", active);
  return (
    <div ref={ref} aria-label="Transcript">
      {loading && <span>Loading</span>}
      <span data-testid="settling" data-settling={settling ? "true" : "false"} />
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
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    fireEvent.wheel(viewport, { deltaY: -100 });
    fireEvent.scroll(viewport);
  });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  expect(container).toHaveTextContent("m1m3m4");
  expect(viewport.scrollTop).toBe(120);
});

it("prefills an unscrollable window without a reading gesture", async () => {
  seed();
  const load = vi.fn(async () => {});
  store.setState({ loadOlderHistory: load });
  const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 100 });
  try {
    render(<Harness />);
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(load).toHaveBeenCalledWith({ retainViewport: true });
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
  fireEvent.wheel(viewport, { deltaY: -100 });
  fireEvent.scroll(viewport);
  const retry = await screen.findByRole("button", { name: "Retry" });
  for (let i = 0; i < 5; i++) fireEvent.scroll(viewport);
  expect(load).toHaveBeenCalledTimes(1);
  fireEvent.click(retry);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

it("prefetches within one viewport of the start and preserves scrolling during the request", async () => {
  seed();
  let complete!: () => void;
  const load = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  store.setState({ loadOlderHistory: load });
  const { rerender } = render(<Harness active={false} />);
  const viewport = screen.getByLabelText("Transcript");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, get: () => viewport.querySelectorAll("p").length * 1000 },
    clientHeight: { configurable: true, value: 600 },
  });
  viewport.scrollTop = 1400;
  rerender(<Harness />);
  act(() => {
    viewport.scrollTop = 500;
    fireEvent.wheel(viewport, { deltaY: -100 });
    fireEvent.scroll(viewport);
  });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  act(() => {
    viewport.scrollTop = 300;
    fireEvent.wheel(viewport, { deltaY: -100 });
    fireEvent.scroll(viewport);
    fireEvent.wheel(viewport, { deltaY: -100 });
    fireEvent.scroll(viewport);
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    store.setState((state) => ({
      messages: [{ ...state.messages[0], id: "m1", content: "m1" }, ...state.messages],
      sessionDetailCache: {
        session: {
          ...state.sessionDetailCache.session,
          historyWindow: { ...state.sessionDetailCache.session.historyWindow!, olderCursor: undefined, hasEarlier: false },
        },
      },
    }));
    complete();
  });
  expect(viewport.scrollTop).toBe(1300);
});

it("continues filling after short pages without another gesture", async () => {
  seed();
  const complete: Array<() => void> = [];
  const load = vi.fn(() => new Promise<void>((resolve) => { complete.push(resolve); }));
  store.setState({ loadOlderHistory: load });
  const { rerender } = render(<Harness active={false} />);
  const viewport = screen.getByLabelText("Transcript");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, get: () => viewport.querySelectorAll("p").length * 100 },
    clientHeight: { configurable: true, value: 600 },
  });
  rerender(<Harness />);
  fireEvent.wheel(viewport, { deltaY: -100 });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  act(() => store.setState((state) => ({
    messages: [{ ...state.messages[0], id: "m2", content: "m2" }, ...state.messages],
    sessionDetailCache: {
      session: {
        ...state.sessionDetailCache.session,
        historyWindow: { ...state.sessionDetailCache.session.historyWindow!, olderCursor: "oldest" },
      },
    },
  })));
  // The store can publish its new cursor before the original promise settles.
  await act(async () => { complete[0](); await new Promise(requestAnimationFrame); });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await act(async () => {
    store.setState((state) => ({
      sessionDetailCache: {
        session: {
          ...state.sessionDetailCache.session,
          historyWindow: { ...state.sessionDetailCache.session.historyWindow!, olderCursor: undefined, hasEarlier: false },
        },
      },
    }));
    complete[1]();
  });
  expect(load).toHaveBeenCalledTimes(2);
});

it("prefills at the bottom when less than two screens are scrollable", async () => {
  seed();
  const load = vi.fn(async () => {});
  store.setState({ loadOlderHistory: load });
  const { rerender } = render(<Harness active={false} />);
  const viewport = screen.getByLabelText("Transcript");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 650 },
    clientHeight: { configurable: true, value: 600 },
  });
  viewport.scrollTop = 50;
  rerender(<Harness />);
  fireEvent.scroll(viewport);
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(load).toHaveBeenCalledWith({ retainViewport: true });
});

it("waits for a visible viewport before loading history", async () => {
  seed();
  const load = vi.fn(async () => {});
  store.setState({ loadOlderHistory: load });
  render(<Harness />);
  const viewport = screen.getByLabelText("Transcript");
  fireEvent.scroll(viewport);
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(load).not.toHaveBeenCalled();
});

it("does not retry a stalled prefill on repeated upward gestures", async () => {
  seed();
  const load = vi.fn(async () => {});
  store.setState({ loadOlderHistory: load });
  const { rerender } = render(<Harness active={false} />);
  const viewport = screen.getByLabelText("Transcript");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 630 },
    clientHeight: { configurable: true, value: 600 },
  });
  viewport.scrollTop = 30;
  rerender(<Harness />);
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(load).toHaveBeenCalledTimes(1);
  viewport.scrollTop = 0;
  fireEvent.wheel(viewport, { deltaY: -100 });
  fireEvent.scroll(viewport);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
});

it("does not fetch history after a resize or programmatic scroll", async () => {
  seed();
  const load = vi.fn(async () => {});
  store.setState({ loadOlderHistory: load });
  const { rerender } = render(<Harness active={false} />);
  const viewport = screen.getByLabelText("Transcript");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 600 },
  });
  viewport.scrollTop = 0;
  rerender(<Harness />);
  fireEvent.scroll(viewport);
  fireEvent(window, new Event("resize"));
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(load).not.toHaveBeenCalled();
  fireEvent.keyDown(viewport, { key: "PageUp" });
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
});

it("stops prefilling at two scrollable screens and keeps the bottom pin", async () => {
  seed();
  const load = vi.fn(async () => {
    store.setState(state => ({
      messages: [{ ...state.messages[0], id: "m1", content: "m1" }, ...state.messages],
      sessionDetailCache: { session: { ...state.sessionDetailCache.session,
        historyWindow: { ...state.sessionDetailCache.session.historyWindow!, olderCursor: "oldest" } } },
    }));
  });
  store.setState({ loadOlderHistory: load });
  const { rerender } = render(<Harness active={false} />);
  const viewport = screen.getByLabelText("Transcript");
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, get: () => viewport.querySelectorAll("p").length * 600 },
    clientHeight: { configurable: true, value: 600 },
  });
  const reading = vi.fn();
  viewport.addEventListener("transcript-history-reading", reading);
  viewport.scrollTop = 600;
  rerender(<Harness />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  await act(async () => { await new Promise(requestAnimationFrame); });
  expect(viewport.scrollHeight - viewport.clientHeight).toBe(1200);
  expect(load).toHaveBeenCalledWith({ retainViewport: true });
  expect(reading).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledTimes(1);
});

it("keeps the loading state until the prepended page has settled in the DOM", async () => {
  vi.useFakeTimers();
  const settlement = () => screen.getByTestId("settling").dataset.settling;
  try {
    seed();
    let complete!: () => void;
    const load = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    store.setState({ loadOlderHistory: load });
    const { rerender } = render(<Harness active={false} />);
    const viewport = screen.getByLabelText("Transcript");
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, get: () => viewport.querySelectorAll("p").length * 100 },
      clientHeight: { configurable: true, value: 100 },
    });
    viewport.scrollTop = 20;
    rerender(<Harness />);
    fireEvent.wheel(viewport, { deltaY: -100 });
    fireEvent.scroll(viewport);
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(load).toHaveBeenCalledTimes(1);
    expect(settlement()).toBe("false");
    // The request ending is not the page landing: while a row still reserves
    // height the reader keeps the loading state instead of a bare gap.
    const mounting = document.createElement("div");
    mounting.dataset.entryPending = "true";
    viewport.appendChild(mounting);
    await act(async () => {
      store.setState((state) => ({
        messages: [{ ...state.messages[0], id: "m1", content: "m1" }, ...state.messages],
      }));
      complete();
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(settlement()).toBe("true");
    mounting.remove();
    await act(async () => { await vi.advanceTimersByTimeAsync(120); });
    expect(settlement()).toBe("false");
  } finally {
    vi.useRealTimers();
  }
});
