import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getRawSqlite } from "../../../db/index.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { buildLoopModelMessages } from "../loop-model-messages.js";
import {
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";
import { versionRepository } from "../checkpoints/version-runtime/bridge.js";
import {
  captureCompletedReply,
  listCheckpoints,
} from "../checkpoints/store.js";
import { applyHistory } from "../checkpoints/operations.js";

let id: string;
const date = "2026-09-29T00:00:00.000Z";
const demo = "Created demo at .synax/previews/work-mode-ascii.html";
const toolEvidence = "Retained ASCII Chat Goal file contents";
const tools = { resolveModelToolName: (name: string) => name };
const project = () => JSON.stringify(buildLoopModelMessages(store, id, tools));

beforeEach(() => {
  vi.stubEnv("SYNAX_VERSION_HISTORY", "boundary");
  resetAgentRuntimeFixtures();
  id = agentSessionRuntime.create({
    ...plannerSessionInput,
    workDir: process.cwd(),
  }).id;
  store.updateSession(id, { status: "completed" });
});
afterEach(() => {
  for (const table of [
    "conversation_v3_runtime_records",
    "conversation_v3_history_requests",
    "conversation_v3_operations",
    "conversation_v3_owned_versions",
    "conversation_v3_heads",
  ])
    getRawSqlite().prepare(`DELETE FROM ${table} WHERE session_id=?`).run(id);
  vi.unstubAllEnvs();
});

function startRun(key: string) {
  store.appendMessage({
    id: `${key}-user`,
    sessionId: id,
    role: "user",
    content: `Create ${key}`,
    runId: null,
    stepId: null,
    metadata: {},
    createdAt: date,
  });
  store.appendRun({
    id: key,
    sessionId: id,
    status: "running",
    startedAt: date,
    completedAt: null,
    triggerMessageId: `${key}-user`,
    currentStep: 0,
    stopReason: null,
    model: null,
    metadata: {},
  });
}
function reply(runId: string, key: string, text: string) {
  store.appendRunStep({
    id: key,
    sessionId: id,
    runId,
    index: store.listRunSteps(runId).length,
    status: "completed",
    model: null,
    startedAt: date,
    completedAt: date,
    finishReason: "stop",
    metadata: {},
  });
  store.appendRunPart({
    id: `${key}-part`,
    sessionId: id,
    runId,
    stepId: key,
    kind: "text",
    sequence: 0,
    content: text,
    toolCallId: null,
    metadata: {},
    createdAt: date,
  });
  store.appendMessage({
    id: `${key}-reply`,
    sessionId: id,
    role: "assistant",
    content: text,
    runId,
    stepId: key,
    metadata: {},
    createdAt: date,
  });
}
function addTool(runId: string, stepId: string, text: string) {
  const toolId = `${stepId}-tool`;
  store.appendToolCall({
    id: toolId,
    sessionId: id,
    runId,
    stepId,
    modelToolCallId: null,
    toolId: "file.read",
    category: "read",
    mutability: "read",
    argsHash: "hash",
    inputSummary: "demo",
    inputRef: { path: "demo.html" },
    outputSummary: text,
    outputRef: { text },
    status: "completed",
    permissionDecisionId: null,
    startedAt: date,
    endedAt: date,
    error: null,
  });
  store.appendRunPart({
    id: `${stepId}-call`,
    sessionId: id,
    runId,
    stepId,
    kind: "tool_call",
    sequence: 1,
    content: "",
    toolCallId: toolId,
    metadata: {},
    createdAt: date,
  });
}
function finish(runId: string) {
  store.updateRun(runId, {
    status: "completed",
    completedAt: date,
    stopReason: "completed",
  });
}
async function checkpoint(stepId: string) {
  await captureCompletedReply(id, stepId);
  return listCheckpoints(id).at(-1)!;
}
async function rollback(checkpointId: string, requestId: string) {
  await applyHistory(id, {
    action: "rollback",
    checkpointId,
    revision: versionRepository().head(id).revision,
    requestId,
    includeFiles: false,
  });
}
function migrateRunVisibility() {
  getRawSqlite().exec(
    fs.readFileSync(
      new URL(
        "../../../db/migrations/0074_runtime_run_visibility.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

it("keeps the demo and tool history after the run completes beyond its reply checkpoint", async () => {
  startRun("demo-run");
  reply("demo-run", "demo-step", demo);
  addTool("demo-run", "demo-step", toolEvidence);
  expect(project()).toContain(demo);
  expect(project()).toContain(toolEvidence);
  const cp = await checkpoint("demo-step");
  finish("demo-run");
  expect(project()).toContain(demo);
  await rollback(cp.id, "rollback-demo");
  expect(store.listMessages(id).map((message) => message.content)).toContain(
    demo,
  );
  expect(store.listRuns(id).map((run) => run.id)).toEqual(["demo-run"]);
  expect(store.getRun("demo-run").status).toBe("completed");
  expect(project()).toContain(demo);
  expect(project()).toContain(toolEvidence);
});

it("retains an earlier reply in the same run while hiding later steps, tools and discarded branches", async () => {
  startRun("demo-run");
  reply("demo-run", "demo-step", demo);
  const cp = await checkpoint("demo-step");
  reply("demo-run", "later-step", "DISCARDED_LATER_REPLY");
  addTool("demo-run", "later-step", "DISCARDED_TOOL_OUTPUT");
  store.updateRun("demo-run", { currentStep: 1 });
  finish("demo-run");
  startRun("discarded-run");
  reply("discarded-run", "discarded-step", "DISCARDED_OTHER_RUN");
  finish("discarded-run");
  await rollback(cp.id, "first-rollback");
  expect(store.listRunSteps("demo-run").map((step) => step.id)).toEqual([
    "demo-step",
  ]);
  expect(project()).toContain(demo);
  expect(project()).not.toContain("DISCARDED_");
  expect(store.listRuns(id).map((run) => run.id)).toEqual(["demo-run"]);
  expect(() => store.updateRun("demo-run", { currentStep: 2 })).toThrow(
    /obsolete epoch/,
  );
  startRun("branch-run");
  reply("branch-run", "branch-step", "DISCARDED_NEW_BRANCH");
  finish("branch-run");
  const branchCheckpoint = await checkpoint("branch-step");
  await rollback(branchCheckpoint.id, "branch-rollback");
  expect(project()).toContain(demo);
  expect(project()).toContain("DISCARDED_NEW_BRANCH");
  await rollback(cp.id, "repeat-rollback");
  expect(project()).toContain(demo);
  expect(project()).not.toContain("DISCARDED_");
});

it("repairs old run locators from same-epoch steps without exposing discarded runs", async () => {
  startRun("demo-run");
  reply("demo-run", "demo-step", demo);
  const cp = await checkpoint("demo-step");
  finish("demo-run");
  // Reproduce the pre-fix UPSERT: completing a run overwrote its first position.
  const db = getRawSqlite();
  db.prepare(
    "UPDATE conversation_v3_runtime_records SET sequence=(SELECT runtime_sequence FROM conversation_v3_heads WHERE session_id=?) WHERE session_id=? AND kind='runs' AND record_id=?",
  ).run(id, id, "demo-run");
  startRun("discarded-run");
  reply("discarded-run", "discarded-step", "DISCARDED_OTHER_RUN");
  finish("discarded-run");
  await rollback(cp.id, "old-data-rollback");
  expect(project()).not.toContain(demo);
  migrateRunVisibility();
  expect(project()).toContain(demo);
  expect(project()).not.toContain("DISCARDED_OTHER_RUN");
  expect(store.getRun("demo-run").id).toBe("demo-run");
  // The migration is safe to replay and cannot borrow evidence from another epoch.
  const sequence = db
    .prepare(
      "SELECT sequence FROM conversation_v3_runtime_records WHERE session_id=? AND kind='runs' AND record_id=?",
    )
    .get(id, "demo-run");
  migrateRunVisibility();
  expect(
    db
      .prepare(
        "SELECT sequence FROM conversation_v3_runtime_records WHERE session_id=? AND kind='runs' AND record_id=?",
      )
      .get(id, "demo-run"),
  ).toMatchObject({ sequence: (sequence as { sequence: number }).sequence });
  db.prepare(
    "UPDATE conversation_v3_runtime_records SET epoch=epoch+100,sequence=999999 WHERE session_id=? AND kind='runs' AND record_id=?",
  ).run(id, "demo-run");
  migrateRunVisibility();
  expect(
    db
      .prepare(
        "SELECT sequence FROM conversation_v3_runtime_records WHERE session_id=? AND kind='runs' AND record_id=?",
      )
      .get(id, "demo-run"),
  ).toMatchObject({ sequence: 999999 });
});
