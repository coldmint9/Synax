import { beforeEach, describe, expect, it } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { persistMeasuredContextUsage } from "../measured-context-usage.js";
import {
  explorerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";

const stepId = "stp-measured-context";
const composition = {
  version: 2,
  messages: 30_000,
  tools: 9_000,
  mcp: 0,
  skills: 0,
  system: 3_000,
  total: 42_000,
  measuredAt: "2026-10-22T10:00:00.000Z",
};

function snapshotOf(sessionId: string) {
  return agentRuntimeStore.getSession(sessionId).sessionMetadata?.contextUsage as
    | {
        source: string;
        total: number;
        stepId: string;
        composition: { messages: number; total: number };
      }
    | undefined;
}

function seedStep(sessionId: string, runId: string, metadata: Record<string, unknown>) {
  agentRuntimeStore.appendRunStep({
    id: stepId,
    sessionId,
    runId,
    index: 1,
    status: "running",
    model: "deepseek-flash",
    startedAt: "2026-10-22T10:00:00.000Z",
    completedAt: null,
    finishReason: null,
    metadata,
  });
}

describe("measured context usage persistence", () => {
  beforeEach(resetAgentRuntimeFixtures);

  it("records the provider's usage as the displayed context", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    seedStep(session.id, "run-1", { contextComposition: composition });

    persistMeasuredContextUsage(
      agentRuntimeStore,
      session.id,
      stepId,
      { inputTokens: 21_000, outputTokens: 120 },
      1_000_000,
    );

    expect(snapshotOf(session.id)).toMatchObject({
      source: "provider",
      stepId,
      total: 21_000,
      composition: { total: 21_000, messages: 15_000 },
    });
  });

  it("never falls back to a local estimate", () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    seedStep(session.id, "run-1", { contextComposition: composition });

    // No provider measurement: nothing to display, not the 42k estimate.
    persistMeasuredContextUsage(agentRuntimeStore, session.id, stepId, {
      outputTokens: 120,
    });
    persistMeasuredContextUsage(agentRuntimeStore, session.id, stepId, {
      inputTokens: 42_000,
      providerRequestCount: 2,
    });

    expect(snapshotOf(session.id)).toBeUndefined();
  });
});
