import { expect, it } from "vitest";
import { finalizeStoppedSessions } from "./stopped-session-cleanup.js";
import type { AgentRuntimeStore } from "./session-store.js";

type StubSession = { id: string; status: string; blockedReason: string | null; activeRunId: string | null; parentSessionId: string | null };
type StubRun = { id: string; sessionId: string; status: string; stopReason: string | null };
type StubStep = { id: string; runId: string; status: string; completedAt?: string | null; finishReason?: string | null };

function stubStore(sessions: StubSession[], runs: StubRun[], steps: StubStep[] = []) {
  return {
    transaction: (work: () => void) => work(),
    tryGetSession: (id: string) => sessions.find(session => session.id === id),
    listRuns: (sessionId: string) => runs.filter(run => run.sessionId === sessionId),
    listRunSteps: (runId: string) => steps.filter(step => step.runId === runId),
    updateRun: (id: string, patch: Partial<StubRun>) => Object.assign(runs.find(run => run.id === id)!, patch),
    updateRunStep: (id: string, patch: Partial<StubStep>) => Object.assign(steps.find(step => step.id === id)!, patch),
    updateSession: (id: string, patch: Partial<StubSession>) => Object.assign(sessions.find(session => session.id === id)!, patch),
    updateSessionMetadata: () => undefined,
  } as unknown as AgentRuntimeStore;
}

it("keeps the recorded cause when the worker exits after a stopped run", () => {
  const cause = "RUN_INTERRUPTED: previous execution is unavailable.";
  const sessions: StubSession[] = [
    { id: "s-paused", status: "paused", blockedReason: cause, activeRunId: "run-1", parentSessionId: null },
    { id: "s-running", status: "running", blockedReason: null, activeRunId: "run-2", parentSessionId: null },
  ];
  const runs: StubRun[] = [
    { id: "run-1", sessionId: "s-paused", status: "interrupted", stopReason: cause },
    { id: "run-2", sessionId: "s-running", status: "running", stopReason: null },
  ];
  finalizeStoppedSessions(["s-paused", "s-running"], "Agent session worker exited (code 0, signal null).", stubStore(sessions, runs));

  expect(sessions[0]).toMatchObject({ status: "interrupted", blockedReason: cause, activeRunId: null });
  expect(runs[0]).toMatchObject({ status: "interrupted", stopReason: cause });
  expect(sessions[1]).toMatchObject({ status: "interrupted", blockedReason: "Agent session worker exited (code 0, signal null)." });
  expect(runs[1]).toMatchObject({ status: "interrupted", stopReason: "Agent session worker exited (code 0, signal null)." });
});

it("interrupts unfinished steps that the exited worker can no longer finish", () => {
  const sessions: StubSession[] = [
    { id: "s-1", status: "running", blockedReason: null, activeRunId: "run-1", parentSessionId: null },
  ];
  const runs: StubRun[] = [{ id: "run-1", sessionId: "s-1", status: "running", stopReason: null }];
  const steps: StubStep[] = [
    { id: "step-1", runId: "run-1", status: "completed", completedAt: "2026-10-28T13:00:00.000Z", finishReason: "stop" },
    { id: "step-2", runId: "run-1", status: "running", completedAt: null, finishReason: null },
  ];
  finalizeStoppedSessions(["s-1"], "Agent session worker exited (code 1, signal null).", stubStore(sessions, runs, steps));

  expect(steps[0]).toMatchObject({ status: "completed", finishReason: "stop" });
  expect(steps[1]).toMatchObject({ status: "interrupted", finishReason: "execution_stopped" });
});
