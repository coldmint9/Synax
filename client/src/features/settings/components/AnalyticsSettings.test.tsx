import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  agentRuntimeApi,
  type ProjectAnalytics,
  type SessionStats,
} from "../../../adapters/transport/agentRuntime";
import { useShellStore } from "../../../shared/state/shellStore";
import { AnalyticsSettings } from "./AnalyticsSettings";

const now = "2026-10-22T10:00:00.000Z";

const analytics: ProjectAnalytics = {
  projectId: "project-1",
  generatedAt: now,
  pendingBackfill: 0,
  totals: {
    sessions: 2,
    activeSessions: 1,
    steps: 5,
    completedRuns: 2,
    toolCalls: 7,
    tokens: { input: 10_000, output: 2_000, total: 12_000 },
    cache: { inputTokens: 10_000, cacheReadTokens: 4_000, ratio: 0.4 },
    context: {
      totalTokens: 30_000,
      windowTokens: 100_000,
      percent: 30,
      measuredSessions: 2,
    },
    composition: {
      messages: 15_000,
      tools: 9_000,
      mcp: 2_000,
      skills: 2_000,
      system: 2_000,
      total: 30_000,
    },
  },
  models: [
    {
      model: "deepseek-v4-flash",
      sessions: 2,
      steps: 5,
      input: 10_000,
      output: 2_000,
      total: 12_000,
    },
  ],
  tools: [{ toolId: "read_file", calls: 7 }],
  sessions: [
    {
      id: "session-1",
      parentSessionId: null,
      title: "Investigate composer",
      status: "completed",
      updatedAt: now,
      model: "deepseek-v4-flash",
      context: {
        total: 30_000,
        limit: 100_000,
        percent: 30,
        measuredAt: now,
        composition: {
          version: 2,
          messages: 15_000,
          tools: 9_000,
          mcp: 2_000,
          skills: 2_000,
          system: 2_000,
          total: 30_000,
          measuredAt: now,
        },
      },
      analytics: {
        version: 1,
        updatedAt: now,
        steps: 5,
        completedRuns: 2,
        completedRunSteps: 5,
        toolCalls: 7,
        toolCounts: { read_file: 7 },
        usage: {
          input: 10_000,
          output: 2_000,
          reasoning: 0,
          cacheRead: 4_000,
          cacheWrite: 0,
          total: 12_000,
          requests: 5,
          recorded: 5,
          missing: 0,
        },
        models: {
          "deepseek-v4-flash": {
            steps: 5,
            input: 10_000,
            output: 2_000,
            total: 12_000,
          },
        },
        lastStepId: "step-5",
        lastCompletedRunId: "run-2",
      },
    },
    {
      id: "session-2",
      parentSessionId: null,
      title: "Legacy session",
      status: "running",
      updatedAt: now,
      model: null,
      context: null,
      analytics: null,
    },
  ],
};

const stats = {
  roundCount: 5,
  averageStepsPerCompletedRun: 2.5,
  toolCallCount: 7,
  usage: {
    self: { input: 10_000, output: 2_000, cacheRead: 4_000 },
  },
} as unknown as SessionStats;

const usage = {
  totalCalls: 7,
  items: [
    {
      kind: "tool" as const,
      id: "read_file",
      label: "Read file",
      callCount: 7,
      lastCalledAt: now,
    },
  ],
};

describe("AnalyticsSettings", () => {
  beforeEach(() => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "zh" },
    }));
    vi.spyOn(agentRuntimeApi, "getProjectAnalytics").mockResolvedValue(analytics);
    vi.spyOn(agentRuntimeApi, "getSessionStats").mockResolvedValue(stats);
    vi.spyOn(agentRuntimeApi, "getSessionInvocationUsage").mockResolvedValue(
      usage,
    );
  });

  it("renders project totals, composition and session rows", async () => {
    render(<AnalyticsSettings projectId="project-1" />);
    expect(
      await screen.findByRole("heading", { name: "数据统计" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("上下文构成")).toBeInTheDocument();
    expect(screen.getAllByText("deepseek-v4-flash").length).toBeGreaterThan(0);
    expect(screen.getByText("Investigate composer")).toBeInTheDocument();
    expect(screen.getByText("Legacy session")).toBeInTheDocument();
    expect(screen.getAllByText("30.0%").length).toBeGreaterThan(0);
    expect(agentRuntimeApi.getProjectAnalytics).toHaveBeenCalledWith(
      "project-1",
    );
  });

  it("loads the original per-session statistics on demand", async () => {
    const user = userEvent.setup();
    render(<AnalyticsSettings projectId="project-1" />);
    await screen.findByText("Investigate composer");
    await user.click(screen.getByText("Investigate composer"));
    await waitFor(() =>
      expect(agentRuntimeApi.getSessionStats).toHaveBeenCalledWith("session-1"),
    );
    expect(await screen.findByText("运行概况")).toBeInTheDocument();
    expect(screen.getByText("调用分布")).toBeInTheDocument();
    expect(screen.getByText("Read file")).toBeInTheDocument();
  });

  it("asks for a project when none is selected", () => {
    render(<AnalyticsSettings projectId={null} />);
    expect(screen.getByText(/请先在左侧选择一个项目/)).toBeInTheDocument();
  });
});
