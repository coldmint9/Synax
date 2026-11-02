import { describe, expect, it } from "vitest";
import type { AgentRun, ToolCallRecord } from "../contracts.js";
import {
  buildSessionContinuationPrompt,
  type SessionContinuationSource,
} from "../session-continuation.js";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    sessionId: "session-1",
    status: "interrupted",
    startedAt: "2026-10-28T00:00:00Z",
    completedAt: null,
    triggerMessageId: null,
    currentStep: 1,
    stopReason: null,
    model: null,
    metadata: {},
    ...overrides,
  };
}

function call(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: "call-1",
    sessionId: "session-1",
    runId: "run-1",
    stepId: "step-1",
    modelToolCallId: "model-call-1",
    toolId: "file.write",
    category: "write",
    mutability: "write",
    argsHash: "hash",
    inputSummary: "src/app.ts",
    inputRef: {},
    outputSummary: null,
    outputRef: null,
    status: "running",
    permissionDecisionId: null,
    startedAt: "2026-10-28T00:00:00Z",
    endedAt: null,
    error: null,
    ...overrides,
  };
}

function source(runs: AgentRun[], calls: ToolCallRecord[] = []): SessionContinuationSource {
  return {
    listRuns: (sessionId) => runs.filter((item) => item.sessionId === sessionId),
    listRunToolCalls: (runId) => calls.filter((item) => item.runId === runId),
  };
}

describe("buildSessionContinuationPrompt", () => {
  it("retries a failed run from the failure instead of restating the prompt", () => {
    const prompt = buildSessionContinuationPrompt(source([]), "session-1", "failed");
    expect(prompt).toBe(
      "Session previously failed. Review the error and previous context, then retry the task from where it left off.",
    );
  });

  it("points a stopped run at the tool calls that never finished", () => {
    const prompt = buildSessionContinuationPrompt(
      source([run()], [
        call({ id: "call-1", inputSummary: "src/app.ts" }),
        call({ id: "call-2", status: "completed" }),
      ]),
      "session-1",
      "paused",
    );
    expect(prompt.startsWith("Session was interrupted.")).toBe(true);
    expect(prompt).toContain("- file.write(src/app.ts)");
    expect(prompt).toContain("Retry these operations as needed to continue the task.");
  });

  it("asks for a review of completed work when nothing was left running", () => {
    const prompt = buildSessionContinuationPrompt(
      source([run()], [call({ status: "completed" })]),
      "session-1",
      "interrupted",
    );
    expect(prompt.startsWith("Session was interrupted.")).toBe(true);
    expect(prompt).toContain("Review your previous tool calls and results.");
    expect(prompt).not.toContain("did not complete");
  });

  it("falls back to the original task when the session has no run yet", () => {
    expect(buildSessionContinuationPrompt(source([]), "session-1", "paused")).toBe(
      "Session was interrupted. Continue working on the original task using tools.",
    );
  });

  it("only considers the newest run", () => {
    const prompt = buildSessionContinuationPrompt(
      source(
        [
          run({ id: "run-old", startedAt: "2026-10-27T00:00:00Z" }),
          run({ id: "run-new", startedAt: "2026-10-28T00:00:00Z" }),
        ],
        [call({ id: "old-call", runId: "run-old" })],
      ),
      "session-1",
      "interrupted",
    );
    expect(prompt).not.toContain("did not complete");
  });
});
