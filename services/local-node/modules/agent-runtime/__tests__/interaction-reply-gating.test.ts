import { beforeEach, describe, expect, it } from "vitest";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { interactionService } from "../interaction-service.js";
import { makeRuntimeId, nowIso } from "../runtime-ids.js";

/** One run that parks on a human form, then on a permission prompt, must stay
 *  answerable on both checkpoints: the newest checkpoint owns the session
 *  status, but an unresolved earlier form is still a live question. */
describe("interaction reply gating", () => {
  let sessionId: string;
  let runId: string;
  let stepId: string;

  beforeEach(async () => {
    await resetAgentRuntimeFixtures();
    ensureSynaxAgentRegistered();
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: "Ask, then write.",
      workDir: process.cwd(),
    });
    sessionId = session.id;
    runId = makeRuntimeId("run");
    stepId = makeRuntimeId("stp");
    store.appendRun({
      id: runId,
      sessionId,
      status: "running",
      startedAt: nowIso(),
      completedAt: null,
      triggerMessageId: null,
      currentStep: 1,
      stopReason: null,
      model: null,
      metadata: {},
    });
    store.appendRunStep({
      id: stepId,
      sessionId,
      runId,
      index: 1,
      status: "running",
      model: null,
      startedAt: nowIso(),
      completedAt: null,
      finishReason: null,
      metadata: {},
    });
    store.updateSession(sessionId, { status: "running", activeRunId: runId });
  });

  function ask(): { interactionId: string; toolCallId: string } {
    const toolCallId = makeRuntimeId("tc");
    store.appendToolCall({
      id: toolCallId,
      sessionId,
      runId,
      stepId,
      modelToolCallId: "provider-ask",
      toolId: "human.ask",
      category: "task",
      mutability: "read",
      argsHash: store.hashArgs({}),
      inputSummary: "human.ask",
      inputRef: {},
      outputSummary: null,
      outputRef: null,
      status: "running",
      permissionDecisionId: null,
      startedAt: nowIso(),
      endedAt: null,
      error: null,
    });
    const interaction = interactionService.request({
      sessionId,
      runId,
      stepId,
      toolCallId,
      kind: "clarification",
      request: {
        title: "Pick a file",
        questions: [{ id: "file", type: "text", label: "Which file?" }],
      },
    });
    return { interactionId: interaction.id, toolCallId };
  }

  /** Mirrors a later permission prompt taking the session status over. */
  function revealPermission(): void {
    store.updateSession(sessionId, {
      status: "waiting_permission",
      activeRunId: runId,
      pendingResumeToken: "permission-token",
      blockedReason: "Write access required.",
    });
  }

  function replyPermission(): void {
    store.updateSession(sessionId, {
      status: "running",
      activeRunId: runId,
      pendingResumeToken: null,
      blockedReason: null,
    });
  }

  it.each([
    ["a permission prompt is pending", revealPermission],
    ["the permission prompt was just answered", replyPermission],
  ])("accepts a form reply while %s", (_label, move) => {
    const { interactionId } = ask();
    move();
    const replied = interactionService.reply(sessionId, interactionId, {
      revision: 1,
      action: "submit",
      answers: { file: "README.md" },
    });
    expect(replied.status).toBe("answered");
    expect(replied.response).toMatchObject({ action: "submit" });
  });

  it("keeps the answered form ready for the resuming executor", () => {
    const { interactionId } = ask();
    revealPermission();
    interactionService.reply(sessionId, interactionId, {
      revision: 1,
      action: "submit",
      answers: { file: "README.md" },
    });
    expect(interactionService.ready(sessionId)).toMatchObject({
      id: interactionId,
      status: "answered",
    });
    replyPermission();
    expect(interactionService.ready(sessionId)).toMatchObject({
      id: interactionId,
    });
  });

  it.each(["completed", "interrupted", "failed", "paused", "cancelled"] as const)("accepts an unanswered form after the session became %s", (status) => {
    const { interactionId } = ask();
    const runStatus = status === "paused" ? "interrupted" : status;
    store.updateRun(runId, { status: runStatus, completedAt: nowIso() });
    store.updateSession(sessionId, {
      status,
      activeRunId: null,
      completedAt: nowIso(),
    });
    const reply = { revision: 1, action: "submit", answers: { file: "README.md" } };
    const interaction = interactionService.reply(sessionId, interactionId, reply);
    expect(interaction).toMatchObject({ status: "answered", response: reply,
      restartRequestId: `interaction-restart:${interactionId}` });
    expect(interactionService.reply(sessionId, interactionId, reply)).toEqual(interaction);
    expect(store.getSession(sessionId)).toMatchObject({ status, activeRunId: null });
    expect(store.getRun(runId).status).toBe(runStatus);
    expect(interactionService.ready(sessionId)).toBeNull();
  });

  it("does not submit an old form into a different active run", () => {
    const { interactionId } = ask();
    store.updateRun(runId, { status: "interrupted", completedAt: nowIso() });
    store.updateSession(sessionId, { status: "running", activeRunId: "new-run" });
    expect(() => interactionService.reply(sessionId, interactionId, {
      revision: 1, action: "submit", answers: { file: "README.md" },
    })).toThrow(/no longer accepts input/);
    expect(interactionService.pending(sessionId)?.id).toBe(interactionId);
  });

  it("still validates an inactive form before resolving it", () => {
    const { interactionId } = ask();
    store.updateRun(runId, { status: "interrupted", completedAt: nowIso() });
    store.updateSession(sessionId, { status: "paused", activeRunId: null });
    expect(() => interactionService.reply(sessionId, interactionId, {
      revision: 2, action: "submit", answers: { file: "README.md" },
    })).toThrow(/stale/);
    expect(() => interactionService.reply(sessionId, interactionId, {
      revision: 1, action: "submit", answers: {},
    })).toThrow(/Answer required/);
    expect(interactionService.pending(sessionId)?.id).toBe(interactionId);
  });
});
