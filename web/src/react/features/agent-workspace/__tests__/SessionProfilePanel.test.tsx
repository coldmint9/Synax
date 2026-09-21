import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { useShellStore } from "../../../state/shellStore";
import { SessionProfilePanel } from "../SessionProfilePanel";
import type {
  AgentRun,
  AgentSession,
  SessionStats,
} from "../../../../lib/api/agentRuntime";

vi.mock("../useProviderNames", async (original) => ({
  ...(await original<typeof import("../useProviderNames")>()),
  useProviderNames: () => [{ id: "provider", label: "Provider" }],
}));
const session = (id = "profile"): AgentSession =>
  ({
    id,
    model: "Claude Sonnet",
    status: "running",
    activeRunId: "run-1",
    sessionMetadata: { backend: { id: "native" } },
  }) as AgentSession;
const stats = (overrides: Partial<SessionStats> = {}): SessionStats => ({
  status: "running",
  roundCount: 3,
  runningDuration: 65000,
  tokenUsage: { input: 80000, output: 40000, total: 120000 },
  context: {
    inputTokens: 21400,
    source: "provider",
    requestId: "request-1",
    measuredAt: "2026-09-21T00:00:00Z",
    latestRequestUsageAvailable: true,
  },
  contextLimit: 200000,
  contextUsedPercent: 10.7,
  toolCallCount: 9,
  activeSubAgentCount: 0,
  ...overrides,
});
function setup(
  overrides: Partial<ReturnType<typeof useAgentSessionStore.getState>> = {},
) {
  useAgentSessionStore.setState({
    selectedSessionId: "profile",
    sessions: [session()],
    sessionStats: stats(),
    ...overrides,
  });
  return render(<SessionProfilePanel sessionId="profile" />);
}
function toggle() {
  return screen.getByRole("button", { name: "运行详情" });
}

describe("SessionProfilePanel mini/detail", () => {
  beforeEach(() => {
    localStorage.clear();
    useShellStore.setState((s) => ({
      preferences: { ...s.preferences, locale: "zh" },
    }));
    useAgentSessionStore.setState({
      sessions: [],
      selectedSessionId: null,
      detailLoading: false,
      sessionStats: null,
      sessionInvocationUsage: null,
      steps: [],
      runs: [],
    });
  });
  afterEach(cleanup);

  it("shows real model, latest context and calls in mini, not cumulative usage or elapsed time", () => {
    setup({ sessionInvocationUsage: { totalCalls: 12, items: [] } });
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Claude Sonnet")).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByText("21.4K")).toBeInTheDocument();
    expect(screen.getByText("/ 200K")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.queryByText("120.0K")).toBeNull();
    expect(screen.queryByText("1:05")).toBeNull();
    expect(screen.queryByText("上下文组成")).toBeNull();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "10.7");
  });

  it("toggles the whole summary, keeps metrics in place and remembers the session choice", () => {
    const first = setup();
    fireEvent.click(screen.getByText("21.4K"));
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("上下文组成")).toBeInTheDocument();
    expect(screen.getAllByText("运行中")).toHaveLength(1);
    expect(
      localStorage.getItem("synax:workspace:disclosure:profile:runtime"),
    ).toBe("true");
    first.unmount();
    setup();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle());
    expect(screen.queryByText("上下文组成")).toBeNull();
  });

  it("shows invocation breakdown only in detail", () => {
    setup({
      sessionInvocationUsage: {
        totalCalls: 3,
        items: [
          {
            kind: "tool",
            id: "browser.click",
            label: "Browser Click",
            callCount: 3,
            lastCalledAt: "2026-09-21T00:00:00Z",
          },
        ],
      },
    });
    expect(screen.queryByText("Browser Click")).toBeNull();
    fireEvent.click(toggle());
    expect(screen.getByText("Browser Click")).toBeInTheDocument();
    expect(screen.getByText("×3")).toBeInTheDocument();
    expect(screen.queryByText("0/42")).toBeNull();
  });

  it("prefers session state to stale statistics and translates it", () => {
    setup({ sessions: [{ ...session(), status: "completed" }] });
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.queryByText("运行中")).toBeNull();
  });

  it.each([
    ["waiting_permission", "待确认", "请在会话中确认操作"],
    ["waiting_input", "待输入", "需要你的补充信息"],
    ["failed", "失败", "执行失败，请查看会话消息"],
    ["interrupted", "已中断", "执行已中断，可在会话中继续"],
  ] as const)("prioritizes %s over context warnings", (status, label, hint) => {
    setup({
      sessions: [{ ...session(), status }],
      sessionStats: stats({ contextLimit: 22000 }),
    });
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(screen.queryByText(/上下文接近上限/)).toBeNull();
  });

  it("marks high usage and clamps the visual meter at capacity", () => {
    setup({ sessionStats: stats({ contextLimit: 20000 }) });
    expect(screen.getByText(/^上下文接近上限 ·/)).toBeInTheDocument();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("meter")).toHaveAttribute(
      "aria-valuetext",
      expect.stringContaining("107"),
    );
  });

  it("does not invent a context limit, provider usage or current data", () => {
    setup({
      sessionStats: stats({
        contextLimitKnown: false,
        context: {
          inputTokens: 21400,
          source: "estimate",
          stale: true,
          requestId: null,
          measuredAt: null,
          latestRequestUsageAvailable: false,
        },
      }),
    });
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByText("/ 200K")).toBeNull();
    expect(screen.getByText("≈21.4K")).toBeInTheDocument();
    expect(screen.getByText("上次上下文")).toBeInTheDocument();
  });

  it("distinguishes a measured zero from missing data", () => {
    setup({
      sessionStats: stats({ context: { ...stats().context!, inputTokens: 0 } }),
      sessionInvocationUsage: { totalCalls: 0, items: [] },
    });
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getAllByText("0")).toHaveLength(2);
  });

  it("keeps loading and missing data honest", () => {
    setup({ sessionStats: null, detailLoading: true });
    expect(screen.getByText("加载中")).toBeInTheDocument();
    expect(screen.queryByRole("meter")).toBeNull();
    act(() => useAgentSessionStore.setState({ detailLoading: false }));
    fireEvent.click(toggle());
    expect(screen.getByText("暂无运行数据")).toBeInTheDocument();
  });

  it("never leaks selected-session usage or disclosure state into a different session", () => {
    const view = setup({
      sessions: [session(), { ...session("other"), model: "Other model" }],
    });
    fireEvent.click(toggle());
    view.rerender(<SessionProfilePanel sessionId="other" />);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Other model")).toBeInTheDocument();
    expect(screen.queryByText("21.4K")).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("uses the executed model rather than composer defaults", () => {
    setup({
      runs: [
        {
          id: "run-1",
          sessionId: "profile",
          startedAt: "2026-09-21T01:00:00Z",
          model: "provider/executed-model",
          metadata: {},
        } as AgentRun,
      ],
    });
    expect(screen.getByText("Provider/executed-model")).toBeInTheDocument();
    expect(screen.queryByText("Claude Sonnet")).toBeNull();
  });

  it("supports English labels and the same disclosure semantics", () => {
    useShellStore.setState((s) => ({
      preferences: { ...s.preferences, locale: "en" },
    }));
    setup();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Context")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Runtime details" }));
    expect(screen.getByText("Context composition")).toBeInTheDocument();
  });

  it("does not show an inspector without a session", () => {
    render(<SessionProfilePanel sessionId={null} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
