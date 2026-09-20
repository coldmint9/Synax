import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { agentLoopRuntime } from "../loop-runtime.js";
import { RunCoordinator } from "../run-coordinator.js";
import { runChildToCompletion } from "../subagent-orchestrator.js";
import {
  plannerSessionInput,
  explorerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";

const execution = agentLoopRuntime as unknown as {
  beginSessionExecution(id: string): { signal: AbortSignal; dispose(): void };
  recoverIncompleteSubtasks(id: string): Promise<void>;
};
function tree() {
  const root = agentSessionRuntime.create(plannerSessionInput);
  const child = agentSessionRuntime.create({
    ...explorerSessionInput,
    parentSessionId: root.id,
  });
  const grandchild = agentSessionRuntime.create({
    ...explorerSessionInput,
    parentSessionId: child.id,
  });
  const sibling = agentSessionRuntime.create({
    ...explorerSessionInput,
    parentSessionId: root.id,
  });
  return { root, child, grandchild, sibling };
}

describe("subagent lifecycle controls", () => {
  beforeEach(resetAgentRuntimeFixtures);

  it("preserves a manual stop when recovering the parent instead of restarting or reporting a lost child", async () => {
    const { root, child } = tree();
    const startedAt = new Date().toISOString();
    agentRuntimeStore.appendRun({
      id: "parent-run",
      sessionId: root.id,
      status: "interrupted",
      startedAt,
      completedAt: startedAt,
      triggerMessageId: null,
      currentStep: 1,
      stopReason: null,
      model: null,
      metadata: {},
    });
    agentRuntimeStore.appendToolCall({
      id: "delegate-call",
      sessionId: root.id,
      runId: "parent-run",
      stepId: null,
      modelToolCallId: null,
      toolId: "subagent.delegate",
      category: "read",
      mutability: "task",
      argsHash: "test",
      inputSummary: "Delegate",
      inputRef: { taskId: child.id },
      outputSummary: null,
      outputRef: null,
      status: "running",
      permissionDecisionId: null,
      startedAt,
      endedAt: null,
      error: null,
    });
    agentSessionRuntime.cancel(root.id);
    const stream = vi.spyOn(agentLoopRuntime, "streamRun");
    try {
      await execution.recoverIncompleteSubtasks(root.id);
      expect(stream).not.toHaveBeenCalled();
      expect(
        agentRuntimeStore.getToolCall(root.id, "delegate-call"),
      ).toMatchObject({
        status: "failed",
        error: "Subagent stopped by user.",
        outputRef: { childSessionId: child.id, childStatus: "interrupted" },
      });
    } finally {
      stream.mockRestore();
    }
  });

  it("exposes child stop and destroy through the session routes", async () => {
    const { agentRuntimeRoutes } =
      await import("../../../routes/agent-runtime.js");
    const { root, child, grandchild, sibling } = tree();
    const stopped = await agentRuntimeRoutes.request(
      `/sessions/${child.id}/cancel`,
      { method: "POST" },
    );
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({
      id: child.id,
      status: "interrupted",
    });
    expect(agentRuntimeStore.getSession(grandchild.id).status).toBe(
      "interrupted",
    );
    expect(agentRuntimeStore.getSession(root.id).status).toBe("running");
    expect(agentRuntimeStore.getSession(sibling.id).status).toBe("running");
    const deleted = await agentRuntimeRoutes.request(`/sessions/${child.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({
      ok: true,
      deletedSessionIds: expect.arrayContaining([child.id, grandchild.id]),
    });
    expect(agentRuntimeStore.getSession(root.id).childSessionIds).toEqual([
      sibling.id,
    ]);
  });

  it("waits for the entire selected subtree to unwind, preserving the parent and sibling", async () => {
    const sessions = tree();
    const active = Object.fromEntries(
      Object.entries(sessions).map(([key, session]) => [
        key,
        execution.beginSessionExecution(session.id),
      ]),
    );
    let confirmed = false;
    const stop = agentLoopRuntime
      .interruptAndWaitForSessions([sessions.child.id], "Stop child")
      .then(() => {
        confirmed = true;
      });
    try {
      expect(active.child.signal.aborted).toBe(true);
      expect(active.grandchild.signal.aborted).toBe(true);
      expect(active.root.signal.aborted).toBe(false);
      expect(active.sibling.signal.aborted).toBe(false);
      active.child.dispose();
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(confirmed).toBe(false);
      active.grandchild.dispose();
      await stop;
      expect(confirmed).toBe(true);
    } finally {
      for (const item of Object.values(active)) item.dispose();
    }
  });

  it("cancels waiting and queued descendants while preserving completed results", async () => {
    const { root, child, grandchild, sibling } = tree();
    const paused = agentSessionRuntime.create({
      ...explorerSessionInput,
      parentSessionId: root.id,
    });
    agentRuntimeStore.updateSession(paused.id, { status: "interrupted" });
    agentRuntimeStore.updateSession(child.id, {
      status: "waiting_input",
      pendingResumeToken: "pending",
    });
    agentRuntimeStore.updateSession(grandchild.id, { status: "queued" });
    agentRuntimeStore.updateSession(sibling.id, {
      status: "completed",
      resultSummary: "Keep result",
    });
    const coordinator = new RunCoordinator({
      execute: vi.fn(),
      interrupt: vi.fn(async () => {}),
    });
    await coordinator.interrupt(root.id, "Stop parent", () =>
      agentSessionRuntime.cancel(root.id),
    );
    for (const id of [root.id, child.id, grandchild.id, paused.id]) {
      expect(agentRuntimeStore.getSession(id)).toMatchObject({
        status: "interrupted",
        activeRunId: null,
        pendingResumeToken: null,
      });
      expect(
        agentRuntimeStore.getSession(id).sessionMetadata?.manualStop,
      ).toBeTruthy();
    }
    expect(agentRuntimeStore.getSession(sibling.id)).toMatchObject({
      status: "completed",
      resultSummary: "Keep result",
    });
    const stream = vi.spyOn(agentLoopRuntime, "streamRun");
    try {
      await runChildToCompletion(child.id, {
        profileId: "explorer",
        prompt: "task",
      });
      expect(stream).not.toHaveBeenCalled();
    } finally {
      stream.mockRestore();
    }
  });

  it("does not allow new delegates during shutdown and deletes only after confirmation", async () => {
    const { root, child, grandchild, sibling } = tree();
    let confirm!: () => void;
    const coordinator = new RunCoordinator({
      execute: vi.fn(),
      interrupt: () =>
        new Promise<void>((resolve) => {
          confirm = resolve;
        }),
    });
    const stop = coordinator.interrupt(child.id, "Destroy child", () => {
      agentSessionRuntime.delete(child.id);
    });
    expect(agentRuntimeStore.tryGetSession(child.id)).toBeDefined();
    expect(() =>
      agentSessionRuntime.create({
        ...explorerSessionInput,
        parentSessionId: grandchild.id,
      }),
    ).toThrow(/stopping/);
    confirm();
    await stop;
    expect(agentRuntimeStore.tryGetSession(child.id)).toBeUndefined();
    expect(agentRuntimeStore.tryGetSession(grandchild.id)).toBeUndefined();
    expect(agentRuntimeStore.getSession(root.id).childSessionIds).toEqual([
      sibling.id,
    ]);
    expect(agentRuntimeStore.getSession(sibling.id).status).toBe("running");
  });
});
