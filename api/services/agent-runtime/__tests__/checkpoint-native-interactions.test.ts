import { VersionResources } from "../checkpoints/version-store/resources.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { clearVersionSessionFixture } from "./version-session-fixture.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import {
  initializeVersionNative,
  versionRepository,
} from "../checkpoints/version-runtime/bridge.js";
import { interactionService } from "../interaction-service.js";
import { captureCheckpoint } from "../checkpoints/store.js";
import { applyHistory } from "../checkpoints/operations.js";
import { getRawSqlite, closeDb } from "../../../db/index.js";
let id: string;
beforeEach(() => {
  resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  const session = agentSessionRuntime.create({
    projectId: "project-alpha",
    profileId: "synax",
    prompt: "Plan safely",
    sessionMetadata: { mode: "plan" },
    workDir: process.cwd(),
  });
  id = session.id;
  store.updateSession(id, { status: "completed" });
  initializeVersionNative(
    store.getSession(id),
    store.listEvents(id),
    session.contextSnapshotId
      ? store.getContextBundle(session.contextSnapshotId)
      : undefined,
  );
});
afterEach(() => {
  if (id) clearVersionSessionFixture(id);
});
const questions = [
  { id: "scope", type: "text", label: "Scope?", required: true },
];
function start(suffix: string, toolId = "human.ask") {
  const runId = `run-${suffix}`,
    stepId = `step-${suffix}`,
    toolCallId = `call-${suffix}`;
  store.appendRun({
    id: runId,
    sessionId: id,
    status: "running",
    startedAt: "now",
    completedAt: null,
    triggerMessageId: null,
    currentStep: 1,
    stopReason: null,
    model: null,
    metadata: {},
  });
  store.appendRunStep({
    id: stepId,
    runId,
    sessionId: id,
    index: 1,
    status: "running",
    model: null,
    startedAt: "now",
    completedAt: null,
    finishReason: null,
    metadata: {},
  });
  store.appendToolCall({
    id: toolCallId,
    sessionId: id,
    runId,
    stepId,
    modelToolCallId: toolCallId,
    toolId,
    category: "task",
    mutability: "task",
    argsHash: "hash",
    inputSummary: "ask",
    inputRef: {},
    outputSummary: null,
    outputRef: null,
    status: "running",
    permissionDecisionId: null,
    startedAt: "now",
    endedAt: null,
    error: null,
  });
  store.updateSession(id, { status: "running", activeRunId: runId });
  return { sessionId: id, runId, stepId, toolCallId };
}
function complete(runId: string) {
  store.updateRun(runId, { status: "completed", completedAt: "now" });
  store.updateSession(id, {
    status: "completed",
    activeRunId: null,
    pendingResumeToken: null,
  });
}
it("persists the Native clarification lifecycle and consumes an identical reply only once", () => {
  const context = start("one"),
    i = interactionService.request({
      ...context,
      kind: "clarification",
      request: { title: "Clarify", questions },
    });
  expect(interactionService.pending(id)?.id).toBe(i.id);
  expect(store.getSession(id).status).toBe("waiting_input");
  const reply = {
    revision: i.revision,
    action: "submit",
    answers: { scope: "Only API" },
  };
  expect(interactionService.reply(id, i.id, reply).status).toBe("answered");
  expect(interactionService.reply(id, i.id, reply).response).toEqual(reply);
  expect(interactionService.ready(id)?.id).toBe(i.id);
  expect(interactionService.consume(id)?.id).toBe(i.id);
  expect(interactionService.consume(id)).toBeNull();
  expect(
    store
      .listRunParts(context.stepId)
      .filter((part) => part.kind === "tool_result"),
  ).toHaveLength(1);
  expect(interactionService.list(id)).toMatchObject([
    { id: i.id, status: "answered" },
  ]);
});
it("restores interaction history but does not accept old-generation answers after rollback", async () => {
  const first = start("one"),
    i = interactionService.request({
      ...first,
      kind: "clarification",
      request: { title: "First", questions },
    });
  const reply = {
    revision: i.revision,
    action: "submit",
    answers: { scope: "Original scope" },
  };
  interactionService.reply(id, i.id, reply);
  interactionService.consume(id);
  complete(first.runId);
  store.appendMessage({
    id: "reply",
    sessionId: id,
    runId: first.runId,
    stepId: first.stepId,
    role: "assistant",
    content: "Done",
    createdAt: "now",
    metadata: {},
  });
  const cp = (await captureCheckpoint(id, "reply", "reply"))!;
  const future = start("two"),
    later = interactionService.request({
      ...future,
      kind: "clarification",
      request: { title: "Future", questions },
    });
  interactionService.cancel(id);
  complete(future.runId);
  await applyHistory(id, {
    checkpointId: cp.id,
    revision: versionRepository().head(id).revision,
    requestId: "undo",
    action: "rollback",
    includeFiles: false,
  });
  expect(interactionService.list(id).map((row) => row.id)).toEqual([i.id]);
  expect(interactionService.pending(id)).toBeNull();
  expect(interactionService.ready(id)).toBeNull();
  expect(() =>
    interactionService.reply(id, later.id, {
      revision: later.revision,
      action: "submit",
      answers: { scope: "late" },
    }),
  ).toThrow(/history|epoch|found|active/i);
  expect(() => interactionService.reply(id, i.id, reply)).toThrow(
    /history|epoch|active/i,
  );
});
it("rejects direct replay of an old pending approval even if mutable session fields are reset", async () => {
  const context = start("old"),
    i = interactionService.request({
      ...context,
      kind: "clarification",
      request: { title: "Old form", questions },
    });
  interactionService.cancel(id);
  complete(context.runId);
  store.appendMessage({
    id: "cp",
    sessionId: id,
    runId: null,
    stepId: null,
    role: "assistant",
    content: "Boundary",
    createdAt: "now",
    metadata: {},
  });
  const cp = (await captureCheckpoint(id, "reply", "cp"))!;
  store.appendMessage({
    id: "future",
    sessionId: id,
    runId: null,
    stepId: null,
    role: "assistant",
    content: "Future",
    createdAt: "now",
    metadata: {},
  });
  await applyHistory(id, {
    checkpointId: cp.id,
    revision: versionRepository().head(id).revision,
    requestId: "epoch",
    action: "rollback",
    includeFiles: false,
  });
  getRawSqlite()
    .prepare(
      "UPDATE agent_runtime_interactions SET status='pending',consumed_at=NULL WHERE id=?",
    )
    .run(i.id);
  store.updateSession(id, {
    status: "waiting_input",
    activeRunId: context.runId,
  });
  expect(interactionService.pending(id)).toBeNull();
  expect(() =>
    interactionService.reply(id, i.id, {
      revision: i.revision,
      action: "submit",
      answers: { scope: "late" },
    }),
  ).toThrow(/epoch|history/i);
});

it("whitelists durable interaction fields instead of serializing tool execution objects", () => {
  const context = start("fields"),
    input = {
      ...context,
      kind: "clarification" as const,
      request: { title: "Only schema fields", questions },
      abortSignal: new AbortController().signal,
      toolId: "human.ask",
      args: {},
    };
  const result = interactionService.request(input);
  expect(result).not.toHaveProperty("abortSignal");
  expect(result).not.toHaveProperty("args");
  expect(
    versionRepository().get(id, "interactions", result.id),
  ).not.toHaveProperty("abortSignal");
});
it("defers a versioned plan exactly once and keeps its approved state unchanged on a late execute", () => {
  const context = start("plan", "plan.propose"),
    plan = {
      title: "Small plan",
      objective: "Change only the API",
      steps: [
        {
          id: "one",
          title: "Implement",
          description: "Do the work",
          dependsOn: [],
          expectedFiles: [],
        },
      ],
      acceptanceCriteria: ["Verified"],
      assumptions: [],
      risks: [],
    };
  const form = interactionService.request({
    ...context,
    kind: "plan_approval",
    request: { plan },
  });
  const deferred = interactionService.deferPlan(id, form.id);
  expect(deferred.response?.action).toBe("save");
  expect(store.getSession(id).sessionMetadata?.plan).toMatchObject({
    status: "saved",
    revision: form.revision,
  });
  expect(() =>
    interactionService.reply(id, form.id, {
      revision: form.revision,
      action: "execute",
    }),
  ).toThrow(/resolved|cancelled/i);
  interactionService.consume(id);
  expect(interactionService.ready(id)).toBeNull();
  expect(interactionService.list(id)[0].status).toBe("answered");
});
it("rolls back the mutable answer and historical root together when quota admission fails", () => {
  const context = start("quota"),
    form = interactionService.request({
      ...context,
      kind: "clarification",
      request: { title: "Quota", questions },
    });
  const repo = versionRepository(),
    before = repo.head(id),
    resources = new VersionResources(getRawSqlite()),
    limit = resources.metadata().limit;
  resources.setMetadataLimit(resources.metadata().bytes);
  try {
    expect(() =>
      interactionService.reply(id, form.id, {
        revision: form.revision,
        action: "submit",
        answers: { scope: "change" },
      }),
    ).toThrow(/budget/i);
    expect(repo.head(id)).toEqual(before);
    expect(interactionService.pending(id)?.id).toBe(form.id);
    expect(
      getRawSqlite()
        .prepare(
          "SELECT status,response_json FROM agent_runtime_interactions WHERE id=?",
        )
        .get(form.id),
    ).toMatchObject({ status: "pending", response_json: null });
  } finally {
    resources.setMetadataLimit(limit);
  }
});

it("uses a bounded unconsumed-input index for ready lookup", () => {
  const detail = (
    getRawSqlite()
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM agent_runtime_interactions WHERE session_id=? AND version_epoch=(SELECT epoch FROM conversation_v3_heads WHERE session_id=?) AND run_id=? AND status<>'pending' AND response_json IS NOT NULL AND consumed_at IS NULL ORDER BY rowid DESC LIMIT 1",
      )
      .all(id, id, "run") as { detail: string }[]
  )
    .map((row) => row.detail)
    .join("\n");
  expect(detail).toContain("idx_interactions_unconsumed_epoch");
});

it("applies a current Native plan approval once and keeps its durable reply", () => {
  const context = start("execute", "plan.propose"),
    plan = {
      title: "Approved plan",
      objective: "Implement the scoped API change",
      steps: [
        {
          id: "one",
          title: "Implement",
          description: "Do the approved work",
          dependsOn: [],
          expectedFiles: [],
        },
      ],
      acceptanceCriteria: ["Verified"],
      assumptions: [],
      risks: [],
    };
  const form = interactionService.request({
      ...context,
      kind: "plan_approval",
      request: { plan },
    }),
    reply = { revision: form.revision, action: "execute" };
  interactionService.reply(id, form.id, reply);
  const approved = store.getSession(id).sessionMetadata;
  expect(approved?.plan).toMatchObject({
    status: "approved",
    revision: form.revision,
  });
  expect(approved?.mode).toBe("chat");
  expect(interactionService.reply(id, form.id, reply).response).toEqual(reply);
  interactionService.consume(id);
  expect(interactionService.ready(id)).toBeNull();
  expect(interactionService.list(id)[0]).toMatchObject({
    status: "answered",
    response: reply,
  });
});

it("keeps a durable versioned answer across reopen without consuming it twice", () => {
  const context = start("reopen"),
    form = interactionService.request({
      ...context,
      kind: "clarification",
      request: { title: "Resume safely", questions },
    });
  const response = {
    revision: form.revision,
    action: "submit",
    answers: { scope: "Persisted answer" },
  };
  interactionService.reply(id, form.id, response);
  closeDb();
  store.recoverOrphanedSessions();
  expect(interactionService.ready(id)?.response).toEqual(response);
  interactionService.consume(id);
  closeDb();
  expect(interactionService.ready(id)).toBeNull();
  expect(interactionService.list(id)[0]).toMatchObject({
    status: "answered",
    response,
  });
  expect(
    store
      .listRunParts(context.stepId)
      .filter((part) => part.kind === "tool_result"),
  ).toHaveLength(1);
});
