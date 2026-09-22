import { RuntimeStreamWriter } from "../runtime-stream-writer.js";
import { runtimeJournal } from "../runtime-journal.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import {
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";
import {
  initializeVersionNative,
  versionRepository,
} from "../checkpoints/version-runtime/bridge.js";
import {
  captureCheckpoint,
  captureCompletedReply,
} from "../checkpoints/store.js";
import { applyHistory, previewHistory } from "../checkpoints/operations.js";
import { getRawSqlite } from "../../../db/index.js";
import { runWithExecutionContext } from "../../../lib/execution-context.js";
import type { AgentRun, AgentRunStep, ToolCallRecord } from "../contracts.js";
let id: string, root: string;
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-native-entities-"));
  const session = agentSessionRuntime.create({
    ...plannerSessionInput,
    workDir: root,
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
afterEach(async () => {
  const db = getRawSqlite();
  db.prepare(
    "DELETE FROM conversation_v3_history_requests WHERE session_id=?",
  ).run(id);
  db.prepare("DELETE FROM conversation_v3_operations WHERE session_id=?").run(
    id,
  );
  db.prepare(
    "DELETE FROM conversation_v3_owned_versions WHERE session_id=?",
  ).run(id);
  db.prepare("DELETE FROM conversation_v3_heads WHERE session_id=?").run(id);
  await fs.rm(root, { recursive: true, force: true });
});
const run = (key: string): AgentRun => ({
  id: key,
  sessionId: id,
  status: "completed",
  startedAt: key,
  completedAt: key,
  triggerMessageId: null,
  currentStep: 0,
  stopReason: "done",
  model: null,
  metadata: { executionLease: { epoch: `lease-${key}`, closed: true } },
});
const step = (key: string, runId: string): AgentRunStep => ({
  id: key,
  sessionId: id,
  runId,
  index: 0,
  status: "completed",
  model: null,
  startedAt: "now",
  completedAt: "now",
  finishReason: "done",
  metadata: {},
});
const tool = (key: string, runId: string, stepId: string): ToolCallRecord => ({
  id: key,
  sessionId: id,
  runId,
  stepId,
  modelToolCallId: null,
  toolId: "file.read",
  category: "read",
  mutability: "read",
  argsHash: "hash",
  inputSummary: "file",
  inputRef: { path: "a" },
  outputSummary: "content",
  outputRef: { text: "old" },
  status: "completed",
  permissionDecisionId: null,
  startedAt: "now",
  endedAt: "now",
  error: null,
});
async function checkpoint() {
  store.appendMessage({
    id: "answer",
    sessionId: id,
    runId: null,
    stepId: null,
    role: "assistant",
    content: "answer",
    metadata: {},
    createdAt: "now",
  });
  return (await captureCheckpoint(id, "reply", "answer"))!;
}
it("restores execution entities and scoped indexes without deleting current audit rows", async () => {
  store.appendRun(run("run-a"));
  store.appendRunStep(step("step-a", "run-a"));
  store.appendToolCall(tool("tool-a", "run-a", "step-a"));
  store.appendRunPart({
    id: "part-a",
    sessionId: id,
    runId: "run-a",
    stepId: "step-a",
    kind: "text",
    sequence: 1,
    content: "before",
    toolCallId: null,
    metadata: {},
    createdAt: "now",
  });
  const cp = await checkpoint();
  store.updateToolCall(id, "tool-a", { outputRef: { text: "future" } });
  store.appendRun(run("run-b"));
  store.appendRunStep(step("step-b", "run-b"));
  store.appendToolCall(tool("tool-b", "run-b", "step-b"));
  await applyHistory(id, {
    action: "rollback",
    includeFiles: false,
    checkpointId: cp.id,
    revision: (await previewHistory(id, cp.id, false)).revision,
    requestId: "undo",
  });
  expect(store.listRuns(id).map((row) => row.id)).toEqual(["run-a"]);
  expect(store.getToolCall(id, "tool-a").outputRef).toEqual({ text: "old" });
  expect(store.listRunToolCalls("run-a").map((row) => row.id)).toEqual([
    "tool-a",
  ]);
  expect(store.listRunParts("step-a")[0].content).toBe("before");
  expect(() => store.getRun("run-b")).toThrow(/resource|not found/i);
  expect(
    getRawSqlite()
      .prepare("SELECT id FROM agent_runtime_runs WHERE id='run-b'")
      .get(),
  ).toMatchObject({ id: "run-b" });
});
it("does not restore historical leases and fences late writers even if their old lease was reopened", async () => {
  store.appendRun(run("run-a"));
  const cp = await checkpoint();
  store.appendRun(run("run-b"));
  await applyHistory(id, {
    action: "rollback",
    includeFiles: false,
    checkpointId: cp.id,
    revision: versionRepository().head(id).revision,
    requestId: "undo",
  });
  expect(store.getRun("run-a").metadata.executionLease).toBeUndefined();
  expect(
    versionRepository().get(id, "runs", "run-a")?.metadata,
  ).not.toHaveProperty("executionLease");
  getRawSqlite()
    .prepare(
      "UPDATE agent_runtime_runs SET metadata_json=json_set(metadata_json,'$.executionLease.closed',json('false')) WHERE id='run-b'",
    )
    .run();
  expect(() =>
    runWithExecutionContext(
      {
        sessionId: id,
        runId: "run-b",
        epoch: "lease-run-b",
        hostId: "fixture",
      },
      () =>
        store.appendEvent({
          id: "late",
          sessionId: id,
          type: "thought_delta",
          timestamp: "now",
          visibility: "internal",
          summary: "late",
          payload: {},
        }),
    ),
  ).toThrow(/superseded/i);
});
it("does not replay stale stream journal records after a version switch", async () => {
  store.appendRun(run("run-a"));
  const cp = await checkpoint();
  store.appendRun(run("run-b"));
  runtimeJournal.append(id, "run-b", {
    type: "message_delta",
    runId: "run-b",
    stepId: "old",
    delta: "discarded streaming content",
  });
  expect(runtimeJournal.read(id)).toHaveLength(1);
  await applyHistory(id, {
    action: "rollback",
    includeFiles: false,
    checkpointId: cp.id,
    revision: versionRepository().head(id).revision,
    requestId: "undo",
  });
  expect(runtimeJournal.read(id)).toEqual([]);
  expect(runtimeJournal.cursor(id)).toBe(0);
  store.appendRun(run("run-c"));
  runtimeJournal.append(id, "run-c", {
    type: "message_delta",
    runId: "run-c",
    stepId: "new",
    delta: "new content",
  });
  expect(
    runtimeJournal
      .read(id)
      .map((row) => (row.chunk as { delta: string }).delta),
  ).toEqual(["new content"]);
});
it("projects current recovery status but normalizes historical active steps after rollback", async () => {
  store.appendRun(run("run-a"));
  store.appendRunStep({
    ...step("step-a", "run-a"),
    status: "running",
    completedAt: null,
  });
  getRawSqlite()
    .prepare(
      "UPDATE agent_runtime_run_steps SET status='interrupted',finish_reason='server_restarted' WHERE id='step-a'",
    )
    .run();
  expect(store.getRunStep("step-a").status).toBe("interrupted");
  const cp = await checkpoint();
  store.appendRun(run("run-b"));
  await applyHistory(id, {
    action: "rollback",
    includeFiles: false,
    checkpointId: cp.id,
    revision: versionRepository().head(id).revision,
    requestId: "undo",
  });
  expect(store.getRunStep("step-a").status).toBe("interrupted");
});

it("captures a large completed reply by metadata without materializing its text", async () => {
  store.appendRun(run("large-run"));
  store.appendRunStep(step("large-step", "large-run"));
  store.appendMessage({
    id: "large-reply",
    sessionId: id,
    runId: "large-run",
    stepId: "large-step",
    role: "assistant",
    content: "x".repeat(2 * 1024 * 1024),
    metadata: {},
    createdAt: "now",
  });
  await expect(
    captureCompletedReply(id, "large-step"),
  ).resolves.toBeUndefined();
  expect(versionRepository().checkpoints(id).items.at(-1)?.messageId).toBe(
    "large-reply",
  );
});

it("abandons a late stream finalizer after its branch was rolled back", async () => {
  store.appendRun(run("first"));
  const cp = await checkpoint();
  store.appendRun(run("popped"));
  const writer = new RuntimeStreamWriter(id, "popped");
  await applyHistory(id, {
    action: "rollback",
    includeFiles: false,
    checkpointId: cp.id,
    revision: versionRepository().head(id).revision,
    requestId: "undo-finalizer",
  });
  expect(() => writer.finish()).not.toThrow();
  expect(store.listRuns(id).map((row) => row.id)).toEqual(["first"]);
});
