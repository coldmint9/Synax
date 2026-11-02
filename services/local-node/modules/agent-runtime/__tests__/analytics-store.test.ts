import { beforeEach, describe, expect, it } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import {
  explorerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";

const now = "2026-10-22T10:00:00.000Z";

const usage = {
  normalization: {
    version: 1,
    source: "native",
    inputSemantics: "total",
    input: { status: "known", value: 1000, source: "usage", rawPresent: true },
    output: {
      status: "known",
      value: 200,
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
      value: 400,
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

describe("incremental analytics persistence", () => {
  beforeEach(resetAgentRuntimeFixtures);

  it("retains out-of-order step/run dedupe through persistence and hydration", async () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const completedAt = "2026-10-22T10:00:01.000Z";
    for (const suffix of ["a", "b"]) {
      agentRuntimeStore.appendRun({
        id: `run-${suffix}`,
        sessionId: session.id,
        status: "running",
        startedAt: now,
        completedAt: null,
        triggerMessageId: null,
        currentStep: 1,
        stopReason: null,
        model: "deepseek-v4-flash",
        metadata: {},
      });
      agentRuntimeStore.appendRunStep({
        id: `step-${suffix}`,
        runId: `run-${suffix}`,
        sessionId: session.id,
        index: 1,
        status: "completed",
        model: "deepseek-v4-flash",
        startedAt: now,
        completedAt,
        finishReason: null,
        metadata: { usage },
      });
      agentRuntimeStore.updateRun(`run-${suffix}`, { status: "completed", completedAt });
    }
    const before = agentRuntimeStore.getSession(session.id).sessionMetadata?.runtimeAnalytics;
    expect(before).toMatchObject({
      steps: 2,
      durationMs: 2000,
      completedRuns: 2,
      completedRunSteps: 2,
      usage: { requests: 2, recorded: 2, input: 2000, output: 400, total: 2400 },
      recentStepIds: ["step-a", "step-b"],
      recentCompletedRunIds: ["run-a", "run-b"],
    });
    await agentRuntimeStore.flushSession(session.id);
    agentRuntimeStore.reset();
    await agentRuntimeStore.hydrateSession(session.id, true);

    for (const suffix of ["a", "b", "a"]) {
      agentRuntimeStore.updateRunStep(`step-${suffix}`, {
        metadata: { usage, thought: "late terminal metadata" },
      });
      agentRuntimeStore.updateRun(`run-${suffix}`, { metadata: { summary: "late" } });
    }
    expect(agentRuntimeStore.getSession(session.id).sessionMetadata?.runtimeAnalytics).toEqual(before);
    await agentRuntimeStore.flushSession(session.id);
  });

  it("folds terminal steps, completed runs and tool calls into session metadata", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    agentRuntimeStore.appendRun({
      id: "run-1",
      sessionId: session.id,
      status: "running",
      startedAt: now,
      completedAt: null,
      triggerMessageId: null,
      currentStep: 1,
      stopReason: null,
      model: "deepseek-v4-flash",
      metadata: {},
    });
    agentRuntimeStore.appendRunStep({
      id: "step-1",
      runId: "run-1",
      sessionId: session.id,
      index: 1,
      status: "running",
      model: "deepseek-v4-flash",
      startedAt: now,
      completedAt: null,
      finishReason: null,
      metadata: {},
    });
    expect(
      agentRuntimeStore.getSession(session.id).sessionMetadata?.runtimeAnalytics,
    ).toBeUndefined();

    agentRuntimeStore.updateRunStep("step-1", {
      status: "completed",
      completedAt: now,
      metadata: { usage },
    });
    const analytics = agentRuntimeStore.getSession(session.id).sessionMetadata
      ?.runtimeAnalytics as {
      steps: number;
      usage: { input: number; output: number };
    };
    expect(analytics.steps).toBe(1);
    expect(analytics.usage.input).toBe(1000);
    expect(analytics.usage.output).toBe(200);

    // Repeated terminal updates (thought/tool metadata) stay idempotent.
    agentRuntimeStore.updateRunStep("step-1", {
      metadata: { usage, thought: "done" },
    });
    expect(
      (
        agentRuntimeStore.getSession(session.id).sessionMetadata
          ?.runtimeAnalytics as { steps: number }
      ).steps,
    ).toBe(1);

    agentRuntimeStore.appendToolCall({
      id: "call-1",
      sessionId: session.id,
      runId: "run-1",
      stepId: "step-1",
      modelToolCallId: "call-1",
      toolId: "read_file",
      category: "read",
      mutability: "read",
      argsHash: "hash",
      inputSummary: "{}",
      inputRef: null,
      outputSummary: null,
      outputRef: null,
      status: "running",
      permissionDecisionId: null,
      startedAt: now,
      endedAt: null,
      error: null,
    });
    // Updating the same call does not count it twice.
    agentRuntimeStore.updateToolCall(session.id, "call-1", {
      status: "completed",
    });
    const withTool = agentRuntimeStore.getSession(session.id).sessionMetadata
      ?.runtimeAnalytics as {
      toolCalls: number;
      toolCounts: Record<string, number>;
    };
    expect(withTool.toolCalls).toBe(1);
    expect(withTool.toolCounts).toEqual({ read_file: 1 });

    agentRuntimeStore.updateRun("run-1", { status: "completed", completedAt: now });
    const withRun = agentRuntimeStore.getSession(session.id).sessionMetadata
      ?.runtimeAnalytics as {
      completedRuns: number;
      completedRunSteps: number;
    };
    expect(withRun.completedRuns).toBe(1);
    expect(withRun.completedRunSteps).toBe(1);

    const appendUserMessage = (
      id: string,
      source: string,
      content = "Continue",
    ) =>
      agentRuntimeStore.appendMessage({
        id,
        sessionId: session.id,
        runId: null,
        stepId: null,
        role: "user",
        content,
        metadata: { source },
        createdAt: now,
      });
    appendUserMessage("input-1", "turn_request");
    appendUserMessage("input-1", "turn_request");
    appendUserMessage("system-input", "system_injection", "Runtime reminder");
    appendUserMessage("input-2", "input_queue", "Follow up");
    const withInputs = agentRuntimeStore.getSession(session.id).sessionMetadata
      ?.runtimeAnalytics as {
      userInputCount: number;
      lastUserInputId: string | null;
    };
    expect(withInputs.userInputCount).toBe(2);
    expect(withInputs.lastUserInputId).toBe("input-2");
  });

  it("excludes the time a step waited for a human reply", async () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    agentRuntimeStore.appendRun({
      id: "run-parked",
      sessionId: session.id,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      triggerMessageId: null,
      currentStep: 1,
      stopReason: null,
      model: "deepseek-v4-flash",
      metadata: {},
    });
    const startedAt = new Date().toISOString();
    agentRuntimeStore.appendRunStep({
      id: "step-parked",
      runId: "run-parked",
      sessionId: session.id,
      index: 1,
      status: "running",
      model: "deepseek-v4-flash",
      startedAt,
      completedAt: null,
      finishReason: null,
      metadata: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    agentRuntimeStore.updateRunStep("step-parked", { status: "waiting_input" });
    // The user takes their time; none of it is execution time.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const completedAt = new Date().toISOString();
    agentRuntimeStore.updateRunStep("step-parked", {
      status: "completed",
      completedAt,
      finishReason: "human_input_resolved",
    });

    const span = Date.parse(completedAt) - Date.parse(startedAt);
    const analytics = agentRuntimeStore.getSession(session.id).sessionMetadata
      ?.runtimeAnalytics as { steps: number; durationMs: number } | undefined;
    expect(span).toBeGreaterThan(300);
    expect(analytics?.steps).toBe(1);
    expect(analytics?.durationMs).toBeLessThan(span - 200);
    expect(analytics?.durationMs).toBeGreaterThan(0);
  });
});
