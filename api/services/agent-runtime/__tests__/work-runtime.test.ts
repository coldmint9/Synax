import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { toolRegistry as agentToolRegistry } from "../tool-registry.js";
import { workRuntime } from "../work-runtime.js";
import { workStore } from "../work-store.js";
import { inputQueueService } from "../input-queue-service.js";
import { interactionService } from "../interaction-service.js";
import { goalContinuationInput } from "../goal-continuation.js";
import { workCheckpointTool } from "../tools/work-tools.js";
import { TaskStore } from "../tools/task-tools.js";
import { setSessionWorkspaceRoot } from "../tools/workspace.js";
import {
  resetAgentRuntimeFixtures,
  executorInput,
} from "./agent-runtime-fixtures.js";
import { nowIso } from "../runtime-ids.js";
import type { ToolExecutionInput } from "../contracts.js";

let root: string;
let seq = 0;
beforeEach(() => {
  resetAgentRuntimeFixtures();
  seq = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-work-fixture-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
function setup(prompt = "Fix one file and verify it") {
  const session = agentSessionRuntime.create({
    ...executorInput,
    prompt,
    permissionTier: "unrestricted",
  });
  setSessionWorkspaceRoot(session.id, root);
  const run = nextRun(session.id, prompt);
  return { session, run };
}
function nextRun(sessionId: string, prompt: string, source = "turn_request") {
  const id = `run-${++seq}`;
  const msg = store.appendMessage({
    id: `msg-${seq}`,
    sessionId,
    runId: null,
    stepId: null,
    role: "user",
    content: prompt,
    metadata: { source },
    createdAt: nowIso(),
  });
  const run = store.appendRun({
    id,
    sessionId,
    status: "running",
    startedAt: nowIso(),
    completedAt: null,
    triggerMessageId: msg.id,
    currentStep: 0,
    stopReason: null,
    model: null,
    metadata: {},
  });
  store.updateSession(sessionId, { status: "running", activeRunId: run.id });
  workRuntime.attach(sessionId, run);
  return store.getRun(run.id);
}
function step(sessionId: string, runId: string) {
  const id = `step-${++seq}`;
  store.appendRunStep({
    id,
    sessionId,
    runId,
    index: seq,
    status: "completed",
    startedAt: nowIso(),
    completedAt: nowIso(),
    model: null,
    finishReason: "tool-calls",
    metadata: { workId: workStore.current(sessionId)!.id },
  });
  return id;
}
function input(
  sessionId: string,
  runId: string,
  args: unknown,
): ToolExecutionInput {
  return {
    sessionId,
    runId,
    stepId: step(sessionId, runId),
    toolCallId: `tc-checkpoint-${seq}`,
    toolId: "work.checkpoint",
    category: "task",
    mutability: "task",
    args,
  };
}

describe("incremental goal acceptance gates", () => {
  it("records an early goal.finish as in-progress and exposes remaining criteria", async () => {
    const { session, run } = setup("Complete the goal");
    store.updateSessionMetadata(session.id, {
      mode: "goal",
      goal: { objective: "Complete the goal", status: "executing" },
      plan: {
        status: "approved",
        revision: 1,
        acceptanceCriteria: ["First criterion", "Second criterion"],
      },
    });

    const result = await workRuntime.complete(
      input(session.id, run.id, {}),
      "First criterion is not ready yet.",
      [],
    );

    expect(result.result).toMatchObject({
      status: "in_progress",
      acceptedCriteria: [],
      remainingCriteria: ["First criterion", "Second criterion"],
    });
    expect(workStore.current(session.id)).toMatchObject({
      status: "active",
      remaining: ["First criterion", "Second criterion"],
    });
    expect(store.getSession(session.id).status).toBe("running");
    expect(store.getSession(session.id).sessionMetadata?.goal).toMatchObject({
      status: "executing",
      acceptedCriteria: [],
    });
  });
});

describe("durable cooperative work runtime", () => {
  it("keeps ordinary queued input waiting across an approved goal round handoff", () => {
    const { session, run } = setup();
    const items = inputQueueService.enqueue(session.id, {
      message: "Next independent task",
    });
    expect(() =>
      workRuntime.yieldRound(
        input(session.id, run.id, {}),
        "Continue the current task",
        "Finish remaining work",
      ),
    ).not.toThrow();
    store.updateSessionMetadata(session.id, {
      mode: "goal",
      goal: { objective: "Finish current task", status: "executing" },
      plan: {
        title: "Current plan",
        objective: "Finish current task",
        revision: 1,
        status: "approved",
        executionId: "execution-1",
        acceptanceCriteria: ["Done"],
        steps: [
          {
            id: "s1",
            title: "Finish",
            description: "Finish current task",
            dependsOn: [],
            expectedFiles: [],
          },
        ],
      },
    });
    store.updateRun(run.id, {
      status: "completed",
      stopReason: "round_yielded",
      metadata: {
        ...store.getRun(run.id).metadata,
        goalExecutionId: "execution-1",
      },
    });
    store.updateSession(session.id, { status: "completed", activeRunId: null });
    expect(goalContinuationInput(session.id, run.id)?.messageSource).toBe(
      "system_injection",
    );
    expect(inputQueueService.list(session.id)).toEqual(items);
    inputQueueService.markForceInject(session.id, items[0].id);
    expect(goalContinuationInput(session.id, run.id)?.messageSource).toBe(
      "system_injection",
    );
  });

  it("requires a forced steering message to be processed before yielding", () => {
    const { session, run } = setup();
    const items = inputQueueService.enqueue(session.id, {
      message: "Change current direction",
    });
    inputQueueService.markForceInject(session.id, items[0].id);
    expect(() =>
      workRuntime.yieldRound(input(session.id, run.id, {}), "Pause"),
    ).toThrow(/user input is waiting/i);
  });

  it("reuses work and stall state across continue runs", () => {
    const { session } = setup();
    const original = workStore.current(session.id)!;
    original.noProgressSteps = 2;
    workStore.save(original);
    const next = nextRun(session.id, "继续");
    expect(next.metadata.workId).toBe(original.id);
    expect(workStore.current(session.id)?.noProgressSteps).toBe(2);
  });

  it.each(["Provide the missing detail", "继续"])('ends a blocked goal without a form and resumes on a new user turn: %s', message => {
    const { session, run } = setup("Complete the goal");
    store.updateSessionMetadata(session.id, {
      mode: 'goal',
      goal: { objective: 'Complete the goal', status: 'executing' },
      plan: { status: 'approved', revision: 1, acceptanceCriteria: ['Goal checked'] },
    });
    const workId = workStore.current(session.id)!.id;
    const result = workRuntime.reportBlocker(input(session.id, run.id, {}), 'Missing external input');
    expect(result.suspend).toBeUndefined();
    expect(interactionService.pending(session.id)).toBeNull();
    expect(workStore.current(session.id)).toMatchObject({ status: 'active', reason: 'Missing external input' });
    expect(store.getSession(session.id).sessionMetadata?.goal).toMatchObject({ status: 'blocked' });

    const next = nextRun(session.id, message);
    expect(next.metadata.workId).toBe(workId);
    expect(workStore.current(session.id)).toMatchObject({ status: 'active', reason: null, result: null });
    expect(store.getSession(session.id).sessionMetadata).toMatchObject({
      plan: { status: 'approved', revision: 1 },
      goal: { status: 'executing' },
    });
  });

  it('keeps an approved goal and its work when a user adds an instruction before acceptance', () => {
    const { session } = setup('Complete the goal');
    store.updateSessionMetadata(session.id, {
      mode: 'goal', goal: { objective: 'Complete the goal', status: 'executing' },
      plan: { status: 'approved', revision: 1, acceptanceCriteria: ['Goal checked'] },
    });
    const workId = workStore.current(session.id)!.id;
    nextRun(session.id, 'Also check the edge case');
    expect(workStore.current(session.id)?.id).toBe(workId);
    expect(store.getSession(session.id).sessionMetadata).toMatchObject({
      plan: { status: 'approved', revision: 1 }, goal: { status: 'executing' },
    });
  });

  it("starts fresh work when continuing after a user-cancelled work item", () => {
    const { session } = setup("Continue the cancelled task");
    const cancelled = workStore.current(session.id)!;
    cancelled.status = "cancelled";
    cancelled.reason = "Stopped by user.";
    workStore.save(cancelled);
    store.updateSessionMetadata(session.id, {
      manualStop: { at: nowIso(), reason: "Stopped by user." },
    });

    const next = nextRun(session.id, "继续");

    expect(next.metadata.workId).not.toBe(cancelled.id);
    expect(workStore.current(session.id)).toMatchObject({
      status: "active",
      reason: null,
    });
    expect(store.getSession(session.id).sessionMetadata?.manualStop).toBeNull();
  });

  it("pauses an active goal without completing its work, then continues the same work", () => {
    const { session } = setup("Finish the remaining steps");
    store.updateSessionMetadata(session.id, {
      mode: "goal",
      goal: { objective: "Finish the remaining steps", status: "executing" },
      plan: { status: "approved", revision: 1, acceptanceCriteria: ["Done"] },
    });
    const workId = workStore.current(session.id)!.id;

    expect(agentSessionRuntime.cancel(session.id).status).toBe("paused");
    expect(workStore.current(session.id)).toMatchObject({ id: workId, status: "active" });
    expect(store.getSession(session.id).sessionMetadata?.goal).toMatchObject({ status: "executing" });

    workRuntime.resumePaused(session.id);
    const resumed = nextRun(session.id, "Continue the unfinished work", "system_injection");
    expect(resumed.metadata.workId).toBe(workId);
    expect(workStore.current(session.id)).toMatchObject({ id: workId, status: "active" });
    expect(store.getSession(session.id).sessionMetadata?.manualStop).toBeNull();
  });

  it("reopens the work and goal cancelled by an older pause on one-click continue", () => {
    const { session } = setup("Finish the remaining steps");
    store.updateSessionMetadata(session.id, {
      mode: "goal",
      goal: { objective: "Finish the remaining steps", status: "executing" },
      plan: { status: "approved", revision: 1, acceptanceCriteria: ["Done"] },
    });
    agentSessionRuntime.cancel(session.id);
    const old = workStore.current(session.id)!;
    workStore.save({ ...old, status: "cancelled", reason: "Stopped by user." });
    store.updateSessionMetadata(session.id, {
      goal: { objective: "Finish the remaining steps", status: "cancelled", reason: "Stopped by user." },
    });

    workRuntime.resumePaused(session.id);
    const resumed = nextRun(session.id, "Continue the unfinished work", "system_injection");
    expect(resumed.metadata.workId).toBe(old.id);
    expect(workStore.current(session.id)).toMatchObject({ status: "active", reason: null, result: null });
    expect(store.getSession(session.id).sessionMetadata?.goal).toMatchObject({ status: "executing" });
  });

  it("opens a fresh work on continue after the previous work completed", async () => {
    const { session, run } = setup("Explain an already known fact");
    await workRuntime.complete(
      input(session.id, run.id, {}),
      "The answer is available.",
    );
    const original = workStore.current(session.id)!;
    expect(original).toMatchObject({
      status: "completed",
      result: "The answer is available.",
    });

    const next = nextRun(session.id, "继续");

    // A completed work is a historical record, not a gate for the next round: reusing it made the
    // loop finish at step 0 with the previous result and silently swallow the user's turn.
    expect(next.metadata.workId).not.toBe(original.id);
    expect(workStore.current(session.id)).toMatchObject({
      status: "active",
      objective: "Explain an already known fact",
      result: null,
    });
    expect(store.getSession(session.id).status).toBe("running");
  });

  it("keeps reusing a completed work for a bare continuation inside a goal workflow", () => {
    const { session } = setup("Complete the goal");
    store.updateSessionMetadata(session.id, {
      mode: "goal",
      goal: { objective: "Complete the goal", status: "executing" },
    });
    const original = workStore.current(session.id)!;
    workStore.save({ ...original, status: "completed", result: "Previously accepted work." });

    const next = nextRun(session.id, "继续");

    // Goal workflows report a finished goal through the goal layer, so the terminal work stays.
    expect(next.metadata.workId).toBe(original.id);
    expect(workStore.current(session.id)).toMatchObject({
      id: original.id,
      status: "completed",
      result: "Previously accepted work.",
    });
  });

  it("all TODOs done triggers a decision, not automatic success", () => {
    const { session, run } = setup();
    const tasks = new TaskStore();
    const task = tasks.create("Implement", "One focused change");
    tasks.update(task.id, { status: "completed" });
    tasks.persist(session.id);
    workRuntime.afterStep(
      session.id,
      step(session.id, run.id),
      workStore.current(session.id)!.progressVersion,
    );
    expect(workStore.current(session.id)?.status).toBe("closing");
    expect(store.getRun(run.id).status).toBe("running");
    expect(workRuntime.toolError(session.id, "bash")).toBeNull();
    expect(workRuntime.prompt(session.id)).toContain(
      "Finish this turn with a concise answer",
    );
  });

  it("stalled steps nudge without gating tools, and a concrete continuation resets the advisory state", async () => {
    const { session, run } = setup();
    const doStall = (steps: number) => {
      for (let n = 0; n < steps; n++) {
        const w = workStore.current(session.id)!;
        workRuntime.afterStep(
          session.id,
          step(session.id, run.id),
          w.progressVersion,
        );
      }
    };
    doStall(3);
    expect(workStore.current(session.id)).toMatchObject({
      status: "active",
      noProgressSteps: 3,
    });
    expect(workStore.current(session.id)?.reason).toMatch(/No new information/);
    expect(workRuntime.toolError(session.id, "bash")).toBeNull();

    doStall(3);
    expect(workStore.current(session.id)).toMatchObject({
      status: "closing",
      noProgressSteps: 6,
    });
    expect(workRuntime.toolError(session.id, "bash")).toBeNull();

    doStall(3);
    expect(workStore.current(session.id)).toMatchObject({
      status: "closing",
      noProgressSteps: 9,
    });
    await workCheckpointTool.execute(
      input(session.id, run.id, {
        action: "continue",
        summary: "Inspect the remaining behavior",
        unmetRequirement: "Verify changed behavior",
        nextAction: "Run a focused check",
        expectedEvidence: "Successful verification",
        evidence: [],
      }),
    );
    expect(workStore.current(session.id)).toMatchObject({
      status: "active",
      decisionFailures: 0,
    });
    expect(workStore.current(session.id)?.noProgressSteps).toBe(0);
  });

  it("new read discoveries and negative search results remain progress", () => {
    const { session, run } = setup();
    for (let n = 0; n < 6; n++) {
      const before = workStore.current(session.id)!.progressVersion;
      const stepId = step(session.id, run.id);
      const call = store.appendToolCall({
        id: `read-${n}`,
        sessionId: session.id,
        runId: run.id,
        stepId,
        modelToolCallId: null,
        toolId: "rg",
        category: "read",
        mutability: "read",
        argsHash: `hash-${n}`,
        inputRef: { query: `hypothesis-${n}`, path: "." },
        inputSummary: "",
        outputRef: { matches: [] },
        outputSummary: "No matches",
        status: "completed",
        permissionDecisionId: null,
        startedAt: nowIso(),
        endedAt: nowIso(),
        error: null,
      });
      workRuntime.recordTool(call);
      workRuntime.afterStep(session.id, stepId, before);
    }
    expect(workStore.current(session.id)).toMatchObject({
      status: "active",
      noProgressSteps: 0,
    });
  });

  it("requires current-version verification after changes and rejects stale/cross-work proof", async () => {
    const { session, run } = setup();
    store.updateSessionMetadata(session.id, { mode: 'goal' });
    fs.writeFileSync(path.join(root, "source.txt"), "first");
    const w = workStore.current(session.id)!;
    w.hasChanges = true;
    w.changeVersion++;
    workStore.save(w);
    await expect(
      workRuntime.complete(input(session.id, run.id, {}), "Done"),
    ).rejects.toThrow("Missing current-version verification");
    const result = await agentToolRegistry.execute(
      session.id,
      "verification.run",
      {
        command: `node -e "if(require('fs').readFileSync('source.txt','utf8')!=='first')process.exit(1)"`,
        criterion: "Source is correct",
        purpose: "Check the changed file",
        scope: ["source.txt"],
      },
      { runId: run.id, stepId: step(session.id, run.id) },
    );
    expect(result.record.error).toBeNull();
    expect((result.record.outputRef as any).verification.status).toBe(
      "success",
    );
    await expect(
      workRuntime.complete(input(session.id, run.id, {}), "Done", [
        {
          criterion: "Source",
          summary: "checked",
          toolCallIds: ["foreign-proof"],
        },
      ]),
    ).rejects.toThrow("belong to this work");
    fs.writeFileSync(path.join(root, "source.txt"), "changed later");
    await expect(workRuntime.complete(input(session.id, run.id, {}), "Done", [
      { criterion: "Source", summary: "Old receipt", toolCallIds: [result.record.id] },
    ])).rejects.toThrow("Stale or unsuccessful verification evidence");

    await expect(
      workRuntime.complete(input(session.id, run.id, {}), "Done"),
    ).rejects.toThrow("current-version verification");
    fs.writeFileSync(path.join(root, "source.txt"), "first");
    await workRuntime.complete(
      input(session.id, run.id, {}),
      "Verified change delivered",
    );
    expect(store.getSession(session.id).status).toBe("completed");
    expect(store.getRun(run.id).status).toBe("completed");
  });

  it("rejects a superseded citation with the remedy and a stable message", async () => {
    const { session, run } = setup();
    store.updateSessionMetadata(session.id, { mode: "goal" });
    const file = path.join(root, "source.txt");
    fs.writeFileSync(file, "first");
    const staged = workStore.current(session.id)!;
    staged.hasChanges = true;
    staged.changeVersion++;
    workStore.save(staged);
    const verified = await agentToolRegistry.execute(
      session.id,
      "verification.run",
      { command: 'node -e "process.exit(0)"', criterion: "Source is correct", purpose: "Check the changed file", scope: ["source.txt"] },
      { runId: run.id, stepId: step(session.id, run.id) },
    );
    expect((verified.record.outputRef as any).verification.status).toBe("success");
    fs.writeFileSync(file, "later");
    const cite = () =>
      workRuntime.complete(input(session.id, run.id, {}), "Done", [
        { criterion: "Source is correct", summary: "Reused an outdated receipt", toolCallIds: [verified.record.id] },
      ]);
    const firstError = await cite().then(() => null, (error: Error) => error.message);
    expect(String(firstError)).toContain("Stale or unsuccessful verification evidence");
    expect(String(firstError)).toContain("Source is correct");
    expect(String(firstError)).toContain("verification.run");
    const secondError = await cite().then(() => null, (error: Error) => error.message);
    expect(String(secondError)).toBe(String(firstError));
    expect(workStore.current(session.id)!.status).toBe("active");
  });

  it("marks superseded verification receipts as unusable in the runtime snapshot", async () => {
    const { session, run } = setup();
    store.updateSessionMetadata(session.id, { mode: "goal" });
    const file = path.join(root, "source.txt");
    fs.writeFileSync(file, "first");
    const staged = workStore.current(session.id)!;
    staged.hasChanges = true;
    staged.changeVersion++;
    workStore.save(staged);
    await agentToolRegistry.execute(
      session.id,
      "verification.run",
      { command: 'node -e "process.exit(0)"', criterion: "Source is correct", purpose: "Check the changed file", scope: ["source.txt"] },
      { runId: run.id, stepId: step(session.id, run.id) },
    );
    const changed = workStore.current(session.id)!;
    changed.changeVersion++;
    workStore.save(changed);
    const prompt = workRuntime.prompt(session.id);
    expect(prompt).toContain('"superseded":true');
    expect(prompt).toContain("rerun verification.run for the changed scope");
  });

  it("repoints a superseded verification citation at the current receipt", async () => {
    const { session, run } = setup();
    store.updateSessionMetadata(session.id, { mode: "goal" });
    const file = path.join(root, "source.txt");
    const verify = () =>
      agentToolRegistry.execute(
        session.id,
        "verification.run",
        { command: 'node -e "process.exit(0)"', criterion: "Source is correct", purpose: "Check the changed file", scope: ["source.txt"] },
        { runId: run.id, stepId: step(session.id, run.id) },
      );
    fs.writeFileSync(file, "first");
    const staged = workStore.current(session.id)!;
    staged.hasChanges = true;
    staged.changeVersion++;
    workStore.save(staged);
    const early = await verify();
    expect((early.record.outputRef as any).verification.status).toBe("success");
    fs.writeFileSync(file, "second");
    const changed = workStore.current(session.id)!;
    changed.changeVersion++;
    workStore.save(changed);
    const current = await verify();
    expect(current.record.id).not.toBe(early.record.id);
    await workRuntime.complete(input(session.id, run.id, {}), "Delivered", [
      { criterion: "Source is correct", summary: "Cited the receipt from before the last change", toolCallIds: [early.record.id] },
    ]);
    expect(workStore.current(session.id)!.evidence[0].toolCallIds).toEqual([current.record.id]);
    expect(store.getSession(session.id).status).toBe("completed");
  });

  it("forbids automatic stash baselines and unscoped validation without a risk", async () => {
    const { session, run } = setup();
    store.updateSessionMetadata(session.id, { mode: 'goal' });
    expect(
      workRuntime.toolError(session.id, "bash", {
        command: "git stash push -u -m baseline-check",
      }),
    ).toMatch(/explicit user/);
    const result = await agentToolRegistry.execute(
      session.id,
      "verification.run",
      {
        command: "npm test",
        criterion: "Filter",
        purpose: "Just in case",
        scope: ["."],
      },
      { runId: run.id, stepId: step(session.id, run.id) },
    );
    expect(result.record.error).toMatch(/unresolved risk/);
  });

  it("context.read rejects historical tool and Work retrieval", async () => {
    const { session, run } = setup();
    for (const kind of ["tool", "work", "references"]) {
      const result = await agentToolRegistry.execute(
        session.id,
        "context.read",
        { kind, id: "anything" },
        { runId: run.id, stepId: step(session.id, run.id) },
      );
      expect(result.record.error).toBeTruthy();
    }
  });

  it("context references cannot read another session", async () => {
    const a = setup();
    const b = setup();
    const result = await agentToolRegistry.execute(
      a.session.id,
      "context.read",
      { kind: "message", id: b.run.triggerMessageId! },
      { runId: a.run.id, stepId: step(a.session.id, a.run.id) },
    );
    expect(result.record.error).toMatch(/accessible session/);
  });
});
