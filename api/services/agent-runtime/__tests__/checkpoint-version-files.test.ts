import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  resetAgentRuntimeFixtures,
  plannerSessionInput,
} from "./agent-runtime-fixtures.js";
import { clearVersionSessionFixture } from "./version-session-fixture.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import {
  initializeVersionNative,
  versionRepository,
} from "../checkpoints/version-runtime/bridge.js";
import { captureCheckpoint } from "../checkpoints/store.js";
import { withCheckpointMutation } from "../checkpoints/mutations.js";
import { checkpointFiles } from "../checkpoints/files.js";
import {
  checkpointSummary,
  applyHistory,
  previewHistory,
  recoverHistoryOperation,
} from "../checkpoints/operations.js";
import { assertHistoryUnlocked } from "../checkpoints/guards.js";
import { VersionResources } from "../checkpoints/version-store/resources.js";
import { getRawSqlite } from "../../../db/index.js";
let root: string, id: string;
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-v3-files-"));
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
  vi.restoreAllMocks();
  clearVersionSessionFixture(id);
  await fs.rm(root, { recursive: true, force: true });
});
async function checkpoint() {
  store.appendMessage({
    id: "before",
    sessionId: id,
    runId: null,
    stepId: null,
    role: "assistant",
    content: "Before",
    metadata: {},
    createdAt: "now",
  });
  return (await captureCheckpoint(id, "reply", "before"))!;
}
async function write(files: Record<string, string>) {
  await withCheckpointMutation(
    id,
    async () => {
      for (const [name, text] of Object.entries(files))
        await fs.writeFile(path.join(root, name), text);
    },
    false,
    Object.keys(files).map((name) => path.join(root, name)),
  );
  store.appendMessage({
    id: crypto.randomUUID(),
    sessionId: id,
    runId: null,
    stepId: null,
    role: "assistant",
    content: "After",
    metadata: {},
    createdAt: "now",
  });
}
const request = (checkpointId: string, requestId = "undo") => ({
  action: "rollback" as const,
  checkpointId,
  revision: versionRepository().head(id).revision,
  requestId,
  includeFiles: true,
});
it("restores files and versioned transcript once; a retry never overwrites later manual changes", async () => {
  await fs.writeFile(path.join(root, "a"), "before");
  const cp = await checkpoint();
  await write({ a: "after", new: "created" });
  const preview = await previewHistory(id, cp.id, true);
  expect(preview.files).toHaveLength(2);
  const body = request(cp.id);
  const result = await applyHistory(id, body);
  expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("before");
  await expect(fs.stat(path.join(root, "new"))).rejects.toThrow();
  expect(store.listMessages(id).map((row) => row.id)).toEqual(["before"]);
  await fs.writeFile(path.join(root, "a"), "manual after rollback");
  expect(await applyHistory(id, body)).toEqual(result);
  expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe(
    "manual after rollback",
  );
});
it("rejects a human conflict without truncating history or touching unrelated changes", async () => {
  await fs.writeFile(path.join(root, "a"), "before");
  const cp = await checkpoint();
  await write({ a: "after", b: "new" });
  await fs.writeFile(path.join(root, "a"), "human");
  const head = versionRepository().head(id);
  expect((await previewHistory(id, cp.id, true)).canApply).toBe(false);
  await expect(applyHistory(id, request(cp.id))).rejects.toThrow(/conflict/i);
  expect(versionRepository().head(id)).toEqual(head);
  expect(await fs.readFile(path.join(root, "b"), "utf8")).toBe("new");
});
it("compensates earlier file writes when a later write fails, leaving history unchanged", async () => {
  await fs.writeFile(path.join(root, "a"), "old-a");
  await fs.writeFile(path.join(root, "b"), "old-b");
  const cp = await checkpoint();
  await write({ a: "new-a", b: "new-b" });
  const before = versionRepository().head(id);
  const real = checkpointFiles.write.bind(checkpointFiles);
  let calls = 0;
  vi.spyOn(checkpointFiles, "write").mockImplementation(async (...args) => {
    if (++calls === 2) throw new Error("injected disk full");
    return real(...args);
  });
  await expect(applyHistory(id, request(cp.id))).rejects.toThrow(
    "injected disk full",
  );
  expect(versionRepository().head(id)).toEqual(before);
  expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("new-a");
  expect(await fs.readFile(path.join(root, "b"), "utf8")).toBe("new-b");
  expect(() => assertHistoryUnlocked(id)).not.toThrow();
});
it("compensates files if final metadata admission fails after restoration", async () => {
  await fs.writeFile(path.join(root, "a"), "old");
  const cp = await checkpoint();
  await write({ a: "new" });
  const before = versionRepository().head(id),
    budget = new VersionResources(getRawSqlite()),
    limit = budget.metadata().limit;
  const real = checkpointFiles.write.bind(checkpointFiles);
  let calls = 0;
  vi.spyOn(checkpointFiles, "write").mockImplementation(async (...args) => {
    await real(...args);
    if (++calls === 1) budget.setMetadataLimit(budget.metadata().bytes);
  });
  try {
    await expect(applyHistory(id, request(cp.id))).rejects.toThrow(/budget/i);
    expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("new");
    expect(versionRepository().head(id)).toEqual(before);
  } finally {
    budget.setMetadataLimit(limit);
  }
});
it("keeps a recovery fence when compensation meets a newer external edit", async () => {
  await fs.writeFile(path.join(root, "a"), "old-a");
  await fs.writeFile(path.join(root, "b"), "old-b");
  const cp = await checkpoint();
  await write({ a: "new-a", b: "new-b" });
  const real = checkpointFiles.write.bind(checkpointFiles);
  let calls = 0;
  vi.spyOn(checkpointFiles, "write").mockImplementation(async (...args) => {
    if (++calls === 2) {
      await fs.writeFile(path.join(root, "a"), "human during failure");
      throw new Error("write failed");
    }
    return real(...args);
  });
  await expect(applyHistory(id, request(cp.id))).rejects.toThrow(
    /Recovery conflict/i,
  );
  expect(checkpointSummary(id).recoveryRequired).toBe(true);
  expect(() => assertHistoryUnlocked(id)).toThrow(/recovery/i);
  expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe(
    "human during failure",
  );
  vi.restoreAllMocks();
  await fs.writeFile(path.join(root, "a"), "old-a");
  await recoverHistoryOperation(id);
  expect(checkpointSummary(id).recoveryRequired).toBe(false);
  expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("new-a");
  expect(() => assertHistoryUnlocked(id)).not.toThrow();
});

it("checks competing workspace owners without loading every session record", async () => {
  await fs.writeFile(path.join(root, "a"), "before");
  const cp = await checkpoint();
  await write({ a: "after" });
  vi.spyOn(store, "listSessions").mockImplementation(() => {
    throw new Error("unbounded session listing");
  });
  await applyHistory(id, request(cp.id, "bounded-locks"));
  expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("before");
});

it("preserves Git-committed writes and refuses a foreign same-content write", async () => {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-b", "master");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(root, "a"), "base");
  git("add", "a");
  git("commit", "-m", "base");
  const cp = await checkpoint();
  await write({ a: "committed" });
  git("add", "a");
  git("commit", "-m", "keep committed");
  expect((await previewHistory(id, cp.id, true)).preservedFiles).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "a", kind: "committed" }),
    ]),
  );
  await applyHistory(id, request(cp.id, "preserve-commit"));
  expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("committed");
  await write({ a: "same-content" });
  const other = agentSessionRuntime.create({
    ...plannerSessionInput,
    workDir: root,
  }).id;
  store.updateSession(other, { status: "completed" });
  await withCheckpointMutation(
    other,
    () => fs.writeFile(path.join(root, "a"), "same-content"),
    false,
    [path.join(root, "a")],
  );
  const preview = await previewHistory(id, cp.id, true);
  expect(preview.canApply).toBe(false);
  expect(
    preview.conflicts.some((conflict) =>
      /Another session/.test(conflict.reason),
    ),
  ).toBe(true);
});
