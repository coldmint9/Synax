import { describe, expect, it } from "vitest";
import type { AgentRun, AgentRunStep, AgentSession } from "../contracts.js";
import {
  analyticsFromStats,
  buildProjectAnalytics,
  emptySessionAnalytics,
  measuredContextUsageSnapshot,
  readContextUsage,
  readSessionAnalytics,
  withCompletedRunAnalytics,
  withStepAnalytics,
  withToolCallAnalytics,
  withUserInputAnalytics,
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

function completedRun(id: string): AgentRun {
  return {
    id,
    sessionId: "session-1",
    status: "completed",
    startedAt: now,
    completedAt: now,
    triggerMessageId: null,
    currentStep: 1,
    stopReason: null,
    model: null,
    metadata: {},
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

  it("deduplicates out-of-order step retries after serialization without losing new late steps", () => {
    const a = step({
      id: "step-a",
      status: "completed",
      completedAt: "2026-10-22T10:00:01.000Z",
      metadata: { usage: usage(1000, 200, 400) },
    });
    const b = step({
      id: "step-b",
      status: "failed",
      completedAt: "2026-10-22T10:00:02.000Z",
    });
    const first = withStepAnalytics(null, a, now)!;
    const second = withStepAnalytics(first, b, now)!;
    const restored = readSessionAnalytics(JSON.parse(JSON.stringify(second)))!;
    expect(restored).toEqual(second);
    // A -> B -> late A must not increment tokens, requests, time or model use.
    expect(withStepAnalytics(restored, {
      ...a, metadata: { ...a.metadata, thought: "arrived after step-b" },
    }, now)).toBe(restored);
    expect(restored).toMatchObject({ steps: 2, durationMs: 3000, lastStepId: "step-b" });
    expect(restored.usage).toMatchObject({
      requests: 2, recorded: 1, missing: 1,
      input: 1000, output: 200, total: 1200, cacheRead: 400,
    });
    expect(restored.models["deepseek-v4-flash"]).toEqual({
      steps: 1, input: 1000, output: 200, total: 1200,
    });
    const late = step({
      id: "step-late",
      status: "interrupted",
      startedAt: "2026-10-22T09:00:00.000Z",
      completedAt: "2026-10-22T09:00:01.000Z",
    });
    const withLate = withStepAnalytics(restored, late, now)!;
    expect(withLate).toMatchObject({ steps: 3, durationMs: 4000 });
    expect(withStepAnalytics(withLate, b, now)).toBe(withLate);
    expect(withStepAnalytics(withLate, late, now)).toBe(withLate);
    expect(first.recentStepIds).toEqual(["step-a"]);
  });

  it("deduplicates completed run retries across other runs and reloads", () => {
    const first = withCompletedRunAnalytics(null, completedRun("run-a"), 1, now)!;
    const second = withCompletedRunAnalytics(first, completedRun("run-b"), 2, now)!;
    const restored = readSessionAnalytics(JSON.parse(JSON.stringify(second)))!;
    expect(restored).toEqual(second);
    expect(withCompletedRunAnalytics(restored, {
      ...completedRun("run-a"), metadata: { summary: "late" },
    }, 1, now)).toBe(restored);
    expect(restored).toMatchObject({ completedRuns: 2, completedRunSteps: 3 });
    const withLate = withCompletedRunAnalytics(restored, {
      ...completedRun("run-late"),
      startedAt: "2026-10-22T08:59:00.000Z",
      completedAt: "2026-10-22T09:00:00.000Z",
    }, 3, now)!;
    expect(withLate).toMatchObject({ completedRuns: 3, completedRunSteps: 6 });
    expect(withCompletedRunAnalytics(withLate, completedRun("run-b"), 2, now)).toBe(withLate);
    expect(first.recentCompletedRunIds).toEqual(["run-a"]);
  });

  it.each([1, 2])("seeds dedupe from legacy v%s last IDs without changing existing totals", (version) => {
    const legacy = readSessionAnalytics({
      ...analyticsFromStats({
        roundCount: 1,
        completedRunCount: 1,
        completedRunSteps: 2,
        lastStepId: "step-a",
        lastCompletedRunId: "run-a",
      }),
      version,
    })!;
    expect(legacy.recentStepIds).toBeUndefined();
    expect(legacy.recentCompletedRunIds).toBeUndefined();
    const a = step({ id: "step-a", status: "completed", completedAt: now });
    expect(withStepAnalytics(legacy, a, now)).toBe(legacy);
    expect(withCompletedRunAnalytics(legacy, completedRun("run-a"), 2, now)).toBe(legacy);
    const next = withCompletedRunAnalytics(
      withStepAnalytics(legacy, { ...a, id: "step-b" }, now),
      completedRun("run-b"), 1, now,
    )!;
    expect(withStepAnalytics(next, a, now)).toBe(next);
    expect(withCompletedRunAnalytics(next, completedRun("run-a"), 2, now)).toBe(next);
    expect(next).toMatchObject({ steps: 2, completedRuns: 2, completedRunSteps: 3 });
  });

  it("bounds both retry windows without truncating aggregate totals", () => {
    let analytics = emptySessionAnalytics();
    for (let index = 0; index < 130; index += 1) {
      analytics = withCompletedRunAnalytics(
        withStepAnalytics(analytics, step({
          id: `step-${index}`, status: "completed", completedAt: now,
        }), now),
        completedRun(`run-${index}`), 1, now,
      )!;
    }
    expect(analytics).toMatchObject({ steps: 130, completedRuns: 130, completedRunSteps: 130 });
    expect(analytics.recentStepIds).toHaveLength(128);
    expect(analytics.recentCompletedRunIds).toHaveLength(128);
    expect(analytics.recentStepIds?.[0]).toBe("step-2");
    expect(analytics.recentCompletedRunIds?.[0]).toBe("run-2");
    const restored = readSessionAnalytics(JSON.parse(JSON.stringify(analytics)))!;
    expect(withStepAnalytics(restored, step({
      id: "step-2", status: "completed", completedAt: now,
    }), now)).toBe(restored);
    expect(withCompletedRunAnalytics(restored, completedRun("run-2"), 1, now)).toBe(restored);
  });

  it("sanitizes and bounds persisted retry windows", () => {
    const ids = Array.from({ length: 140 }, (_, index) => `id-${index}`);
    const restored = readSessionAnalytics({
      ...emptySessionAnalytics(),
      lastStepId: "step-last",
      lastCompletedRunId: "run-last",
      recentStepIds: [...ids, "id-139", null, "", 42],
      recentCompletedRunIds: [...ids, null, "id-139", "", false],
    })!;
    expect(restored.recentStepIds).toEqual([...ids.slice(-127), "step-last"]);
    expect(restored.recentCompletedRunIds).toEqual([...ids.slice(-127), "run-last"]);
    expect(readSessionAnalytics(restored)).toEqual(restored);
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

  it("counts user inputs and terminal execution time incrementally", () => {
    const completed = step({
      status: "completed",
      startedAt: "2026-10-22T10:00:00.000Z",
      completedAt: "2026-10-22T10:01:30.000Z",
    });
    const withStep = withStepAnalytics(null, completed, now)!;
    expect(withStep.durationMs).toBe(90_000);
    const withInput = withUserInputAnalytics(withStep, "input-1", now);
    expect(withInput.userInputCount).toBe(1);
    expect(withUserInputAnalytics(withInput, "input-1", now)).toBe(withInput);
  });

  it("stores the provider's usage as the context total and reads it back", () => {
    const snapshot = measuredContextUsageSnapshot(
      {
        messages: 600,
        tools: 300,
        mcp: 50,
        skills: 50,
        system: 200,
        total: 1200,
        measuredAt: now,
      },
      900,
      "step-1",
      200_000,
      now,
    )!;
    expect(snapshot.source).toBe("provider");
    expect(snapshot.total).toBe(900);
    expect(snapshot.limit).toBe(200_000);
    expect(snapshot.measuredAt).toBe(now);
    // The estimate only splits the measured total.
    expect(snapshot.composition.total).toBe(900);
    const parts = [
      snapshot.composition.messages,
      snapshot.composition.tools,
      snapshot.composition.mcp,
      snapshot.composition.skills,
      snapshot.composition.system ?? 0,
    ].reduce((sum, value) => sum + value, 0);
    expect(parts).toBe(900);
    // Rounding corrections land on messages, so it stays within one token.
    expect(snapshot.composition.messages).toBeGreaterThanOrEqual(449);
    expect(snapshot.composition.messages).toBeLessThanOrEqual(450);
    expect(snapshot.composition.system).toBe(150);
    expect(readContextUsage(snapshot)).toEqual(snapshot);

    // Legacy snapshots were local estimates and must never read as usage.
    expect(
      readContextUsage({ ...snapshot, source: undefined }),
    ).toBeNull();
    expect(readContextUsage({ ...snapshot, version: 2 })).toBeNull();
    expect(measuredContextUsageSnapshot({ total: 0 }, 0, "step-1")).toBeNull();
    expect(measuredContextUsageSnapshot({ total: 0 }, 900, "")).toBeNull();
  });

  it("keeps a measured total without inventing a category split", () => {
    const snapshot = measuredContextUsageSnapshot(null, 5_000, "step-1")!;
    expect(snapshot.total).toBe(5_000);
    expect(snapshot.composition.messages).toBe(5_000);
    expect(snapshot.composition.total).toBe(5_000);
    expect(snapshot.limit).toBeNull();
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
    sessionMetadata: { intentCategory: "功能需求" },
  } as unknown as AgentSession;

  it("sums context categories, tokens, cache and model distribution", () => {
    const analytics = withStepAnalytics(
      null,
      step({ status: "completed", completedAt: now, metadata: { usage: usage(1000, 200, 500) } }),
      now,
    )!;
    const withInput = withUserInputAnalytics(analytics, "input-1", now);
    const contextUsage = {
      version: 1 as const,
      source: "provider" as const,
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
      [{ session, analytics: withInput, contextUsage }],
      0,
      now,
    );
    expect(result.totals.sessions).toBe(1);
    expect(result.totals.userInputs).toBe(1);
    expect(result.totals.durationMs).toBe(0);
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
    expect(result.sessions[0].sessionGroup).toBe("功能需求");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      sessionGroup: "功能需求",
      sessions: 1,
      userInputs: 1,
    });
  });

  it("keeps retired sessions in every total without listing them as rows", () => {
    const analytics = withStepAnalytics(
      null,
      step({
        status: "completed",
        completedAt: now,
        metadata: { usage: usage(1000, 200, 500) },
      }),
      now,
    )!;
    const allLive = buildProjectAnalytics(
      "project-1",
      [
        { session, analytics, contextUsage: null },
        { session: { ...session, id: "session-2" }, analytics, contextUsage: null },
        { session: { ...session, id: "session-3" }, analytics, contextUsage: null },
      ],
      0,
      now,
    );
    const withRetired = buildProjectAnalytics(
      "project-1",
      [{ session, analytics, contextUsage: null }],
      0,
      now,
      [
        { row: allLive.sessions.find((row) => row.id === "session-2")!, retiredReason: "archived" },
        { row: allLive.sessions.find((row) => row.id === "session-3")!, retiredReason: "deleted" },
      ],
    );
    // One live row plus one archived and one deleted session must total exactly
    // like the same three sessions while they were all live.
    expect(withRetired.totals.tokens).toEqual(allLive.totals.tokens);
    expect(withRetired.totals.cache).toEqual(allLive.totals.cache);
    expect(withRetired.totals.toolCalls).toBe(allLive.totals.toolCalls);
    expect(withRetired.totals.durationMs).toBe(allLive.totals.durationMs);
    expect(withRetired.totals.userInputs).toBe(allLive.totals.userInputs);
    expect(withRetired.totals.sessions).toBe(allLive.totals.sessions);
    expect(withRetired.totals.archivedSessions).toBe(1);
    expect(withRetired.totals.deletedSessions).toBe(1);
    expect(withRetired.sessions.map((row) => row.id)).toEqual(["session-1"]);
    expect(allLive.totals.archivedSessions).toBe(0);
    expect(allLive.totals.deletedSessions).toBe(0);
  });
});
