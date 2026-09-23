import { workStore } from "../work-store.js";
import { projectSessionUsage } from "../usage-projection.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getRawSqlite } from "../../../db/index.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import {
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";
import {
  boundaryOnlySession,
  versionRepository,
} from "../checkpoints/version-runtime/bridge.js";
import { readHistoryWindow } from "../checkpoints/version-runtime/window.js";
import { applyHistory } from "../checkpoints/operations.js";
import { upgradeHistory } from "../checkpoints/version-runtime/migrate.js";
import { collectDeletedHistory } from "../checkpoints/version-runtime/deletion.js";
import { maintainVersionHistory } from "../checkpoints/version-runtime/maintenance.js";
import {
  reserveExternalBytes,
  HISTORY_RESOURCE_LIMITS,
} from "../checkpoints/resource-admission.js";
import type { AgentRun, AgentRuntimeMessage } from "../contracts.js";
let id: string;
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
  const db = getRawSqlite();
  db.prepare("DELETE FROM conversation_v3_migrations").run();
  db.prepare("DELETE FROM conversation_v3_deletions").run();
  for (const table of [
    "conversation_v3_runtime_records",
    "conversation_v3_history_requests",
    "conversation_v3_operations",
    "conversation_v3_owned_versions",
    "conversation_v3_heads",
  ])
    db.prepare(`DELETE FROM ${table}`).run();
  vi.unstubAllEnvs();
});
function message(key: string, role: AgentRuntimeMessage["role"] = "assistant") {
  return store.appendMessage({
    id: key,
    sessionId: id,
    runId: null,
    stepId: null,
    role,
    content: key,
    metadata: {},
    createdAt: key,
  });
}
function run(key: string): AgentRun {
  return store.appendRun({
    id: key,
    sessionId: id,
    status: "completed",
    startedAt: key,
    completedAt: key,
    triggerMessageId: null,
    currentStep: 0,
    stopReason: "done",
    model: null,
    metadata: {},
  });
}
it("enables lightweight history by default and keeps runtime events/runs out of checkpoint objects", () => {
  expect(boundaryOnlySession(id)).toBe(true);
  expect(store.getSession(id).sessionMetadata?.historyStorage).toBe(3);
  run("run-a");
  const repo = versionRepository(),
    before = repo.head(id);
  store.appendEvent({
    id: "event-a",
    sessionId: id,
    type: "thought_delta",
    timestamp: "now",
    visibility: "internal",
    summary: "thinking",
    payload: { delta: "hello" },
  });
  expect(repo.head(id)).toEqual(before);
  expect(repo.count(id, "events")).toBe(0);
  expect(repo.count(id, "runs")).toBe(0);
  expect(store.listRuns(id).map((r) => r.id)).toEqual(["run-a"]);
  for (let i = 0; i < 320; i++) message(`m${String(i).padStart(3, "0")}`);
  const first = readHistoryWindow(id);
  expect(first.messages[0].id).toBe("m296");
  expect(first.messages.at(-1)?.id).toBe("m319");
  store.updateSession(id, { resultSummary: "state-only update must not invalidate a message cursor" });
  const older = readHistoryWindow(id, first.historyWindow.olderCursor);
  expect(older.messages.map((m) => m.id)).toHaveLength(24);
  expect(store.listRecentMessages(id)).toHaveLength(64);
  message("m320");
  expect(() => readHistoryWindow(id, first.historyWindow.olderCursor)).toThrow(
    /changed/,
  );
});
it("switches message/state visibility without undoing audit records or resurrecting discarded branches", async () => {
  const repo = versionRepository();
  run("run-1");
  message("first");
  const work = workStore.create(id, "retained objective");
  const firstStep = {
    id: "usage-before",
    sessionId: id,
    runId: "run-1",
    index: 0,
    status: "completed" as const,
    model: null,
    startedAt: "2026-09-23T00:00:00Z",
    completedAt: "2026-09-23T00:00:01Z",
    finishReason: "stop",
    metadata: { usage: { inputTokens: 10, outputTokens: 5 } },
  };
  store.appendRunStep(firstStep);
  const cp = repo.capture(id, "reply", "first", null, 0);
  run("run-2");
  message("discarded");
  store.appendRunStep({
    ...firstStep,
    id: "usage-after",
    runId: "run-2",
    startedAt: "2026-09-23T00:01:00Z",
    metadata: { usage: { inputTokens: 20, outputTokens: 6 } },
  });
  workStore.save({
    ...work,
    objective: "future objective",
    status: "completed",
    result: "future result",
  });
  const billed = projectSessionUsage(id, [id]).usage.self;
  await applyHistory(id, {
    action: "rollback",
    checkpointId: cp.id,
    revision: repo.head(id).revision,
    requestId: "rollback-1",
    includeFiles: false,
  });
  expect(store.listMessages(id).map((m) => m.id)).toEqual(["first"]);
  expect(workStore.current(id)?.objective).toBe("retained objective");
  expect(workStore.current(id)?.result).toBeNull();
  expect(projectSessionUsage(id, [id]).usage.self).toEqual(billed);
  expect(projectSessionUsage(id, [id]).context.inputTokens).toBe(10);
  expect(store.listRuns(id).map((r) => r.id)).toEqual(["run-1"]);
  expect(
    getRawSqlite()
      .prepare("SELECT id FROM agent_runtime_runs WHERE id='run-2'")
      .get(),
  ).toBeTruthy();
  expect(() => store.appendRun({ ...run("run-3"), id: "run-2" })).toThrow(
    /obsolete/,
  );
  message("new-branch");
  repo.capture(id, "reply", "new-branch", null, 0);
  expect(store.listRuns(id).map((r) => r.id)).toEqual(["run-3", "run-1"]);
  expect(store.listMessages(id).map((m) => m.id)).toEqual([
    "first",
    "new-branch",
  ]);
});
it("upgrades only transcript and current decision state, not the runtime history", async () => {
  vi.stubEnv("SYNAX_VERSION_HISTORY", "legacy");
  id = agentSessionRuntime.create({
    ...plannerSessionInput,
    workDir: process.cwd(),
  }).id;
  store.updateSession(id, { status: "completed" });
  run("legacy-run");
  message("legacy-message");
  const result = await upgradeHistory(id);
  expect(result.upgraded).toBe(true);
  expect(boundaryOnlySession(id)).toBe(true);
  expect(store.listMessages(id)[0].id).toBe("legacy-message");
  expect(versionRepository().count(id, "runs")).toBe(0);
  expect(store.listRuns(id)[0].id).toBe("legacy-run");
  store.appendEvent({
    id: "post-upgrade-event",
    sessionId: id,
    type: "progress_updated",
    timestamp: "now",
    visibility: "internal",
    summary: "new",
    payload: {},
  });
  for (let i = 0; i < 30; i++) maintainVersionHistory();
  expect(
    store.listEvents(id).some((event) => event.id === "post-upgrade-event"),
  ).toBe(true);
  expect(
    getRawSqlite()
      .prepare("SELECT 1 FROM conversation_v3_migrations WHERE session_id=?")
      .get(id),
  ).toBeUndefined();
});
it("hides a deleted session immediately and frees it in bounded resumable steps", () => {
  message("to-delete");
  run("audit-run");
  expect(store.deleteSessionTree(id)).toEqual([id]);
  expect(store.tryGetSession(id)).toBeUndefined();
  expect(store.listSessions().some((s) => s.id === id)).toBe(false);
  expect(
    getRawSqlite()
      .prepare("SELECT 1 FROM agent_runtime_sessions WHERE id=?")
      .get(id),
  ).toBeTruthy();
  for (let i = 0; i < 90; i++) collectDeletedHistory();
  expect(
    getRawSqlite()
      .prepare("SELECT 1 FROM agent_runtime_sessions WHERE id=?")
      .get(id),
  ).toBeUndefined();
});
it("rejects an oversized file reservation before allocating or writing it", async () => {
  await expect(
    reserveExternalBytes(
      process.cwd(),
      HISTORY_RESOURCE_LIMITS.externalInFlight + 1,
    ),
  ).rejects.toThrow(/budget/);
});
it("keeps message order and media retention when annotating a versioned visualization", async () => {
  const { createAsset, sessionHasAsset } = await import("../media-assets.js");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const asset = await createAsset(plannerSessionInput.projectId, "tiny.png", png, "image/png");
  const first = store.appendMessage({
    id: "visual-first", sessionId: id, runId: null, stepId: null,
    role: "assistant", content: "Preview", contentParts: [{ type: "image", assetId: asset.id }],
    metadata: {}, createdAt: "2026-09-23T00:00:00Z",
  });
  message("visual-second");
  const annotated = store.attachVisualizationMetadata(first, { source: "inline_visualization", visualization: { title: "Preview" } });
  expect(annotated?.metadata.source).toBe("inline_visualization");
  expect(store.listMessages(id).map(row => row.id)).toEqual(["visual-first", "visual-second"]);
  expect(sessionHasAsset(id, asset.id)).toBe(true);
  const ref = versionRepository().recordReference(id, "messages", first.id)!;
  expect(getRawSqlite().prepare("SELECT 1 FROM conversation_v3_asset_refs WHERE object_hash=? AND asset_id=?").get(Buffer.from(ref, "hex"), asset.id)).toBeTruthy();
});
