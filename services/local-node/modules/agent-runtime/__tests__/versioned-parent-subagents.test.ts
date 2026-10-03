import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getRawSqlite } from "../../../infrastructure/database/index.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import {
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";
import {
  boundaryOnlySession,
  versionedSession,
  versionRepository,
} from "../checkpoints/version-runtime/bridge.js";
import { archiveChildrenBeyondBoundary } from "../checkpoints/version-runtime/child-sessions.js";
import { applyHistory } from "../checkpoints/operations.js";
import type { AgentRuntimeMessage } from "../contracts.js";

let rootId: string;

function child(parentId: string, prompt: string) {
  return agentSessionRuntime.create({
    ...plannerSessionInput,
    profileId: "explorer",
    parentSessionId: parentId,
    prompt,
  });
}
function message(key: string) {
  return store.appendMessage({
    id: key,
    sessionId: rootId,
    runId: null,
    stepId: null,
    role: "assistant" as AgentRuntimeMessage["role"],
    content: key,
    metadata: {},
    createdAt: key,
  });
}
/** Pin a legacy child's creation time relative to the checkpoint boundary so the
 *  before/after assertion never depends on test runtime speed. */
function pinCreatedAt(sessionId: string, iso: string): void {
  getRawSqlite()
    .prepare("UPDATE agent_runtime_sessions SET created_at=? WHERE id=?")
    .run(iso, sessionId);
}
function replyCheckpoint(): { checkpointId: string; createdAt: string } {
  const repo = versionRepository(),
    cp = repo.capture(rootId, "reply", "first", null, 0);
  return {
    checkpointId: cp.id,
    createdAt: repo.checkpoint(rootId, cp.id).createdAt,
  };
}
function archivedRow(sessionId: string) {
  // The wrapped sqlite handle attaches `_metadata` to every row, so project the two
  // columns explicitly before comparing.
  const row = getRawSqlite()
    .prepare(
      "SELECT archived_at, archive_batch_id FROM agent_runtime_sessions WHERE id=?",
    )
    .get(sessionId) as
    | { archived_at: string | null; archive_batch_id: string | null }
    | undefined;
  return row
    ? {
        archived_at: row.archived_at,
        archive_batch_id: row.archive_batch_id,
      }
    : undefined;
}
beforeEach(() => {
  vi.stubEnv("SYNAX_VERSION_HISTORY", "boundary");
  resetAgentRuntimeFixtures();
  rootId = agentSessionRuntime.create({
    ...plannerSessionInput,
    workDir: process.cwd(),
  }).id;
  store.updateSession(rootId, { status: "completed" });
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

it("creates a subagent under a versioned history root", () => {
  expect(boundaryOnlySession(rootId)).toBe(true);
  const created = child(rootId, "Collect read-only evidence.");
  // The child itself stays a legacy session: versioned history remains root-only.
  expect(versionedSession(created.id)).toBe(false);
  expect(store.getSession(created.id).parentSessionId).toBe(rootId);
  expect(store.getSession(rootId).childSessionIds).toContain(created.id);
  expect(store.listSessionTree(rootId).map((session) => session.id)).toEqual([
    rootId,
    created.id,
  ]);
});

it("archives children spawned in the branch a versioned rollback discards", async () => {
  const early = child(rootId, "Early child.");
  store.updateSession(early.id, { status: "completed" });
  message("first");
  const { checkpointId, createdAt } = replyCheckpoint();
  const late = child(rootId, "Late child.");
  store.updateSession(late.id, { status: "completed" });
  pinCreatedAt(early.id, new Date(Date.parse(createdAt) - 1000).toISOString());
  pinCreatedAt(late.id, new Date(Date.parse(createdAt) + 1000).toISOString());
  // Spawning a child writes the parent's state version, so a rollback always sends
  // the revision the caller last observed; read it the way a refreshed view would.
  const revision = versionRepository().head(rootId).revision;

  await applyHistory(rootId, {
    action: "rollback",
    checkpointId,
    revision,
    requestId: "rollback-1",
    includeFiles: false,
  });

  // The retained transcript still references the early child, so it stays visible.
  expect(store.listSessionTree(rootId).map((session) => session.id)).toEqual([
    rootId,
    early.id,
  ]);
  // The late child is archived as its own recoverable batch, so it leaves the tree
  // (getSession only resolves live sessions) without being destroyed.
  expect(archivedRow(late.id)).toEqual({
    archived_at: expect.any(String),
    archive_batch_id: late.id,
  });
  expect(() => store.getSession(late.id)).toThrow(/not found/i);
  expect(store.getSession(early.id).status).toBe("completed");
  // A repeated pass over the same boundary must not re-archive or double-count.
  expect(archiveChildrenBeyondBoundary(rootId, createdAt)).toEqual([]);
  expect(store.restoreArchivedBatch(late.id)).toContain(late.id);
  // Restoring the batch brings the child back into the tree; order comes from the
  // parent's live childSessionIds, so compare membership instead of position.
  expect(
    store
      .listSessionTree(rootId)
      .map((session) => session.id)
      .sort(),
  ).toEqual([rootId, early.id, late.id].sort());
});

it("refuses a versioned rollback while a descendant is still running", async () => {
  message("first");
  const { checkpointId } = replyCheckpoint();
  child(rootId, "Still running.");
  await expect(
    applyHistory(rootId, {
      action: "rollback",
      checkpointId,
      revision: versionRepository().head(rootId).revision,
      requestId: "rollback-busy",
      includeFiles: false,
    }),
  ).rejects.toThrow(/Stop the session and its agents/);
  // A refused rollback changes nothing.
  expect(store.listSessionTree(rootId)).toHaveLength(2);
});
