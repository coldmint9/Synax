import { describe, expect, it } from "vitest";
import type { AgentRunStep } from "../contracts.js";
import {
  accumulateWaitWindow,
  coveredDurationMs,
  isAwaitingUser,
  isParkedStep,
  mergeTimeSpans,
  sessionExecutionDurationMs,
  stepExecutionDurationMs,
  stepExecutionSpans,
  subtractTimeSpans,
} from "../step-execution-time.js";

const step = (overrides: Partial<AgentRunStep> = {}): AgentRunStep => ({
  id: "step-1",
  runId: "run-1",
  sessionId: "session-1",
  index: 1,
  status: "completed",
  model: null,
  startedAt: "2026-10-20T00:00:00.000Z",
  completedAt: "2026-10-20T00:01:00.000Z",
  finishReason: "stop",
  metadata: {},
  ...overrides,
});

const at = (iso: string) => Date.parse(iso);

describe("execution time spans", () => {
  it("merges concurrent spans instead of adding them", () => {
    const spans = [
      { start: at("2026-10-20T00:00:00.000Z"), end: at("2026-10-20T00:10:00.000Z") },
      { start: at("2026-10-20T00:02:00.000Z"), end: at("2026-10-20T00:08:00.000Z") },
      { start: at("2026-10-20T00:08:00.000Z"), end: at("2026-10-20T00:12:00.000Z") },
    ];
    expect(mergeTimeSpans(spans)).toEqual([
      { start: at("2026-10-20T00:00:00.000Z"), end: at("2026-10-20T00:12:00.000Z") },
    ]);
    expect(coveredDurationMs(spans)).toBe(12 * 60_000);
  });

  it("removes waits from the middle of a span", () => {
    const [first, second] = subtractTimeSpans(
      [{ start: at("2026-10-20T00:00:00.000Z"), end: at("2026-10-20T00:10:00.000Z") }],
      [{ start: at("2026-10-20T00:04:00.000Z"), end: at("2026-10-20T00:06:00.000Z") }],
    );
    expect(first).toEqual({
      start: at("2026-10-20T00:00:00.000Z"),
      end: at("2026-10-20T00:04:00.000Z"),
    });
    expect(second).toEqual({
      start: at("2026-10-20T00:06:00.000Z"),
      end: at("2026-10-20T00:10:00.000Z"),
    });
  });

  it("never counts a step that has not finished", () => {
    const running = step({
      status: "running",
      completedAt: null,
      startedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(stepExecutionSpans(running)).toEqual([]);
    expect(stepExecutionDurationMs(running)).toBe(0);
    // It must not grow with the clock either.
    expect(stepExecutionDurationMs({ ...running, metadata: {} })).toBe(0);
  });

  it("keeps the recorded execution time of a step parked on a permission reply", () => {
    const parked = step({
      status: "waiting_permission",
      startedAt: "2026-10-20T00:00:00.000Z",
      completedAt: "2026-10-20T00:00:30.000Z",
      finishReason: "permission_required",
    });
    expect(stepExecutionDurationMs(parked)).toBe(30_000);
  });

  it("subtracts parked time recorded by the store", () => {
    const answered = step({
      startedAt: "2026-10-20T00:00:00.000Z",
      completedAt: "2026-10-20T02:00:00.000Z",
      finishReason: "human_input_resolved",
      metadata: { analyticsParkedMs: 5_400_000 },
    });
    expect(stepExecutionDurationMs(answered)).toBe(30 * 60_000);
  });

  it("subtracts waits reconstructed from legacy interactions", () => {
    const legacy = step({
      startedAt: "2026-10-20T00:00:00.000Z",
      completedAt: "2026-10-20T03:00:00.000Z",
    });
    expect(
      stepExecutionDurationMs(legacy, {
        waitSpans: [{ start: at("2026-10-20T00:05:00.000Z"), end: at("2026-10-20T02:50:00.000Z") }],
      }),
    ).toBe(15 * 60_000);
  });

  it("bounds a forced termination by the last recorded activity", () => {
    // The app quit at 00:01 and recovery stamped the end an hour later.
    const restarted = step({
      status: "interrupted",
      startedAt: "2026-10-20T00:00:00.000Z",
      completedAt: "2026-10-20T01:00:00.000Z",
      finishReason: "runtime_restart",
    });
    expect(
      stepExecutionDurationMs(restarted, { lastActivityMs: at("2026-10-20T00:01:00.000Z") }),
    ).toBe(60_000);
    // Without evidence of when it stopped the span is not silently inflated by
    // anything else either.
    expect(stepExecutionDurationMs(restarted)).toBe(60 * 60_000);
  });

  it("merges overlapping steps of one session", () => {
    const parent = step({
      id: "parent",
      startedAt: "2026-10-20T00:00:00.000Z",
      completedAt: "2026-10-20T00:10:00.000Z",
    });
    const child = step({
      id: "child",
      startedAt: "2026-10-20T00:02:00.000Z",
      completedAt: "2026-10-20T00:06:00.000Z",
    });
    expect(sessionExecutionDurationMs([parent, child])).toBe(10 * 60_000);
  });
});

describe("wait windows", () => {
  it("opens a window once, keeps it across rewrites and closes it on resume", () => {
    const opened = accumulateWaitWindow(
      { ms: 0, since: null },
      true,
      at("2026-10-20T00:00:00.000Z"),
    );
    expect(opened).toEqual({ ms: 0, since: "2026-10-20T00:00:00.000Z" });
    // A second write while the step still waits must not restart the window.
    expect(
      accumulateWaitWindow(opened, true, at("2026-10-20T00:02:00.000Z")),
    ).toEqual(opened);
    expect(
      accumulateWaitWindow(opened, false, at("2026-10-20T00:05:00.000Z")),
    ).toEqual({ ms: 5 * 60_000, since: null });
  });

  it("keeps an earlier wait when the step waits again", () => {
    const resumed = { ms: 4 * 60_000, since: null };
    const second = accumulateWaitWindow(resumed, true, at("2026-10-20T01:00:00.000Z"));
    expect(accumulateWaitWindow(second, false, at("2026-10-20T01:01:00.000Z")))
      .toEqual({ ms: 5 * 60_000, since: null });
  });

  it("never accrues time for a step that is not waiting", () => {
    const idle = { ms: 90_000, since: null };
    expect(accumulateWaitWindow(idle, false, at("2026-10-20T03:00:00.000Z"))).toEqual(idle);
  });

  it("counts only a form or a permission reply as waiting for the user", () => {
    expect(isAwaitingUser(step({ status: "waiting_input" }))).toBe(true);
    expect(isAwaitingUser(step({ status: "waiting_permission" }))).toBe(true);
    expect(isAwaitingUser(step({ status: "running" }))).toBe(false);
    expect(isAwaitingUser(null)).toBe(false);
    // Child sessions keep the step parked, but the agent is supervising them,
    // not waiting for the reader.
    const supervising = step({ status: "running", metadata: { awaitingSubagents: true } });
    expect(isAwaitingUser(supervising)).toBe(false);
    expect(isParkedStep(supervising)).toBe(true);
  });
});
