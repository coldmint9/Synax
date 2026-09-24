import { beforeEach, describe, expect, it } from "vitest";
import {
  isDurableRuntimeCheckpoint,
  recoverRuntime,
  restoreUnlaunchedInput,
} from "../runtime-recovery.js";
import { agentRuntimeStore } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { interactionService } from "../interaction-service.js";
import { permissionPolicy } from "../permission-policy.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import {
  resetAgentRuntimeFixtures,
  plannerSessionInput,
} from "./agent-runtime-fixtures.js";
import { acceptRuntimeRun } from "../run-admission.js";
import os from "node:os";
beforeEach(() => {
  resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
});

describe("restart recovery decisions", () => {
  it.each(["waiting_permission", "waiting_input"])(
    "preserves %s as a durable checkpoint during shutdown",
    (status) => {
      expect(isDurableRuntimeCheckpoint(status)).toBe(true);
    },
  );

  it("restores a waiting-input run after the host restarts", async () => {
    const session = agentSessionRuntime.create({
      ...plannerSessionInput,
      workDir: os.tmpdir(),
    });
    const { run } = acceptRuntimeRun(
      session.id,
      { message: "Ask before editing" },
      "ask",
    );
    agentRuntimeStore.updateRun(run.id, { status: "waiting_input" });
    agentRuntimeStore.updateSession(session.id, {
      status: "waiting_input",
      activeRunId: run.id,
      pendingResumeToken: "interaction:ask",
    });

    expect(await recoverRuntime("new-host")).toEqual({
      reviewed: 0,
      resumable: [],
    });
    expect(agentRuntimeStore.getSession(session.id)).toMatchObject({
      status: "waiting_input",
      activeRunId: run.id,
      pendingResumeToken: "interaction:ask",
    });
    expect(agentRuntimeStore.getRun(run.id).status).toBe("waiting_input");
  });

  it.each(["interaction", "permission"] as const)(
    "repairs a completed session with a pending %s checkpoint",
    async (kind) => {
      const session = agentSessionRuntime.create({
        ...plannerSessionInput,
        profileId: "synax",
        sessionMetadata: { mode: "plan" },
        workDir: os.tmpdir(),
      });
      const now = new Date().toISOString();
      const run = agentRuntimeStore.appendRun({
        id: `checkpoint-run-${kind}`,
        sessionId: session.id,
        status: "running",
        startedAt: now,
        completedAt: null,
        triggerMessageId: null,
        currentStep: 1,
        stopReason: null,
        model: null,
        metadata: {},
      });
      const step = agentRuntimeStore.appendRunStep({
        id: `checkpoint-step-${kind}`,
        runId: run.id,
        sessionId: session.id,
        index: 1,
        status: "running",
        model: null,
        startedAt: now,
        completedAt: null,
        finishReason: null,
        metadata: {},
      });
      const toolCall = agentRuntimeStore.appendToolCall({
        id: `checkpoint-call-${kind}`,
        sessionId: session.id,
        runId: run.id,
        stepId: step.id,
        modelToolCallId: `checkpoint-model-${kind}`,
        toolId: kind === "interaction" ? "human.ask" : "file.write",
        category: kind === "interaction" ? "task" : "write",
        mutability: kind === "interaction" ? "task" : "write",
        argsHash: "checkpoint",
        inputSummary: "checkpoint",
        inputRef: {},
        outputSummary: null,
        outputRef: null,
        status: "running",
        permissionDecisionId: null,
        startedAt: now,
        endedAt: null,
        error: null,
      });
      agentRuntimeStore.updateSession(session.id, {
        status: "running",
        activeRunId: run.id,
      });
      if (kind === "interaction") {
        interactionService.request({
          sessionId: session.id,
          runId: run.id,
          stepId: step.id,
          toolCallId: toolCall.id,
          kind: "clarification",
          request: {
            title: "Clarify after restart",
            questions: [
              { id: "scope", type: "text", label: "Scope?", required: true },
            ],
          },
        });
      } else {
        agentRuntimeStore.appendPermission({
          id: "checkpoint-permission",
          sessionId: session.id,
          runId: run.id,
          stepId: step.id,
          toolCallId: toolCall.id,
          coarseCategory: "write",
          internalGate: "write",
          action: "ask",
          reason: "Write requires approval.",
          patterns: ["*"],
          userReply: null,
          createdAt: now,
          resolvedAt: null,
          resumeToken: "checkpoint-permission-token",
          metadata: {},
        });
        agentRuntimeStore.updateSession(session.id, {
          status: "waiting_permission",
          pendingResumeToken: "checkpoint-permission-token",
        });
      }
      agentRuntimeStore.updateRun(run.id, {
        status: "interrupted",
        completedAt: now,
        stopReason: "Runtime restarted.",
      });
      agentRuntimeStore.updateSession(session.id, {
        status: "completed",
        activeRunId: null,
        pendingResumeToken: null,
      });
      agentRuntimeStore.updateSessionMetadata(session.id, {
        runtimeControl: {
          state: "unconfirmed",
          source: "restart",
          reason: "Stale recovery fence",
        },
      });

      await recoverRuntime("new-host");

      const restored = agentRuntimeStore.getSession(session.id);
      expect(restored.status).toBe(
        kind === "interaction" ? "waiting_input" : "waiting_permission",
      );
      expect(restored.activeRunId).toBe(run.id);
      expect(restored.sessionMetadata?.runtimeControl).toBeNull();
      if (kind === "interaction") {
        expect(restored.pendingResumeToken).toMatch(/^interaction:/);
        const pending = interactionService.pending(session.id);
        expect(pending).not.toBeNull();
        expect(() =>
          interactionService.reply(session.id, pending!.id, {
            revision: pending!.revision,
            action: "submit",
            answers: { scope: "Only API" },
          }),
        ).not.toThrow();
      } else {
        expect(restored.pendingResumeToken).toBe("checkpoint-permission-token");
        expect(() =>
          permissionPolicy.reply(session.id, "checkpoint-permission", "once"),
        ).not.toThrow();
      }
      expect(agentRuntimeStore.getRun(run.id)).toMatchObject({
        status: kind === "interaction" ? "waiting_input" : "waiting_permission",
        completedAt: null,
      });
    },
  );

  it("retains an unlaunched request for explicit continuation without automatically replaying it", async () => {
    const session = agentSessionRuntime.create({
      ...plannerSessionInput,
      workDir: os.tmpdir(),
    });
    const { run } = acceptRuntimeRun(
      session.id,
      { message: "Exact pending input" },
      "pending",
    );
    await recoverRuntime("new-host");
    expect(agentRuntimeStore.getRun(run.id).status).toBe("interrupted");
    expect(restoreUnlaunchedInput(session.id, {})).toMatchObject({
      message: "Exact pending input",
    });
  });
  it("interrupts a stopped run without retaining a manual recovery block", async () => {
    const session = agentSessionRuntime.create({
      ...plannerSessionInput,
      workDir: os.tmpdir(),
    });
    const { run } = acceptRuntimeRun(
      session.id,
      { message: "Write something" },
      "running",
    );
    agentRuntimeStore.updateRun(run.id, { status: "running" });
    expect(await recoverRuntime("new-host")).toEqual({ reviewed: 1, resumable: [] });
    expect(agentRuntimeStore.getSession(session.id)).toMatchObject({
      status: "interrupted",
      activeRunId: null,
      pendingResumeToken: null,
    });
    expect(
      agentRuntimeStore.getSession(session.id).sessionMetadata?.runtimeControl,
    ).toBeNull();
    expect(agentRuntimeStore.getRun(run.id).status).toBe("interrupted");
    expect(
      acceptRuntimeRun(session.id, { message: "Next" }, "next").run.status,
    ).toBe("queued");
  });

  it("clears old recovery flags when there is no longer an owned process", async () => {
    const session = agentSessionRuntime.create({
      ...plannerSessionInput,
      workDir: os.tmpdir(),
    });
    agentRuntimeStore.updateSessionMetadata(session.id, {
      runtimeControl: { state: "unconfirmed", source: "restart" },
    });
    await recoverRuntime("new-host");
    expect(
      agentRuntimeStore.getSession(session.id).sessionMetadata?.runtimeControl,
    ).toBeNull();
    expect(
      acceptRuntimeRun(session.id, { message: "Ready" }, "ready").run.status,
    ).toBe("queued");
  });
});
