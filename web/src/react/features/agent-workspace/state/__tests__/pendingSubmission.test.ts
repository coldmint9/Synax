import { describe, expect, it } from "vitest";
import type { AgentRun, AgentRuntimeMessage } from "../../../../../lib/api/agentRuntime";
import { projectPendingSubmission, type PendingSubmission } from "../pendingSubmissionStore";

const message = (id: string, requestId?: string): AgentRuntimeMessage => ({
  id, sessionId: "s1", runId: null, stepId: null, role: "user",
  content: "我上一轮说了啥", metadata: requestId ? { requestId } : {}, createdAt: "2026-09-23T08:00:00Z",
});
const pending: PendingSubmission = { requestId: "request-1", message: message("pending:request-1") };
const run = {
  id: "run-1", sessionId: "s1", triggerMessageId: null,
  metadata: { runtime: { requestId: pending.requestId } },
} as unknown as AgentRun;

describe("pending submission identity", () => {
  it.each([{ runs: [] }, { runs: [run] }])("reconciles the persisted message before its run linkage arrives (%j)", ({ runs }) => {
    const saved = message("server-1", pending.requestId);
    const projected = projectPendingSubmission(pending, runs, [saved]);
    expect(projected.confirmed).toBe(true);
    expect(projected.messages).toEqual([saved]);
  });
  it("keeps earlier identical text belonging to another request", () => {
    const older = message("older", "request-0");
    const saved = message("server-1", pending.requestId);
    expect(projectPendingSubmission(pending, [], [older, saved]).messages).toEqual([older, saved]);
    expect(projectPendingSubmission(pending, [], [older]).messages).toEqual([older, pending.message]);
  });
  it("does not match another session's request identity", () => {
    const other = { ...message("other", pending.requestId), sessionId: "s2" };
    expect(projectPendingSubmission(pending, [], [other]).confirmed).toBe(false);
  });
  it("keeps the temporary message when only a queued run has arrived", () => {
    expect(projectPendingSubmission(pending, [run], []).messages).toEqual([pending.message]);
  });
  it("retains compatibility with previously stored messages using triggerMessageId", () => {
    const saved = message("server-1");
    expect(projectPendingSubmission(pending, [{ ...run, triggerMessageId: saved.id }], [saved]).confirmed).toBe(true);
  });
});
