import { describe, expect, it } from "vitest";
import type { AgentRun, AgentRunStep, AgentSession } from "../contracts.js";
import {
  analyticsFromStats,
  compactedContextUsageSnapshot,
  buildProjectAnalytics,
  contextUsageSnapshot,
  readContextUsage,
  readSessionAnalytics,
  withCompletedRunAnalytics,
  withStepAnalytics,
  withToolCallAnalytics,
} from "../analytics-projection.js";

const now = "2026-10-22T10:00:00.000Z";

function step(overrides: Partial<AgentRunStep> = {}): AgentRunStep {
  return {
    id: "step-1",
    runId: "run-1",
    sessionId: "session-1",
    index: 1,
    status: "running",
    model: "deepseek-v4-flash",
    startedAt: now,
    completedAt: null,
    finishReason: null,
    metadata: {},
    ...overrides,
  };
}

function usage(input: number, output: number, cacheRead = 0) {
  return {
    normalization: {
      version: 1,
      source: "native",
      inputSemantics: "total",
      input: { status: "known", value: input, source: "usage", rawPresent: true },
      output: {
        status: "known",
        value: output,
        source: "usage",
        rawPresent: true,
      },
      reasoning: {
        status: "known",
        value: 0,
        source: "usage",
        rawPresent: true,
      },
      cacheRead: {
        status: "known",
        value: cacheRead,
        source: "usage",
        rawPresent: true,
      },
      cacheWrite: {
        status: "known",
        value: 0,
        source: "usage",
        rawPresent: true,
      },
    },
  };
}

describe("incremental analytics projection", () => {
  it("ignores a running step and folds a terminal step exactly once", () => {
    expect(withStepAnalytics(null, step())).toBeNull();
    const completed = step({
      status: "completed",
      completedAt: now,
      metadata: { usage: usage(1000, 200, 400) },
    });
    const first = withStepAnalytics(null, completed, now)!;
    expect(first.steps).toBe(1);
    expect(first.usage).toMatchObject({
      input: 1000,
      output: 200,
      total: 1200,
      cacheRead: 400,
      requests: 1,
      recorded: 1,
      missing: 0,
    });
    expect(first.models["deepseek-v4-flash"]).toEqual({
      steps: 1,
      input: 1000,
      output: 200,
      total: 1200,
    });
    // A later metadata-only update of the same step must not double count.
    expect(withStepAnalytics(first, completed, now)).toBe(first);
  });

  it("counts usage-less requests as missing instead of inventing tokens", () => {
    const next = withStepAnalytics(
      null,
      step({ status: "failed", completedAt: now }),
      now,
    )!;
    expect(next.steps).toBe(1);
    expect(next.usage).toMatchObject({
      requests: 1,
      recorded: 0,
      missing: 1,
      input: 0,
      total: 0,
    });
  });

  it("completes runs and tool calls idempotently", () => {
    const run = {
      id: "run-1",
      sessionId: "session-1",
      status: "completed",
      startedAt: now,
      completedAt: now,
      triggerMessageId: null,
      currentStep: 2,
      stopReason: null,
      model: null,
      metadata: {},
    } as AgentRun;
    const withRun = withCompletedRunAnalytics(null, run, 2, now)!;
    expect(withRun.completedRuns).toBe(1);
    expect(withRun.completedRunSteps).toBe(2);
    expect(withCompletedRunAnalytics(withRun, run, 2, now)).toBe(withRun);

    const withTool = withToolCallAnalytics(null, "read_file", now);
    expect(withTool.toolCalls).toBe(1);
    expect(withTool.toolCounts).toEqual({ read_file: 1 });
    expect(withTool.updatedAt).toBe(now);
  });

  it("sanitizes and reads the persisted context snapshot", () => {
    const snapshot = contextUsageSnapshot(
      {
        messages: 600,
        tools: 300,
        mcp: 50,
        skills: 50,
        system: 200,
        total: 1200,
        measuredAt: now,
      },
      "step-1",
      200_000,
    )!;
    expect(snapshot.total).toBe(1200);
    expect(snapshot.limit).toBe(200_000);
    expect(snapshot.composition.system).toBe(200);
    expect(readContextUsage(snapshot)).toEqual(snapshot);
    expect(readContextUsage({ ...snapshot, version: 2 })).toBeNull();
    expect(contextUsageSnapshot({ total: 0 }, "step-1")).toBeNull();
  });

  it("scales the last composition for an immediate post-compaction snapshot", () => {
    const previous = contextUsageSnapshot(
      { messages: 600, tools: 300, mcp: 50, skills: 50, system: 200, total: 1200, measuredAt: now },
      "step-1",
      200_000,
    )!;
    const compacted = compactedContextUsageSnapshot(previous, 600, "cmp-step", 200_000, now)!;
    expect(compacted.total).toBe(600);
    expect(compacted.composition.total).toBe(600);
    expect(compacted.composition.messages + compacted.composition.tools + compacted.composition.mcp + compacted.composition.skills + (compacted.composition.system ?? 0)).toBe(600);
    expect(compacted.stepId).toBe("cmp-step");
  });

  it("mirrors authoritative stats into the same incremental shape", () => {
    const analytics = analyticsFromStats({
      roundCount: 3,
      completedRunCount: 1,
      completedRunSteps: 3,
      toolCallCount: 2,
      toolBreakdown: { read_file: 2 },
      modelBreakdown: {
        "deepseek-v4-flash": {
          steps: 3,
          input: 900,
          output: 300,
          total: 1200,
        },
      },
      usage: {
        self: { input: 900, output: 300, reasoning: 0, cacheRead: 200 },
      },
      coverage: { self: { requests: 3, recorded: 3, missing: 0 } },
      lastStepId: "step-3",
      lastCompletedRunId: "run-1",
    });
    expect(analytics.steps).toBe(3);
    expect(analytics.completedRuns).toBe(1);
    expect(analytics.toolCounts).toEqual({ read_file: 2 });
    expect(analytics.usage.cacheRead).toBe(200);
    expect(analytics.lastStepId).toBe("step-3");
    expect(readSessionAnalytics(analytics)).toEqual(analytics);
  });
});

describe("project analytics aggregation", () => {
  const session = {
    id: "session-1",
    projectId: "project-1",
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: "synax",
    status: "completed",
    title: "Investigate",
    prompt: "Investigate",
    contextSnapshotId: null,
    thinkingMode: "fast",
    permissionRules: [],
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    mcpServerIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: {},
  } as unknown as AgentSession;

  it("sums context categories, tokens, cache and model distribution", () => {
    const analytics = withStepAnalytics(
      null,
      step({ status: "completed", completedAt: now, metadata: { usage: usage(1000, 200, 500) } }),
      now,
    )!;
    const contextUsage = {
      version: 1 as const,
      stepId: "step-1",
      total: 1500,
      limit: 10_000,
      composition: {
        version: 2 as const,
        messages: 800,
        tools: 400,
        mcp: 100,
        skills: 100,
        system: 100,
        total: 1500,
        measuredAt: now,
      },
      measuredAt: now,
    };
    const result = buildProjectAnalytics(
      "project-1",
      [{ session, analytics, contextUsage }],
      0,
      now,
    );
    expect(result.totals.sessions).toBe(1);
    expect(result.totals.tokens).toEqual({
      input: 1000,
      output: 200,
      total: 1200,
    });
    expect(result.totals.context).toMatchObject({
      totalTokens: 1500,
      windowTokens: 10_000,
      percent: 15,
      measuredSessions: 1,
    });
    expect(result.totals.composition).toMatchObject({
      messages: 800,
      tools: 400,
      total: 1500,
    });
    expect(result.totals.cache.ratio).toBe(0.5);
    expect(result.models[0]).toMatchObject({
      model: "deepseek-v4-flash",
      total: 1200,
      sessions: 1,
    });
    expect(result.tools).toEqual([]);
    expect(result.sessions[0].context?.percent).toBe(15);
  });
});
