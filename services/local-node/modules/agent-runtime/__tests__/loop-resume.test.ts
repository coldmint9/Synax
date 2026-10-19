import { describe, expect, it, vi } from "vitest";
import { LoopResumeService } from "../loop-resume.js";

describe("LoopResumeService", () => {
  it("reloads authoritative state and finds an approved permission after its token is cleared", async () => {
    const permission = {
      id: "permission-1",
      sessionId: "session-1",
      runId: "run-1",
      stepId: "step-1",
      toolCallId: "tool-1",
      action: "allow",
      userReply: "once",
      resolvedAt: "2026-10-18T12:00:00.000Z",
      createdAt: "2026-10-18T11:59:00.000Z",
      resumeToken: "resume-1",
    };
    const store = {
      hydrateSession: vi.fn(async () => undefined),
      getSession: vi.fn(() => ({ id: "session-1", activeRunId: "run-1", pendingResumeToken: null })),
      listPermissions: vi.fn(() => [permission]),
      getRun: vi.fn(() => ({ id: "run-1", sessionId: "session-1" })),
      getRunStep: vi.fn(() => ({ id: "step-1", runId: "run-1" })),
      getToolCall: vi.fn(() => ({ id: "tool-1", sessionId: "session-1" })),
    };
    const permissions = {
      findByResumeToken: vi.fn(() => undefined),
      list: vi.fn(() => [permission]),
    };

    const service = new LoopResumeService(store as never, permissions as never);
    const result = await service.resolvePendingRun("session-1");

    expect(store.hydrateSession).toHaveBeenCalledWith("session-1", true);
    expect(result).toMatchObject({
      permission,
      run: { id: "run-1" },
      step: { id: "step-1" },
      toolCall: { id: "tool-1" },
    });
  });
});
