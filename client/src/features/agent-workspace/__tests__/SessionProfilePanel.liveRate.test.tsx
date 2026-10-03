import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useShellStore } from "../../../shared/state/shellStore";
import { SessionProfilePanel } from "../SessionProfilePanel";
import { resetStreamedTokensForTests } from "../../../shared/lib/streamThroughput";
import { addSessionLiveListener } from "../../../adapters/transport/sessionLiveClient";
import type { AgentSession, SessionStats } from "../../../adapters/transport/agentRuntime";

// The throughput counter sits at the live-stream fan-out; capture the stream
// callback so the test can emit real deltas into it.
const liveHandlers: Array<(event: unknown) => void> = [];
vi.mock("../../../adapters/transport/sessionLive", () => ({
  sessionLiveStream: (
    _sessionId: string,
    onEvent: (event: unknown) => void,
  ) => {
    liveHandlers.push(onEvent);
    return () => {};
  },
}));
vi.mock("../useProviderNames", async (original) => ({
  ...(await original<typeof import("../useProviderNames")>()),
  useProviderNames: () => [{ id: "provider", label: "Provider" }],
}));

const session = {
  id: "profile",
  model: "provider/deepseek-flash",
  status: "running",
  activeRunId: "run-1",
  sessionMetadata: { backend: { id: "native" } },
} as unknown as AgentSession;

const stats = {
  status: "running",
  roundCount: 1,
  runningDuration: 65_000,
  tokenUsage: { input: 80_000, output: 40_000, total: 120_000 },
  context: {
    inputTokens: 21_400,
    source: "provider",
    requestId: "request-1",
    measuredAt: "2026-09-21T00:00:00Z",
    latestRequestUsageAvailable: true,
  },
  contextLimit: 200_000,
  contextUsedPercent: 10.7,
  toolCallCount: 0,
  activeSubAgentCount: 0,
} as unknown as SessionStats;

let unsubscribe: (() => void) | null = null;

/** Subscribe the way the workbench does, then push one delta through it. */
const emit = (event: unknown) => {
  unsubscribe ??= addSessionLiveListener("profile", () => {});
  liveHandlers[liveHandlers.length - 1](event);
};

describe("SessionProfilePanel live token rate", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    resetStreamedTokensForTests();
    liveHandlers.length = 0;
    useShellStore.setState((s) => ({
      preferences: { ...s.preferences, locale: "zh" },
    }));
    useAgentSessionStore.setState({
      ...useAgentSessionStore.getInitialState(),
      selectedSessionId: "profile",
      sessions: [session],
      sessionStats: stats,
    });
  });
  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    cleanup();
    useAgentSessionStore.setState(useAgentSessionStore.getInitialState());
    vi.useRealTimers();
  });

  it("counts real stream deltas into a five-second rate", () => {
    render(<SessionProfilePanel sessionId="profile" />);
    expect(screen.getByText("—")).toBeInTheDocument();

    act(() => {
      emit({ type: "message_delta", stepId: "step-1", delta: "a".repeat(400) });
      vi.advanceTimersByTime(5_000);
    });

    expect(screen.getByText("20.0")).toBeInTheDocument();
    expect(screen.getByText("tokens/s")).toBeInTheDocument();
  });

  it("stops counting once the session is no longer running", () => {
    render(<SessionProfilePanel sessionId="profile" />);
    act(() => {
      emit({ type: "message_delta", stepId: "step-1", delta: "a".repeat(400) });
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("20.0")).toBeInTheDocument();

    act(() => {
      useAgentSessionStore.setState({
        sessions: [{ ...session, status: "completed" } as AgentSession],
        sessionStats: { ...stats, status: "completed" },
      });
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.queryByText("20.0")).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });
});
