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
  });
});
