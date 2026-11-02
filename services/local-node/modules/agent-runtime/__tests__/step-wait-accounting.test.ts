import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import type { AgentRunStep } from "../contracts.js";
import {
  explorerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";

const START = "2026-10-22T10:00:00.000Z";

/**
 * The store is the only writer of the wait counters, and they are the only
 * evidence the transcript has for "time the agent actually ran". A window that
 * restarts on a repeated write, or one that counts child-session supervision,
 * would inflate the folded work-time row.
 */
describe("step wait accounting", () => {
  let sessionId: string;

  beforeEach(async () => {
    await resetAgentRuntimeFixtures();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
    sessionId = agentSessionRuntime.create(explorerSessionInput).id;
    agentRuntimeStore.appendRun({
      id: "run-1",
      sessionId,
      status: "running",
      startedAt: START,
      completedAt: null,
      triggerMessageId: null,
      currentStep: 0,
      stopReason: null,
      model: null,
      metadata: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function write(overrides: Partial<AgentRunStep> = {}): AgentRunStep {
    return agentRuntimeStore.appendRunStep({
      id: "step-1",
      runId: "run-1",
      sessionId,
      index: 1,
      status: "running",
      model: null,
      startedAt: START,
      completedAt: null,
      finishReason: null,
      metadata: {},
      ...overrides,
    });
  }

  it("counts one window even when the step is written while it waits", () => {
    write();
    vi.setSystemTime(new Date("2026-10-22T10:01:00.000Z"));
    write({ status: "waiting_input" });
    // A second parked write must not restart the window.
    vi.setSystemTime(new Date("2026-10-22T10:02:00.000Z"));
    write({ status: "waiting_input" });
    vi.setSystemTime(new Date("2026-10-22T10:11:00.000Z"));
    const saved = write({ status: "running" });

    expect(saved.metadata.analyticsUserWaitMs).toBe(10 * 60_000);
    expect(saved.metadata.analyticsUserWaitSince).toBeUndefined();
    // Parked time keeps its wider meaning: the same wait is included there.
    expect(saved.metadata.analyticsParkedMs).toBe(10 * 60_000);
  });

  it("does not treat child-session supervision as waiting for the user", () => {
    write();
    vi.setSystemTime(new Date("2026-10-22T10:05:00.000Z"));
    write({ metadata: { awaitingSubagents: true } });
    vi.setSystemTime(new Date("2026-10-22T10:09:00.000Z"));
    const saved = write();

    expect(saved.metadata.analyticsUserWaitMs).toBeUndefined();
    expect(saved.metadata.analyticsParkedMs).toBe(4 * 60_000);
  });

  it("closes a permission window on the write that resumes the step", () => {
    write();
    vi.setSystemTime(new Date("2026-10-22T10:00:30.000Z"));
    write({ status: "waiting_permission" });
    vi.setSystemTime(new Date("2026-10-22T10:03:30.000Z"));
    const saved = write();

    expect(saved.metadata.analyticsUserWaitMs).toBe(3 * 60_000);
  });
});
