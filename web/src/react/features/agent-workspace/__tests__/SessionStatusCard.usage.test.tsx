import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));
vi.mock("../useProviderNames", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../useProviderNames")>();
  return {
    ...actual,
    // Keep the network off the unit-test path; the name mapping itself is
    // covered by useProviderNames.test.ts.
    useProviderNames: () =>
      [{ id: "custom-api:1789630765113", label: "智谱" }] as never,
  };
});
import { contextUsage } from "../ContextCompositionBar";
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
    source: "provider",
    requestId: "latest",
    measuredAt: "2026-09-13T13:00:00Z",
    latestRequestUsageAvailable: true,
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
    expect(screen.getByText("暂无供应商数据")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("40%")).toBeNull();
  });

  it("shows provider input rather than estimated categories or cumulative usage", () => {
    const { container } = render(
      <SessionStatusCard stats={stats} steps={[]} />,
    );
    expect(screen.getByText("运行轮次")).toBeTruthy();
    expect(screen.getByText("32")).toBeTruthy();
    expect(screen.getByText("上下文用量")).toBeTruthy();
    expect(screen.getByText(/服务商实测 · 403\.3K \/ 1M/)).toBeTruthy();
    expect(container.querySelector("[data-context-category]")).toBeNull();
    expect(screen.queryByText("Tools")).toBeNull();
    expect(screen.getByRole("img").firstElementChild).toHaveStyle({
      width: "40.33%",
    });
    expect(screen.queryByText(/6\.3M/)).toBeNull();
  });

  it("shows measured tokens without inventing a percentage for an unknown window", () => {
    render(
      <SessionStatusCard
        stats={{ ...stats, contextLimitKnown: false }}
        steps={[]}
      />,
    );
    expect(screen.getByText("服务商实测 · 403.3K")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText(/\/ 1M/)).toBeNull();
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
  it.each([undefined, "estimate"] as const)(
    "ignores old composition and unverified %s totals",
    (source) => {
      const { container } = render(
        <SessionStatusCard
          stats={{
            ...stats,
            context: {
              ...stats.context!,
              source,
              latestRequestUsageAvailable: false,
            },
          }}
          steps={[]}
        />,
      );
      expect(screen.getByText("暂无供应商数据")).toBeTruthy();
      expect(screen.queryByText(/400\.0K|403\.3K/)).toBeNull();
      expect(screen.queryByRole("img")).toBeNull();
      expect(container.querySelector("[data-context-category]")).toBeNull();
    },
  );

  it("does not apportion provider totals to locally estimated categories", () => {
    const { container } = render(
      <SessionStatusCard
        stats={{
          ...stats,
          context: { ...stats.context!, inputTokens: 500000 },
        }}
        steps={[]}
      />,
    );
    expect(screen.getByText(/服务商实测 · 500\.0K \/ 1M/)).toBeTruthy();
    expect(container.querySelector("[data-context-category]")).toBeNull();
    expect(screen.queryByText(/≈/)).toBeNull();
    expect(screen.getByRole("img").firstElementChild).toHaveStyle({
      width: "50%",
    });
  });

  it("shows provider zero rather than falling back to category estimates", () => {
    render(
      <SessionStatusCard
        stats={{ ...stats, context: { ...stats.context!, inputTokens: 0 } }}
        steps={[]}
      />,
    );
    expect(screen.getByText(/服务商实测 · 0 \/ 1M/)).toBeTruthy();
    expect(screen.getByTitle("最近请求上下文 Token").textContent).toBe("0");
    expect(screen.getByRole("img").firstElementChild).toHaveStyle({
      width: "0%",
    });
  });

  it("clamps only the meter, never the provider total", () => {
    render(
      <SessionStatusCard
        stats={{
          ...stats,
          context: { ...stats.context!, inputTokens: 1500000 },
        }}
        steps={[]}
      />,
    );
    expect(screen.getByText(/服务商实测 · 1\.50M \/ 1M/)).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain(
      "150%",
    );
    expect(screen.getByRole("img").firstElementChild).toHaveStyle({
      width: "100%",
    });
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
    expect(
      screen.getByText("上次请求的供应商数据；当前请求暂无数据"),
    ).toBeTruthy();
    expect(screen.getByTitle("上次请求上下文 Token").textContent).toBe(
      "上次 · 403.3K",
    );
  });

  it("does not present legacy totals as a verified cache measurement", () => {
    render(<SessionStatusCard stats={stats} steps={[]} todos={[]} />);
    expect(screen.getByText("最近一次缓存率")).toBeTruthy();
    expect(screen.getByText("平均缓存率（逐轮）")).toBeTruthy();
    expect(screen.queryByText("18.6%")).toBeNull();
  });

  it("shows the context token total in the runtime status header", () => {
    render(<SessionStatusCard stats={stats} steps={[]} todos={[]} />);
    const tokens = screen.getByTitle("最近请求上下文 Token");
    expect(tokens.textContent).toBe("403.3K");
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

describe("provider-only context selection", () => {
  it.each([null, -1, NaN, Infinity, 1.5])(
    "rejects invalid provider count %s",
    (inputTokens) => {
      expect(contextUsage({ ...stats.context!, inputTokens }).available).toBe(
        false,
      );
    },
  );
  it("accepts a legacy sample only with explicit reported-usage availability", () => {
    expect(
      contextUsage({ ...stats.context!, source: undefined }),
    ).toMatchObject({ available: true, total: 403292 });
    expect(
      contextUsage({ ...stats.context!, source: "estimate" }).available,
    ).toBe(false);
    expect(contextUsage(undefined).available).toBe(false);
  });
});
