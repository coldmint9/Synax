import { agentLoopRuntime } from "../loop-runtime.js";
import { closeDb } from "../../../db/index.js";
import { agentRuntimeRoutes } from "../../../routes/agent-runtime.js";
vi.mock("../agent-stream-proxy.js", () => ({
  resumeAgentSessionInBackground: vi.fn(),
  streamAgentSession: vi.fn(),
  interruptAgentSessionsAndWait: vi.fn(),
  closeAcpAgentSessions: vi.fn(),
}));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { interactionService } from "../interaction-service.js";
import { validateControlBatch, controlToolError } from "../control-policy.js";
import { toolRegistry } from "../tool-registry.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";

beforeEach(() => {
  resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
});
function setup() {
  const session = agentSessionRuntime.create({
    projectId: "project-alpha",
    profileId: "synax",
    prompt: "Design a change",
    sessionMetadata: { mode: "plan" },
  });
  const now = new Date().toISOString();
  const run = store.appendRun({
    id: "test-run",
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
  const step = store.appendRunStep({
    id: "test-step",
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
  store.updateSession(session.id, { activeRunId: run.id });
  const call = store.appendToolCall({
    id: "test-call",
    sessionId: session.id,
    runId: run.id,
    stepId: step.id,
    modelToolCallId: "model-1",
    toolId: "human.ask",
    category: "task",
    mutability: "task",
    argsHash: "x",
    inputSummary: "",
    inputRef: {},
    outputSummary: null,
    outputRef: null,
    status: "running",
    permissionDecisionId: null,
    startedAt: now,
    endedAt: null,
    error: null,
  });
  return { session, run, step, call };
}
const questions = [
  {
    id: "scope",
    type: "single_select",
    label: "Scope?",
    required: true,
    options: [{ value: "small", label: "Small" }],
  },
];
describe("persistent human input", () => {
  it("validates answers, resumes the original call once, and retains the durable reply", () => {
    const { session, run, step, call } = setup();
    const interaction = interactionService.request({
      sessionId: session.id,
      runId: run.id,
      stepId: step.id,
      toolCallId: call.id,
      kind: "clarification",
      request: { title: "Clarify", questions },
    });
    expect(store.getSession(session.id).status).toBe("waiting_input");
    expect(() =>
      interactionService.reply(session.id, interaction.id, {
        revision: 1,
        action: "submit",
        answers: { scope: "invalid" },
      }),
    ).toThrow();
    const reply = {
      revision: 1,
      action: "submit",
      answers: { scope: "small" },
    } as const;
    interactionService.reply(session.id, interaction.id, reply);
    expect(
      interactionService.reply(session.id, interaction.id, reply).response,
    ).toEqual(reply);
    expect(interactionService.ready(session.id)?.toolCallId).toBe(call.id);
    interactionService.consume(session.id);
    expect(store.getToolCall(session.id, call.id).status).toBe("completed");
    expect(interactionService.ready(session.id)).toBeNull();
    expect(interactionService.list(session.id)[0].status).toBe("answered");
  });
  it("rejects a foreign session, stale answer and cancellation race", () => {
    const { session, run, step, call } = setup();
    const i = interactionService.request({
      sessionId: session.id,
      runId: run.id,
      stepId: step.id,
      toolCallId: call.id,
      kind: "clarification",
      request: { title: "Clarify", questions },
    });
    expect(() =>
      interactionService.reply("other", i.id, {
        revision: 1,
        action: "submit",
        answers: { scope: "small" },
      }),
    ).toThrow();
    expect(() =>
      interactionService.reply(session.id, i.id, {
        revision: 2,
        action: "submit",
        answers: { scope: "small" },
      }),
    ).toThrow();
    agentSessionRuntime.cancel(session.id);
    expect(() =>
      interactionService.reply(session.id, i.id, {
        revision: 1,
        action: "submit",
        answers: { scope: "small" },
      }),
    ).toThrow();
  });
  it("enforces the control barrier and mode restrictions at the real tool boundary", async () => {
    const { session } = setup();
    expect(
      validateControlBatch([{ toolId: "human.ask" }, { toolId: "file.write" }]),
    ).toBeTruthy();
    expect(
      validateControlBatch([{ toolId: "plan.execute" }, { toolId: "file.write" }]),
    ).toBeTruthy();
    expect(validateControlBatch([{ toolId: "human.ask" }])).toBeNull();
    expect(controlToolError(session, toolRegistry.get("bash"))).toBeTruthy();
    const write = await toolRegistry.execute(session.id, "file.write", {
      path: "never-written.txt",
      content: "no",
    });
    expect(write.record.status).toBe("denied");
  });
  it.each(["chat", "plan", "goal"] as const)(
    "exposes plan execution and mode switching in %s mode",
    (mode) => {
      const session = agentSessionRuntime.create({
        projectId: "project-alpha",
        profileId: "synax",
        prompt: "Work on this",
        sessionMetadata: { mode },
      });
      expect(controlToolError(session, toolRegistry.get("plan.execute"))).toBeNull();
      expect(controlToolError(session, toolRegistry.get("mode.switch"))).toBeNull();
    },
  );
  it("limits the one-time plan approval to execute or cancel", () => {
    const { session, run, step } = setup();
    const now = new Date().toISOString();
    const call = store.appendToolCall({
      id: "plan-call",
      sessionId: session.id,
      runId: run.id,
      stepId: step.id,
      modelToolCallId: "plan-call",
      toolId: "plan.propose",
      category: "task",
      mutability: "task",
      argsHash: "plan",
      inputSummary: "",
      inputRef: {},
      outputSummary: null,
      outputRef: null,
      status: "running",
      permissionDecisionId: null,
      startedAt: now,
      endedAt: null,
      error: null,
    });
    const interaction = interactionService.request({
      sessionId: session.id,
      runId: run.id,
      stepId: step.id,
      toolCallId: call.id,
      kind: "plan_approval",
      request: { plan: {
        title: "Plan",
        objective: "Do the work",
        steps: [{ id: "one", title: "Work", description: "Do it" }],
        acceptanceCriteria: ["Work is verified"],
      } },
    });
    expect(() => interactionService.reply(session.id, interaction.id, {
      revision: interaction.revision,
      action: "save",
    })).toThrow(/invalid action/i);
    expect(() => interactionService.reply(session.id, interaction.id, {
      revision: interaction.revision,
      action: "revise",
      message: "Change it",
    })).toThrow(/invalid action/i);
    interactionService.reply(session.id, interaction.id, {
      revision: interaction.revision,
      action: "cancel",
    });
    expect(store.getSession(session.id).sessionMetadata?.plan).toMatchObject({ status: "saved", revision: 1 });
  });
  it("keeps pending forms and acknowledged replies through a database reopen", () => {
    const { session, run, step, call } = setup();
    const i = interactionService.request({
      sessionId: session.id,
      runId: run.id,
      stepId: step.id,
      toolCallId: call.id,
      kind: "clarification",
      request: { title: "Restart test", questions },
    });
    closeDb();
    store.recoverOrphanedSessions();
    expect(interactionService.pending(session.id)?.id).toBe(i.id);
    expect(store.getSession(session.id).activeRunId).toBe(run.id);
    interactionService.reply(session.id, i.id, {
      revision: i.revision,
      action: "submit",
      answers: { scope: "small" },
    });
    closeDb();
    store.recoverOrphanedSessions();
    expect(interactionService.ready(session.id)?.id).toBe(i.id);
    interactionService.consume(session.id);
    expect(
      store.listRunParts(step.id).filter((p) => p.kind === "tool_call"),
    ).toHaveLength(1);
    expect(
      store.listRunParts(step.id).filter((p) => p.kind === "tool_result"),
    ).toHaveLength(1);
  });

  it("serves durable forms and rejects stale or unsafe HTTP state transitions", async () => {
    const { session, run, step, call } = setup();
    const i = interactionService.request({
      sessionId: session.id,
      runId: run.id,
      stepId: step.id,
      toolCallId: call.id,
      kind: "clarification",
      request: { title: "HTTP test", questions },
    });
    const listed = await agentRuntimeRoutes.request(
      `http://local/sessions/${session.id}/interactions`,
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()).interactions[0].id).toBe(i.id);
    const request = (route: string, body: unknown, method = "POST") =>
      agentRuntimeRoutes.request(
        `http://local/sessions/${session.id}/${route}`,
        {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    expect((await request("mode", { mode: "goal" }, "PATCH")).status).toBe(409);
    expect(
      (
        await request(`interactions/${i.id}/reply`, {
          revision: 99,
          action: "submit",
          answers: { scope: "small" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`interactions/${i.id}/reply`, {
          revision: 1,
          action: "submit",
          answers: { scope: "invalid" },
        })
      ).status,
    ).toBe(400);
    const accepted = await request(`interactions/${i.id}/reply`, {
      revision: 1,
      action: "submit",
      answers: { scope: "small" },
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).interaction.status).toBe("answered");
    expect(interactionService.ready(session.id)?.toolCallId).toBe(call.id);
  });
  it("forwards an explicit pause to the native producer instead of just updating the UI", async () => {
    const { session } = setup();
    const interruptProducer = vi.spyOn(agentLoopRuntime, "interruptAndWaitForSessions");
    const response = await agentRuntimeRoutes.request(
      `http://local/sessions/${session.id}/pause`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("paused");
    expect(interruptProducer).toHaveBeenCalledWith(
      [session.id],
      "User requested pause.",
    );
    interruptProducer.mockRestore();
  });
});
