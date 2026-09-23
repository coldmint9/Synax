import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getRawSqlite } from "../../../db/index.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { workStore } from "../work-store.js";
import {
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";
import {
  appendOnlySession,
  versionRepository,
} from "../checkpoints/version-runtime/bridge.js";
import {
  forkSimpleConversation,
  previewSimpleFork,
} from "../checkpoints/simple-fork.js";
import { captureCheckpoint } from "../checkpoints/store.js";
import { applyHistory, checkpointSummary } from "../checkpoints/operations.js";
import { createAsset, sessionHasAsset, readAsset } from "../media-assets.js";
import { runCommand } from "../tools/exec-async.js";
import { withCheckpointMutation } from "../checkpoints/mutations.js";
let sourceId: string, root: string;
const worktrees: string[] = [];
async function git(args: string[]) {
  const result = await runCommand("git", args, {
    cwd: root,
    timeoutMs: 10_000,
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
beforeEach(async () => {
  vi.stubEnv("SYNAX_VERSION_HISTORY", "boundary");
  resetAgentRuntimeFixtures();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-fork-test-"));
  await git(["init", "-q"]);
  await fs.writeFile(path.join(root, "file.txt"), "committed");
  await git(["add", "file.txt"]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "base",
  ]);
  await fs.writeFile(path.join(root, "file.txt"), "uncommitted");
  sourceId = agentSessionRuntime.create({
    ...plannerSessionInput,
    workDir: root,
  }).id;
  store.updateSession(sourceId, { status: "completed" });
});
afterEach(async () => {
  for (const directory of worktrees.splice(0))
    await git(["worktree", "remove", "--force", directory]);
  const db = getRawSqlite();
  for (const table of [
    "conversation_v3_history_requests",
    "conversation_v3_operations",
    "conversation_v3_runtime_records",
    "conversation_v3_owned_versions",
    "conversation_v3_heads",
  ])
    db.prepare(`DELETE FROM ${table}`).run();
  await fs.rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function message(id: string, content = id) {
  store.appendMessage({
    id,
    sessionId: sourceId,
    runId: null,
    stepId: null,
    role: "assistant",
    content,
    metadata: {},
    createdAt: new Date().toISOString(),
  });
}
it("copies only the chosen prefix, reuses attachment/text payloads and enforces append-only history", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  const asset = await createAsset(
    plannerSessionInput.projectId,
    "tiny.png",
    png,
    "image/png",
  );
  // Exceeds ordinary record materialization, but header copying must still work.
  const content = "A".repeat(1100 * 1024);
  store.appendMessage({
    id: "kept",
    sessionId: sourceId,
    runId: null,
    stepId: null,
    role: "assistant",
    content,
    contentParts: [{ type: "image", assetId: asset.id }],
    metadata: {},
    createdAt: "now",
  });
  const repo = versionRepository();
  const cp = repo.capture(sourceId, "reply", "kept", null, 0);
  message("future");
  const revision = repo.head(sourceId).revision;
  const result = await forkSimpleConversation(
    sourceId,
    cp.id,
    revision,
    "shared",
    "reuse_worktree",
  );
  const target = store.getSession(result.sessionId);
  expect((target.sessionMetadata?.backend as { workDir: string }).workDir).toBe(
    root,
  );
  expect(target.parentSessionId).toBeNull();
  expect(appendOnlySession(target.id)).toBe(true);
  expect(repo.count(target.id, "messages")).toBe(1);
  expect(repo.count(target.id, "runs")).toBe(0);
  const cloned = repo.page(target.id, "messages", {
    fields: ["id", "runId", "stepId"],
  }).items[0];
  expect(cloned.id).not.toBe("kept");
  expect(cloned.runId).toBeNull();
  expect(cloned.stepId).toBeNull();
  const originalHeader = repo.records.header(
    repo.recordReference(sourceId, "messages", "kept")!,
  );
  const copiedHeader = repo.records.header(
    repo.recordReference(target.id, "messages", String(cloned.id))!,
  );
  expect(copiedHeader.fields.content).toEqual(originalHeader.fields.content);
  expect(sessionHasAsset(target.id, asset.id)).toBe(true);
  expect(await readAsset(asset.id)).toEqual(png);
  expect(
    await captureCheckpoint(target.id, "reply", String(cloned.id)),
  ).toBeNull();
  expect(checkpointSummary(target.id)).toMatchObject({
    rollbackEnabled: false,
    checkpoints: [],
  });
  await expect(
    applyHistory(target.id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: 0,
      requestId: "no",
      includeFiles: false,
    }),
  ).rejects.toMatchObject({ code: "HISTORY_APPEND_ONLY" });
  expect(() =>
    repo.capture(target.id, "reply", String(cloned.id), null, 0),
  ).toThrow(/do not support/);
  workStore.create(target.id, "new work");
  expect(repo.count(target.id, "work")).toBe(0);
  expect(workStore.current(target.id)?.objective).toBe("new work");
  expect(
    await forkSimpleConversation(
      sourceId,
      cp.id,
      revision,
      "shared",
      "reuse_worktree",
    ),
  ).toEqual(result);
  await expect(
    forkSimpleConversation(sourceId, cp.id, revision, "shared", "new_worktree"),
  ).rejects.toThrow(/different input/);
  const second = await forkSimpleConversation(
    target.id,
    `message:${cloned.id}`,
    repo.head(target.id).revision,
    "again",
    "reuse_worktree",
  );
  expect(repo.count(second.sessionId, "messages")).toBe(1);
  // Shared writes keep conflict evidence, but never store before-images.
  await withCheckpointMutation(
    target.id,
    () => fs.writeFile(path.join(root, "file.txt"), "shared change"),
    false,
    [path.join(root, "file.txt")],
  );
  expect(
    getRawSqlite()
      .prepare(
        "SELECT changes_json,paths_json FROM conversation_mutations WHERE session_id=?",
      )
      .get(target.id),
  ).toMatchObject({ changes_json: "[]" });
  expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe(
    "shared change",
  );
  expect(
    getRawSqlite()
      .prepare("SELECT 1 FROM conversation_history_journal WHERE session_id=?")
      .get(target.id),
  ).toBeUndefined();
});
it("creates an independent worktree at captured HEAD, never copies dirty workspace files", async () => {
  for (let i = 0; i < 19; i++) message(`prefix-${i}`);
  message("reply");
  const repo = versionRepository(),
    cp = repo.capture(sourceId, "reply", "reply", null, 0);
  const preview = await previewSimpleFork(sourceId, cp.id, "new_worktree");
  expect(preview.canApply).toBe(true);
  const result = await forkSimpleConversation(
    sourceId,
    cp.id,
    preview.revision,
    "isolated",
    "new_worktree",
  );
  const directory = (
    store.getSession(result.sessionId).sessionMetadata?.backend as {
      workDir: string;
    }
  ).workDir;
  worktrees.push(directory);
  expect(directory).not.toBe(root);
  expect(repo.count(result.sessionId, "messages")).toBe(20);
  expect(await fs.readFile(path.join(directory, "file.txt"), "utf8")).toBe(
    "committed",
  );
  expect(await fs.readFile(path.join(root, "file.txt"), "utf8")).toBe(
    "uncommitted",
  );
  expect(await git(["worktree", "list", "--porcelain"])).toContain(directory);
  expect(appendOnlySession(result.sessionId)).toBe(true);
});
it("copies a legacy prefix without replaying its journal or cloning runtime rows", async () => {
  vi.stubEnv("SYNAX_VERSION_HISTORY", "legacy");
  sourceId = agentSessionRuntime.create({
    ...plannerSessionInput,
    workDir: root,
  }).id;
  store.updateSession(sourceId, { status: "completed" });
  message("legacy-kept");
  const cp = (await captureCheckpoint(sourceId, "reply", "legacy-kept"))!;
  message("legacy-later");
  const { historyRevision } = await import("../checkpoints/guards.js");
  const result = await forkSimpleConversation(
    sourceId,
    cp.id,
    historyRevision(sourceId),
    "legacy-fork",
    "reuse_worktree",
  );
  expect(store.listMessages(result.sessionId).map((m) => m.content)).toEqual([
    "legacy-kept",
  ]);
  expect(store.listMessages(sourceId)).toHaveLength(2);
  expect(appendOnlySession(result.sessionId)).toBe(true);
});

it("cleans unpublished readers after a worktree failure and permits a reuse fallback", async () => {
  message("recoverable");
  const repo = versionRepository(),
    cp = repo.capture(sourceId, "reply", "recoverable", null, 0);
  await fs.rename(path.join(root, ".git"), path.join(root, ".git-saved"));
  try {
    await expect(
      forkSimpleConversation(
        sourceId,
        cp.id,
        repo.head(sourceId).revision,
        "fail-worktree",
        "new_worktree",
      ),
    ).rejects.toMatchObject({ code: "FORK_WORKTREE_UNAVAILABLE" });
    expect(
      getRawSqlite()
        .prepare(
          "SELECT 1 FROM conversation_v3_heads WHERE session_id GLOB 'forkview_*'",
        )
        .get(),
    ).toBeUndefined();
    expect(store.listSessions()).toHaveLength(1);
    const result = await forkSimpleConversation(
      sourceId,
      cp.id,
      repo.head(sourceId).revision,
      "reuse-fallback",
      "reuse_worktree",
    );
    expect(appendOnlySession(result.sessionId)).toBe(true);
    expect(
      store.listMessages(result.sessionId).map((message) => message.content),
    ).toEqual(["recoverable"]);
  } finally {
    await fs.rename(path.join(root, ".git-saved"), path.join(root, ".git"));
  }
});
