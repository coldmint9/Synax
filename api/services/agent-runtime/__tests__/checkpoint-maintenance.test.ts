import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetAgentRuntimeFixtures,
  plannerSessionInput,
} from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { getRawSqlite } from "../../../db/index.js";
import { captureCheckpoint } from "../checkpoints/store.js";
import { withCheckpointMutation } from "../checkpoints/mutations.js";
import {
  applyHistory,
  previewHistory,
  checkpointSummary,
} from "../checkpoints/operations.js";
import {
  visitConversation,
  expireFileUndo,
  FILE_UNDO_RETENTION_MS,
} from "../checkpoints/retention.js";
import { pruneCheckpointBlobs } from "../checkpoints/gc.js";
import { checkpointFiles } from "../checkpoints/files.js";
let root: string, id: string;
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-undo-maintenance-"));
  id = agentSessionRuntime.create({ ...plannerSessionInput, workDir: root }).id;
  store.updateSession(id, { status: "completed" });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function checkpoint() {
  store.appendMessage({
    id: "reply",
    sessionId: id,
    role: "assistant",
    content: "ready",
    runId: null,
    stepId: null,
    metadata: {},
    createdAt: new Date().toISOString(),
  });
  return (await captureCheckpoint(id, "reply", "reply"))!;
}
const write = (content: string) =>
  withCheckpointMutation(
    id,
    () => fs.writeFile(path.join(root, "file"), content),
    false,
    [path.join(root, "file")],
  );
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
async function initGit() {
  git("init", "-b", "master");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  await fs.writeFile(path.join(root, "file"), "base");
  git("add", "file");
  git("commit", "-m", "base");
}
describe("file undo cleanup boundaries", () => {
  it("expires file undo after 24 inactive hours but keeps conversation checkpoints and real files", async () => {
    await fs.writeFile(path.join(root, "file"), "old");
    const cp = await checkpoint();
    await write("new");
    const record = getRawSqlite()
      .prepare(
        "SELECT changes_json FROM conversation_mutations WHERE owner_session_id=?",
      )
      .get(id) as { changes_json: string };
    const hash = JSON.parse(record.changes_json)[0].before.hash;
    getRawSqlite()
      .prepare(
        "UPDATE conversation_history_access SET last_access_at=? WHERE session_id=?",
      )
      .run(Date.now() - FILE_UNDO_RETENTION_MS - 1, id);
    expect(expireFileUndo()).toBe(1);
    expect(checkpointSummary(id).checkpoints[0].available).toBe(true);
    const preview = await previewHistory(id, cp.id);
    expect(preview.canApply).toBe(true);
    expect(preview.files).toEqual([]);
    expect(preview.preservedFiles[0].kind).toBe("expired");
    await pruneCheckpointBlobs();
    await expect(checkpointFiles.get(hash)).rejects.toThrow();
    await applyHistory(id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: 0,
      requestId: "expired",
    });
    expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe("new");
  });
  it("a poll does not renew retention; an explicit visit does, but cannot resurrect expired before-images", async () => {
    const cp = await checkpoint();
    await write("new");
    const now = Date.now();
    getRawSqlite()
      .prepare(
        "UPDATE conversation_history_access SET last_access_at=? WHERE session_id=?",
      )
      .run(now - FILE_UNDO_RETENTION_MS + 10_000, id);
    checkpointSummary(id);
    await previewHistory(id, cp.id);
    const access = () =>
      Number(
        (
          getRawSqlite()
            .prepare(
              "SELECT last_access_at FROM conversation_history_access WHERE session_id=?",
            )
            .get(id) as { last_access_at: number }
        ).last_access_at,
      );
    expect(access()).toBe(now - FILE_UNDO_RETENTION_MS + 10_000);
    visitConversation(id, now);
    expect(access()).toBe(now);
    expect(expireFileUndo(now + FILE_UNDO_RETENTION_MS - 1)).toBe(0);
    visitConversation(id, now + FILE_UNDO_RETENTION_MS + 1);
    expect((await previewHistory(id, cp.id)).preservedFiles[0].kind).toBe(
      "expired",
    );
  });
  it("preserves committed changes, still trims conversation, and reports the file", async () => {
    await initGit();
    const cp = await checkpoint();
    await write("committed agent change");
    git("add", "file");
    git("commit", "-m", "agent output");
    store.appendMessage({
      id: "future",
      sessionId: id,
      role: "user",
      content: "future",
      runId: null,
      stepId: null,
      metadata: {},
      createdAt: new Date().toISOString(),
    });
    const preview = await previewHistory(id, cp.id);
    expect(preview.files).toEqual([]);
    expect(preview.preservedFiles[0]).toMatchObject({
      path: "file",
      kind: "committed",
    });
    await applyHistory(id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: 0,
      requestId: "committed",
    });
    expect(store.listMessages(id).map((m) => m.id)).toEqual(["reply"]);
    expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe(
      "committed agent change",
    );
  });
  it("undoes later uncommitted writes without crossing the Git commit boundary", async () => {
    await initGit();
    const cp = await checkpoint();
    await write("committed");
    git("add", "file");
    git("commit", "-m", "keep");
    await write("uncommitted");
    const preview = await previewHistory(id, cp.id);
    expect(preview.files).toHaveLength(1);
    expect(preview.preservedFiles.some((f) => f.kind === "committed")).toBe(
      true,
    );
    await applyHistory(id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: 0,
      requestId: "mixed",
    });
    expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe(
      "committed",
    );
  });
  it("does not treat staging alone as a commit", async () => {
    await initGit();
    const cp = await checkpoint();
    await write("staged");
    git("add", "file");
    const index = git("write-tree");
    expect((await previewHistory(id, cp.id)).files).toHaveLength(1);
    await applyHistory(id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: 0,
      requestId: "staged",
    });
    expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe("base");
    expect(git("write-tree")).toBe(index);
  });
  it("never restores previously revoked permissions", async () => {
    const cp = await checkpoint();
    const rules = [
      { gate: "write" as const, pattern: "*", action: "deny" as const },
    ];
    store.updateSession(id, {
      permissionRules: rules,
      sessionMetadata: {
        ...store.getSession(id).sessionMetadata,
        permissionTier: "readonly",
      },
    });
    await applyHistory(id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: 0,
      requestId: "permissions",
    });
    expect(store.getSession(id).permissionRules).toEqual(rules);
  });
  it("preserves files while Git is unreadable without discarding undo data or claiming a commit", async () => {
    await initGit();
    const cp = await checkpoint();
    await write("uncommitted");
    await fs.rename(path.join(root, ".git"), path.join(root, "saved-git"));
    const preview = await previewHistory(id, cp.id);
    expect(preview.files).toEqual([]);
    expect(preview.preservedFiles[0].kind).toBe("git_unverified");
    await fs.rename(path.join(root, "saved-git"), path.join(root, ".git"));
    expect((await previewHistory(id, cp.id)).files).toHaveLength(1);
  });
  it("supports file undo in an unborn Git repository", async () => {
    git("init", "-b", "master");
    const cp = await checkpoint();
    await write("new uncommitted file");
    expect((await previewHistory(id, cp.id)).files).toHaveLength(1);
    await applyHistory(id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: 0,
      requestId: "unborn",
    });
    await expect(fs.stat(path.join(root, "file"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("preserves a committed deletion rather than recreating the deleted file", async () => {
    await initGit();
    const cp = await checkpoint();
    await withCheckpointMutation(
      id,
      () => fs.unlink(path.join(root, "file")),
      false,
      [path.join(root, "file")],
    );
    git("add", "-A");
    git("commit", "-m", "delete");
    const preview = await previewHistory(id, cp.id);
    expect(preview.preservedFiles[0].kind).toBe("committed");
    await applyHistory(id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: 0,
      requestId: "deletion",
    });
    await expect(fs.stat(path.join(root, "file"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("does not resurrect expired before-images when a visit races an in-flight writer", async () => {
    const cp=await checkpoint();const now=Date.now();
    let entered!:()=>void, release!:()=>void;
    const started=new Promise<void>(r=>entered=r), gate=new Promise<void>(r=>release=r);
    const operation=withCheckpointMutation(id,async()=>{entered();await gate;await fs.writeFile(path.join(root,"file"),"old execution");},false,[path.join(root,"file")]);
    await started;
    getRawSqlite().prepare("UPDATE conversation_history_access SET last_access_at=? WHERE session_id=?").run(now-FILE_UNDO_RETENTION_MS-1,id);
    visitConversation(id,now);release();await operation;
    expect(expireFileUndo(now+1)).toBe(1);
    await write("new execution");
    const preview=await previewHistory(id,cp.id);
    expect(preview.preservedFiles.some(file=>file.kind==="expired")).toBe(true);
    expect(preview.files).toHaveLength(1);
    await applyHistory(id,{action:"rollback",checkpointId:cp.id,revision:0,requestId:"visit-race"});
    expect(await fs.readFile(path.join(root,"file"),"utf8")).toBe("old execution");
  });

});
