import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));
vi.mock("../useProviderNames", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../useProviderNames")>();
  return {
    ...actual,
    // Keep the network off the unit-test path; the name mapping itself is
    // covered by useProviderNames.test.ts.
    useProviderNames: () => [
      { id: "custom-api:1789630765113", label: "智谱" },
    ] as never,
  };
});
import { SessionStatusCard } from "../SessionWorkspace";
import type {
  AgentSession,
  SessionStats,
} from "../../../../lib/api/agentRuntime";

const stats: SessionStats = {
  roundCount: 32,
  contextComposition: {
    version: 2,
    system: 0,
    tools: 80_000,
    mcp: 120_000,
    skills: 40_000,
    messages: 160_000,
    total: 400_000,
    measuredAt: "2026-09-15T00:00:00Z",
  },
  status: "interrupted",
  tokenUsage: { input: 403292, output: 275308, total: 403292 },
  context: {
    inputTokens: 403292,
    requestId: "latest",
    measuredAt: "2026-09-13T13:00:00Z",
    latestRequestUsageAvailable: false,
  },
  contextLimit: 1000000,
  contextUsedPercent: 40,
  toolCallCount: 132,
  runningDuration: 5000,
  activeSubAgentCount: 0,
  work: { id: "work", status: "closing", remaining: [], reason: "Tasks done" },
  usage: {
    self: {
      input: 6252715,
      output: 275308,
      total: 6528023,
      reasoning: 258078,
      cacheRead: 4506496,
    },
    tree: {
      input: 6900000,
      output: 300000,
      total: 7200000,
      reasoning: 280000,
      cacheRead: 4600000,
    },
  },
  coverage: {
    self: { requests: 39, recorded: 31, missing: 8, complete: false },
    tree: { requests: 71, recorded: 63, missing: 8, complete: false },
  },
};
describe("SessionStatusCard usage boundaries", () => {
  it("uses live Session status rather than a late running stats response", () => {
    render(
      <SessionStatusCard
        stats={{ ...stats, status: "running" }}
        status="completed"
        steps={[]}
        todos={[]}
      />,
    );
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.queryByText("running")).toBeNull();
    expect(screen.queryByText("0:05")).toBeNull();
  });

  it("does not invent context composition when a snapshot is unavailable", () => {
    render(
      <SessionStatusCard
        stats={{
          ...stats,
          contextComposition: null,
          context: {
            inputTokens: null,
            requestId: null,
            measuredAt: null,
            latestRequestUsageAvailable: false,
          },
          contextLimitKnown: false,
        }}
        steps={[]}
        todos={[]}
      />,
    );
    expect(screen.getByText("暂无上下文组成记录")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("40%")).toBeNull();
  });

  it("shows execution rounds and request composition instead of cumulative usage", () => {
    const { container } = render(
      <SessionStatusCard stats={stats} steps={[]} todos={[]} />,
    );
    expect(screen.getByText("运行轮次")).toBeTruthy();
    expect(screen.getByText("32")).toBeTruthy();
    expect(screen.getByText("上下文组成")).toBeTruthy();
    // The track is the whole 1M window and the measured request is 400K, so the
    // four categories split the filled 40% instead of filling the track.
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-context-category]"),
      ).map((bar) => bar.style.width),
    ).toEqual(["8%", "12%", "4%", "16%"]);
    expect(screen.getByText(/400\.0K \/ 1M/)).toBeTruthy();
    for (const label of [
      "当前上下文",
      "本会话累计",
      "含子 Agent",
      "记录不完整：8 个请求缺少 usage",
      "上下文显示最近一次可用记录",
    ]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(screen.queryByText(/工作状态|确认交付或剩余工作/)).toBeNull();
  });

  it("keeps the four categories proportional when the model window is unknown", () => {
    const { container } = render(
      <SessionStatusCard
        stats={{ ...stats, contextLimitKnown: false }}
        steps={[]}
        todos={[]}
      />,
    );
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-context-category]"),
      ).map((bar) => bar.style.width),
    ).toEqual(["20%", "30%", "10%", "40%"]);
  });
  it("renders no elapsed time for a stale running step after the run has ended", () => {
    render(
      <SessionStatusCard
        stats={stats}
        steps={[
          {
            id: "stale",
            runId: "ended",
            sessionId: "session",
            index: 1,
            status: "running",
            model: null,
            startedAt: "2020-01-01T00:00:00Z",
            completedAt: null,
            finishReason: null,
            metadata: {},
          },
        ]}
        todos={[]}
      />,
    );
    expect(screen.queryByText("0:05")).toBeNull();
  });
});

describe("measured context and cache hit rate", () => {
  it("keeps four colors without per-category usage captions", () => {
    const composition = {
      ...stats.contextComposition!,
      version: 2 as const,
      system: 100_000,
      usage: { tools: 30_000, mcp: 20_000, skills: 30_000 },
      total: 500_000,
    };
    const { container } = render(
      <SessionStatusCard
        stats={{
          ...stats,
          contextComposition: composition,
          context: {
            ...stats.context!,
            inputTokens: 500_000,
            source: "estimate",
          },
        }}
        steps={[]}
      />,
    );
    expect(screen.queryByText("系统/其他")).toBeNull();
    expect(screen.getByText("160.0K")).toBeTruthy();
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-context-category]"),
      ).map((bar) => bar.style.width),
    ).toEqual(["8%", "12%", "4%", "16%"]);
    expect(container.querySelector("[data-context-usage]")).toBeNull();
    expect(screen.queryByText(/基础 · 使用 · 占当前上下文/)).toBeNull();
    expect(
      screen.queryByText("使用明细将在下一次模型请求后更新"),
    ).toBeNull();
    expect(
      screen.queryByText("四色显示分类占用；总量含系统提示等基础上下文。"),
    ).toBeNull();
    expect(screen.getByText(/500\.0K \/ 1M/)).toBeTruthy();
    expect(
      screen.getByTitle("当前输入中的用户内容、思考记录和助手纯文本回复"),
    ).toBeTruthy();
  });

  it("does not relabel old mixed message statistics as the new categories", () => {
    render(
      <SessionStatusCard
        stats={{
          ...stats,
          contextComposition: {
            ...stats.contextComposition!,
            version: undefined,
            system: undefined,
          },
        }}
        steps={[]}
      />,
    );
    expect(screen.queryByText("Tools")).toBeNull();
    expect(
      screen.getByText("旧记录未区分调用上下文；分类将在下一次模型请求后更新"),
    ).toBeTruthy();
    expect(screen.getByText(/400\.0K \/ 1M/)).toBeTruthy();
  });
  it("uses measured total and labels proportional categories as approximate", () => {
    const { container } = render(
      <SessionStatusCard
        stats={{
          ...stats,
          context: {
            ...stats.context!,
            inputTokens: 500000,
            source: "provider",
            stale: false,
            latestRequestUsageAvailable: true,
          },
        }}
        steps={[]}
        todos={[]}
      />,
    );
    expect(screen.getByText(/服务商实测 · 500\.0K \/ 1M/)).toBeTruthy();
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>("[data-context-category]"),
      ).map((bar) => bar.style.width),
    ).toEqual(["10%", "15%", "5%", "20%"]);
    expect(screen.getByText("≈100.0K")).toBeTruthy();
  });

  it("shows CLI totals even without a composition snapshot", () => {
    render(
      <SessionStatusCard
        stats={{
          ...stats,
          contextComposition: null,
          context: {
            ...stats.context!,
            inputTokens: 500000,
            source: "provider",
            latestRequestUsageAvailable: true,
          },
        }}
        steps={[]}
        todos={[]}
      />,
    );
    expect(screen.getByText(/服务商实测 · 500\.0K/)).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("50%");
  });

  it("marks stale measurements visibly", () => {
    render(
      <SessionStatusCard
        stats={{
          ...stats,
          context: { ...stats.context!, source: "provider", stale: true },
        }}
        steps={[]}
        todos={[]}
      />,
    );
    expect(screen.getByText("最近一次可用记录；当前请求暂无数据")).toBeTruthy();
  });

  it("does not present legacy totals as a verified cache measurement", () => {
    render(<SessionStatusCard stats={stats} steps={[]} todos={[]} />);
    expect(screen.getByText("最近一次缓存率")).toBeTruthy();
    expect(screen.getByText("平均缓存率（逐轮）")).toBeTruthy();
    expect(screen.queryByText("18.6%")).toBeNull();
  });

  it("shows the context token total in the runtime status header", () => {
    render(<SessionStatusCard stats={stats} steps={[]} todos={[]} />);
    const tokens = screen.getByTitle("当前上下文 Token");
    // The fixture's latest sample is not provider-reported, so the header
    // shows the composition estimate, not the raw 403.3K input tokens.
    expect(tokens.textContent).toBe("400.0K");
  });

  it("prefixes the LLM row with the provider display name", () => {
    const session = {
      id: "s",
      projectId: "p",
      model: "custom-api:1789630765113/glm-5.3",
    } as AgentSession;
    render(
      <SessionStatusCard
        stats={stats}
        session={session}
        steps={[]}
        todos={[]}
      />,
    );
    const row = screen.getByTitle("custom-api:1789630765113/glm-5.3");
    expect(row.textContent).toBe("智谱/glm-5.3");
  });
});
