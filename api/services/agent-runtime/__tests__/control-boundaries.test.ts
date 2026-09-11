import { beforeEach, describe, expect, it } from "vitest";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { toolRegistry } from "../tool-registry.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { applySessionPermissionUpdate } from "../session-permissions.js";
import {
  belongsToPlanExecution,
  isGoalProof,
  goalEvidenceSection,
} from "../control-runtime.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import type { ToolCallRecord } from "../contracts.js";

beforeEach(() => {
  resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
});
describe("control authority boundaries", () => {
  it("revokes a specialist read when the parent changes its current permissions", async () => {
    const parent = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: "Review",
      sessionMetadata: { mode: "chat" },
    });
    const delegated = await toolRegistry.execute(
      parent.id,
      "subagent.delegate",
      {
        prompt: "Read files only",
        specialist: {
          name: "Expert",
          role: "Reviewer",
          instructions: "Read files",
          capabilities: ["file.read"],
          skillIds: [],
        },
      },
    );
    const id = (delegated.toolResult!.result as { taskId: string }).taskId;
    expect(
      (await toolRegistry.execute(id, "file.read", { path: "package.json" }))
        .record.status,
    ).toBe("completed");
    applySessionPermissionUpdate(parent.id, {
      permissionOverrides: { read: "deny" },
    });
    const denied = await toolRegistry.execute(id, "file.read", {
      path: "README.md",
    });
    expect(denied.record.status).toBe("failed");
    expect(denied.record.error).toContain("Parent permissions");
  });

  it("rejects proof from previous goals and from before the current revision approval", () => {
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: "Goal B",
      sessionMetadata: { mode: "goal" },
    });
    const now = new Date().toISOString();
    for (const [id, scope] of [
      ["old-run", "goal-a"],
      ["current-run", "goal-b"],
    ])
      store.appendRun({
        id,
        sessionId: session.id,
        status: "running",
        startedAt: now,
        completedAt: null,
        triggerMessageId: null,
        currentStep: 4,
        stopReason: null,
        model: null,
        metadata: { goalExecutionId: scope },
      });
    for (const [id, runId, index] of [
      ["old-step", "old-run", 2],
      ["before-approval", "current-run", 2],
      ["after-approval", "current-run", 4],
    ] as const)
      store.appendRunStep({
        id,
        runId,
        sessionId: session.id,
        index,
        status: "completed",
        model: null,
        startedAt: now,
        completedAt: now,
        finishReason: null,
        metadata: {},
      });
    const boundary = {
      executionId: "goal-b",
      approvedRunId: "current-run",
      approvedStepIndex: 3,
    };
    const call = (
      id: string,
      runId: string,
      stepId: string,
    ): ToolCallRecord => ({
      id,
      runId,
      stepId,
      sessionId: session.id,
      modelToolCallId: id,
      toolId: "bash",
      category: "shell",
      mutability: "read",
      argsHash: "x",
      inputSummary: "test",
      inputRef: {},
      outputSummary: "Tests passed",
      outputRef: { exitCode: 0 },
      status: "completed",
      permissionDecisionId: null,
      startedAt: now,
      endedAt: now,
      error: null,
    });
    const old = call("old-proof", "old-run", "old-step"),
      stale = call("stale-proof", "current-run", "before-approval"),
      fresh = call("fresh-proof", "current-run", "after-approval");
    expect(belongsToPlanExecution(old, boundary)).toBe(false);
    expect(isGoalProof(stale, boundary)).toBe(false);
    expect(isGoalProof(fresh, boundary)).toBe(true);
    expect(isGoalProof({...fresh,outputRef:{exitCode:null}},boundary)).toBe(false);
    store.updateSessionMetadata(session.id, { plan: boundary });
    const inventory = goalEvidenceSection(store.getSession(session.id), [
      old,
      stale,
      fresh,
    ]);
    expect(inventory).toContain("fresh-proof");
    expect(inventory).not.toContain("old-proof");
    expect(inventory).not.toContain("stale-proof");
  });
});
