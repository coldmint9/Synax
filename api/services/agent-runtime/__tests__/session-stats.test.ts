import { beforeEach, describe, expect, it } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import {
  explorerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";

describe("getSessionStats runningDuration", () => {
  beforeEach(resetAgentRuntimeFixtures);

  it("sums completed agent turn durations instead of session wall clock", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const run = agentRuntimeStore.appendRun({
      id: "run-1",
      sessionId: session.id,
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:05:00.000Z",
      triggerMessageId: null,
      currentStep: 2,
      stopReason: null,
      model: null,
      metadata: {},
    });

    agentRuntimeStore.appendRunStep({
      id: "step-1",
      runId: run.id,
      sessionId: session.id,
      index: 1,
      status: "completed",
      model: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:30.000Z",
      finishReason: "stop",
      metadata: {},
    });
    agentRuntimeStore.appendRunStep({
      id: "step-2",
      runId: run.id,
      sessionId: session.id,
      index: 2,
      status: "completed",
      model: null,
      startedAt: "2026-01-01T00:02:00.000Z",
      completedAt: "2026-01-01T00:03:45.000Z",
      finishReason: "stop",
      metadata: {},
    });

    const stats = agentRuntimeStore.getSessionStats(session.id);
    expect(stats.runningDuration).toBe(90_000 + 105_000);
  });

  it("aggregates ACP usage and context window size from step metadata", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const run = agentRuntimeStore.appendRun({
      id: "run-acp-usage",
      sessionId: session.id,
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:02:00.000Z",
      triggerMessageId: null,
      currentStep: 1,
      stopReason: "end_turn",
      model: "cursor-acp/default",
      metadata: { engine: "acp" },
    });

    agentRuntimeStore.appendRunStep({
      id: "step-acp-usage",
      runId: run.id,
      sessionId: session.id,
      index: 1,
      status: "completed",
      model: "cursor-acp/default",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:02:00.000Z",
      finishReason: "end_turn",
      metadata: {
        engine: "acp",
        usage: {
          inputTokens: 50_000,
          outputTokens: 1_200,
          contextWindowSize: 200_000,
          source: "acp",
        },
      },
    });

    const stats = agentRuntimeStore.getSessionStats(session.id);
    expect(stats.tokenUsage).toEqual({
      input: 50_000,
      output: 1_200,
      total: 50_000,
    });
    expect(stats.contextLimit).toBe(200_000);
    expect(stats.contextUsedPercent).toBe(25);
  });
  it("prefers the provider-configured window over the reported usage window", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const run = agentRuntimeStore.appendRun({
      id: "run-configured-limit",
      sessionId: session.id,
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:02:00.000Z",
      triggerMessageId: null,
      currentStep: 1,
      stopReason: "stop",
      model: null,
      metadata: { contextLimit: 1_000_000 },
    });

    agentRuntimeStore.appendRunStep({
      id: "step-configured-limit",
      runId: run.id,
      sessionId: session.id,
      index: 1,
      status: "completed",
      model: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:02:00.000Z",
      finishReason: "stop",
      metadata: {
        usage: {
          inputTokens: 50_000,
          outputTokens: 100,
          contextWindowSize: 200_000,
        },
      },
    });

    const stats = agentRuntimeStore.getSessionStats(session.id);
    expect(stats.contextLimit).toBe(1_000_000);
    expect(stats.contextUsedPercent).toBe(5);
  });

  it("honours an explicit configured context limit override", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const stats = agentRuntimeStore.getSessionStats(session.id, {
      configuredContextLimit: 1_000_000,
    });
    expect(stats.contextLimit).toBe(1_000_000);
  });
});

describe("usage projection across runs", () => {
  beforeEach(resetAgentRuntimeFixtures);
  it("orders context by real request time, sums cumulative usage and reports missing requests", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const add = (
      runId: string,
      index: number,
      time: string,
      input?: number,
    ) => {
      agentRuntimeStore.appendRun({
        id: runId,
        sessionId: session.id,
        status: "interrupted",
        startedAt: time,
        completedAt: time,
        triggerMessageId: null,
        currentStep: index,
        stopReason: "disconnect",
        model: null,
        metadata: {},
      });
      agentRuntimeStore.appendRunStep({
        id: `step-${runId}`,
        runId,
        sessionId: session.id,
        index,
        status: input === undefined ? "running" : "completed",
        startedAt: time,
        completedAt: null,
        model: null,
        finishReason: null,
        metadata:
          input === undefined
            ? {}
            : {
                usage: {
                  inputTokens: input,
                  outputTokens: 100,
                  reasoningTokens: 80,
                  cachedInputTokens: 50,
                },
              },
      });
    };
    add("old", 17, "2026-09-13T12:00:00Z", 329597);
    add("new", 4, "2026-09-13T13:00:00Z", 403292);
    add("interrupted", 5, "2026-09-13T13:01:00Z");
    const stats = agentRuntimeStore.getSessionStats(session.id);
    expect(stats.context).toMatchObject({
      inputTokens: 403292,
      requestId: "step-new",
      latestRequestUsageAvailable: false,
    });
    expect(stats.usage.self).toEqual({
      input: 732889,
      output: 200,
      reasoning: 160,
      cacheRead: 100,
      cacheWrite: 0,
      total: 733089,
      cacheReadMatched: 100,
      cacheInputMatched: 732889,
      cacheReadRatio: 100 / 732889,
    });
    expect(stats.coverage.self).toEqual({
      requests: 3,
      recorded: 2,
      missing: 1,
      complete: false,
      cacheReadKnown: 2,
      cacheReadUnknown: 1,
      cacheWriteKnown: 0,
      cacheWriteUnknown: 3,
      cacheMatched: 2,
    });
    expect(stats.runningDuration).toBe(0);
  });
});

import {
  projectSessionUsage,
  startAuxUsage,
  finishAuxUsage,
} from "../usage-projection.js";
import { normalizeUsage } from "../../llm-runtime/usage.js";
import { usageFromAcpUpdate } from "../acp-engine/acp-usage.js";

function addUsageStep(
  sessionId: string,
  id: string,
  usage: unknown,
  metadata: Record<string, unknown> = {},
) {
  const time = "2026-09-15T10:00:00Z";
  agentRuntimeStore.appendRun({
    id: `run-${id}`,
    sessionId,
    status: "completed",
    startedAt: time,
    completedAt: time,
    triggerMessageId: null,
    currentStep: 1,
    stopReason: "stop",
    model: null,
    metadata: {},
  });
  agentRuntimeStore.appendRunStep({
    id: `step-${id}`,
    runId: `run-${id}`,
    sessionId,
    index: 1,
    status: "completed",
    model: null,
    startedAt: time,
    completedAt: time,
    finishReason: "stop",
    metadata: { ...metadata, ...(usage === undefined ? {} : { usage }) },
  });
}

describe("cache usage projection", () => {
  beforeEach(resetAgentRuntimeFixtures);
  it("uses matched weighted samples, while unmatched reads still contribute to totals", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    addUsageStep(session.id, "small", {
      raw: {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_cache_hit_tokens: 80,
      },
    });
    addUsageStep(session.id, "large", {
      raw: {
        prompt_tokens: 1000,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 100 },
      },
    });
    addUsageStep(session.id, "read-only", {
      cachedInputTokens: 50,
      cacheWriteTokens: 12,
    });
    addUsageStep(session.id, "legacy-zero", {
      inputTokens: 10000,
      cachedInputTokens: 0,
    });
    addUsageStep(session.id, "missing", undefined);
    const stats = agentRuntimeStore.getSessionStats(session.id);
    expect(stats.usage.self).toEqual({
      input: 11100,
      output: 30,
      total: 11130,
      reasoning: 0,
      cacheRead: 230,
      cacheWrite: 12,
      cacheReadMatched: 180,
      cacheInputMatched: 1100,
      cacheReadRatio: 180 / 1100,
    });
    expect(stats.coverage.self).toEqual({
      requests: 5,
      recorded: 4,
      missing: 1,
      complete: false,
      cacheReadKnown: 3,
      cacheReadUnknown: 2,
      cacheWriteKnown: 1,
      cacheWriteUnknown: 4,
      cacheMatched: 2,
    });
    expect(stats.usage.self.cacheReadRatio).not.toBe((0.8 + 0.1) / 2);
  });
  it("leaves zero-denominator and no-match ratios unknown", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    expect(
      agentRuntimeStore.getSessionStats(session.id).usage.self.cacheReadRatio,
    ).toBeNull();
    addUsageStep(session.id, "zero", {
      source: "acp",
      inputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    });
    const stats = agentRuntimeStore.getSessionStats(session.id);
    expect(stats.usage.self.cacheReadRatio).toBeNull();
    expect(stats.coverage.self).toMatchObject({
      cacheReadKnown: 1,
      cacheWriteKnown: 1,
      cacheMatched: 1,
    });
  });
  it("keeps main/child/auxiliary samples independently inspectable with legacy cumulative totals", () => {
    const parent = agentSessionRuntime.create(explorerSessionInput);
    const child = agentSessionRuntime.create(explorerSessionInput);
    addUsageStep(parent.id, "parent", {
      source: "cli",
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 50,
      cacheWriteTokens: 20,
    });
    addUsageStep(child.id, "child", {
      source: "cli",
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 100,
      cacheWriteTokens: 40,
    });
    const aux = startAuxUsage(parent.id, "fixture");
    finishAuxUsage(
      aux,
      normalizeUsage(
        { inputTokens: 200, outputTokens: 20, cachedInputTokens: 100 },
        { source: "cli" },
      ),
    );
    const stats = projectSessionUsage(parent.id, [child.id]);
    expect(stats.usage.steps.self).toMatchObject({ input: 100, cacheRead: 50 });
    expect(stats.usage.steps.tree).toMatchObject({
      input: 1100,
      cacheRead: 150,
      cacheWrite: 60,
    });
    expect(stats.usage.auxiliary.self).toMatchObject({
      input: 200,
      cacheRead: 100,
    });
    expect(stats.usage.self).toMatchObject({ input: 300, cacheRead: 150 });
    expect(stats.usage.tree).toMatchObject({
      input: 1300,
      cacheRead: 250,
      cacheReadRatio: 250 / 1300,
    });
    expect(stats.coverage.steps.tree.requests).toBe(2);
    expect(stats.coverage.auxiliary.tree.requests).toBe(1);
    expect(stats.context.inputTokens).toBe(100);
  });
  it("does not charge ACP occupancy as a model request or cache sample", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    addUsageStep(session.id, "occupancy", undefined, {
      externalTurn: true,
      engine: "acp",
      contextUsage: usageFromAcpUpdate({ used: 42000, size: 200000 }),
    });
    const stats = agentRuntimeStore.getSessionStats(session.id);
    expect(stats.context).toMatchObject({
      inputTokens: 42000,
      latestRequestUsageAvailable: true,
    });
    expect(stats.usage.self).toMatchObject({
      input: 0,
      output: 0,
      cacheReadRatio: null,
    });
    expect(stats.coverage.self).toMatchObject({
      recorded: 0,
      missing: 1,
      cacheReadKnown: 0,
      cacheMatched: 0,
    });
    expect(stats.contextLimit).toBe(200000);
  });
  it("recognizes explicit CLI source/metadata zeros and leaves invalid old samples unknown", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    addUsageStep(session.id, "codex", {
      source: "codex",
      inputTokens: 10000,
      outputTokens: 20,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
    addUsageStep(
      session.id,
      "claude",
      {
        inputTokens: 10000,
        outputTokens: 20,
        cachedInputTokens: 0,
        cacheWriteTokens: 50,
      },
      { backendId: "claude-code", externalTurn: true },
    );
    addUsageStep(session.id, "invalid", {
      inputTokens: "100",
      cachedInputTokens: -1,
    });
    const stats = agentRuntimeStore.getSessionStats(session.id);
    expect(stats.usage.self).toMatchObject({
      input: 20000,
      cacheRead: 0,
      cacheWrite: 50,
      cacheReadRatio: 0,
    });
    expect(stats.coverage.self).toMatchObject({
      recorded: 2,
      missing: 1,
      cacheReadKnown: 2,
      cacheReadUnknown: 1,
    });
  });
  it("reads normalized persisted usage without mutating old stored records", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const oldUsage = {
      inputTokens: 10000,
      inputTokenDetails: { cacheReadTokens: 0 },
      raw: { prompt_tokens: 10000, prompt_cache_hit_tokens: 8000 },
    };
    addUsageStep(session.id, "old", oldUsage);
    addUsageStep(session.id, "normalized", normalizeUsage(oldUsage));
    const stats = agentRuntimeStore.getSessionStats(session.id);
    expect(stats.usage.self).toMatchObject({
      input: 20000,
      cacheRead: 16000,
      cacheReadRatio: 0.8,
    });
    expect(agentRuntimeStore.getRunStep("step-old").metadata.usage).toEqual(
      oldUsage,
    );
  });
});

describe("status context measurement selection", () => {
  beforeEach(resetAgentRuntimeFixtures);
  const composition = { tools: 100, mcp: 200, skills: 300, messages: 400, total: 1000, measuredAt: "2026-09-15T10:00:00Z" };

  it("uses inclusive provider input rather than text estimates or cumulative usage", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    addUsageStep(session.id, "before", { inputTokens: 100000 });
    addUsageStep(session.id, "compacted", { raw: {
      input_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 300,
    } }, { contextComposition: composition });
    const stats = agentRuntimeStore.getSessionStats(session.id, { configuredContextLimit: 10000 });
    expect(stats.context).toMatchObject({ inputTokens: 1000, source: "provider", stale: false });
    expect(stats.contextComposition).toEqual(composition);
    expect(stats.contextUsedPercent).toBe(10);
    expect(stats.usage.steps.self.cacheReadRatio).toBe(0.6);
  });

  it("uses the new request estimate until usage arrives, then replaces it", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    addUsageStep(session.id, "old", { inputTokens: 90000 });
    addUsageStep(session.id, "pending", undefined, { contextComposition: composition });
    expect(agentRuntimeStore.getSessionStats(session.id).context).toMatchObject({
      inputTokens: 1000, source: "estimate", stale: false, latestRequestUsageAvailable: false,
    });
    agentRuntimeStore.updateRunStep("step-pending", { metadata: { contextComposition: composition, usage: { inputTokens: 1200 } } });
    expect(agentRuntimeStore.getSessionStats(session.id).context).toMatchObject({
      inputTokens: 1200, source: "provider", stale: false, latestRequestUsageAvailable: true,
    });
  });

  it("keeps stale records explicit and never pairs a newer total with old categories", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    addUsageStep(session.id, "old", { inputTokens: 1000 }, { contextComposition: composition });
    addUsageStep(session.id, "new", { inputTokens: 2000 });
    let stats = agentRuntimeStore.getSessionStats(session.id);
    expect(stats.contextComposition).toBeNull();
    expect(stats.context.inputTokens).toBe(2000);
    addUsageStep(session.id, "missing", undefined);
    stats = agentRuntimeStore.getSessionStats(session.id);
    expect(stats.context).toMatchObject({ inputTokens: 2000, source: "provider", stale: true });
  });

  it("rejects inconsistent cache samples but includes explicit zero hits", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    addUsageStep(session.id, "invalid", { raw: { prompt_tokens: 100, prompt_cache_hit_tokens: 200 } });
    addUsageStep(session.id, "zero", { raw: { prompt_tokens: 100, prompt_cache_hit_tokens: 0 } });
    const stats = agentRuntimeStore.getSessionStats(session.id);
    expect(stats.usage.steps.self.cacheReadRatio).toBe(0);
    expect(stats.coverage.steps.self.cacheMatched).toBe(1);
  });

  it("does not imply that the default context window is measured", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    expect(agentRuntimeStore.getSessionStats(session.id).contextLimitKnown).toBe(false);
  });
});

describe("cache statistics API projection", () => {
  beforeEach(resetAgentRuntimeFixtures);
  it("projects raw API evidence and excludes auxiliary samples", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    addUsageStep(session.id, "cached", { raw: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } } });
    addUsageStep(session.id, "miss", { raw: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 0 } } });
    finishAuxUsage(startAuxUsage(session.id, "test"), { raw: { prompt_tokens: 10000, prompt_tokens_details: { cached_tokens: 10000 } } });
    const cache = agentRuntimeStore.getSessionStats(session.id).cache;
    expect(cache.latest).toMatchObject({ stepId: "step-miss", ratio: 0, inputTokens: 1000, cacheReadTokens: 0 });
    expect(cache.session).toMatchObject({ samples: 2, matched: 2, ratio: 0.4, weightedRatio: 80 / 1100 });
  });
  it("keeps in-flight requests out of the missing sample denominator", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    addUsageStep(session.id, "pending-cache", undefined);
    agentRuntimeStore.updateRun("run-pending-cache", { status: "running", completedAt: null });
    agentRuntimeStore.updateRunStep("step-pending-cache", { status: "running", completedAt: null });
    const cache = agentRuntimeStore.getSessionStats(session.id).cache;
    expect(cache.pending).toBe(1);
    expect(cache.session.samples).toBe(0);
    expect(cache.latest).toBeNull();
  });
});
