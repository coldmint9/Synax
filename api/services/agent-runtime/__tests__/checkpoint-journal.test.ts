import { recordSessionFileRead, assertSessionFileReadForWrite, rebuildSessionFileReads } from "../read-tracker.js";
import { filterHistoryFileReads } from "../checkpoints/state.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  resetAgentRuntimeFixtures,
  plannerSessionInput,
} from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { getRawSqlite } from "../../../db/index.js";
import { captureCheckpoint, getCheckpoint } from "../checkpoints/store.js";
import { applyHistory, previewHistory } from "../checkpoints/operations.js";
import { checkpointFiles } from "../checkpoints/files.js";
import { withCheckpointMutation } from "../checkpoints/mutations.js";
let root: string, id: string;
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-journal-"));
  id = agentSessionRuntime.create({ ...plannerSessionInput, workDir: root }).id;
  store.updateSession(id, { status: "completed" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const message = (key: string, text = key) =>
  store.appendMessage({
    id: key,
    sessionId: id,
    role: "assistant",
    content: text,
    runId: null,
    stepId: null,
    metadata: {},
    createdAt: new Date().toISOString(),
  });
describe("lightweight history stack", () => {
  it("creates constant-size checkpoints without reading a large unrelated build directory or copying history", async () => {
    await fs.mkdir(path.join(root, "out"));
    const f = await fs.open(path.join(root, "out", "large.zip"), "w");
    await f.truncate(2 * 1024 * 1024 * 1024);
    await f.close();
    const read = vi.spyOn(checkpointFiles, "version"),
      put = vi.spyOn(checkpointFiles, "put");
    message("first", "x".repeat(2 * 1024 * 1024));
    const a = (await captureCheckpoint(id, "reply", "first"))!;
    for (let i = 0; i < 20; i++) message(`later-${i}`, "y".repeat(1000));
    const b = (await captureCheckpoint(id, "reply", "later-19"))!;
    expect(JSON.stringify(a.payload).length).toBeLessThan(512);
    expect(JSON.stringify(b.payload).length).toBeLessThan(512);
    expect(a.payload).not.toHaveProperty("history");
    expect(a.payload).not.toHaveProperty("manifests");
    expect(read).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    const duplicated = getRawSqlite()
      .prepare(
        "SELECT count(*) AS count FROM conversation_history_journal WHERE table_name='agent_runtime_messages' AND before_json IS NOT NULL",
      )
      .get() as { count: number };
    expect(duplicated.count).toBe(0);
  });
  it("restores updated/deleted retained records and removes inserted suffix records, including INSERT OR REPLACE", async () => {
    message("retained", "original");
    const cp = (await captureCheckpoint(id, "reply", "retained"))!;
    message("retained", "rewritten");
    message("new", "new suffix");
    getRawSqlite()
      .prepare("DELETE FROM agent_runtime_messages WHERE id='retained'")
      .run();
    await applyHistory(id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: 0,
      requestId: "undo",
    }).catch((e) => {
      throw e;
    });
    expect(store.listMessages(id).map((m) => m.content)).toEqual(["original"]);
  });
  it("coalesces mutable row updates within a boundary and can pop several rounds repeatedly", async () => {
    message("a");
    store.updateSessionMetadata(id, { counter: 0 });
    const a = (await captureCheckpoint(id, "reply", "a"))!;
    for (let i = 1; i <= 30; i++)
      store.updateSessionMetadata(id, { counter: i });
    const rows = getRawSqlite()
      .prepare(
        "SELECT count(*) AS count FROM conversation_history_journal WHERE table_name='agent_runtime_sessions' AND session_id=? AND sequence>?",
      )
      .get(id, a.payload.boundary.cursor) as { count: number };
    expect(rows.count).toBe(1);
    message("b");
    const b = (await captureCheckpoint(id, "reply", "b"))!;
    store.updateSessionMetadata(id, { counter: 99 });
    message("c");
    await applyHistory(id, {
      action: "rollback",
      checkpointId: b.id,
      revision: 0,
      requestId: "b",
    });
    expect(store.getSession(id).sessionMetadata?.counter).toBe(30);
    await applyHistory(id, {
      action: "rollback",
      checkpointId: a.id,
      revision: 1,
      requestId: "a",
    });
    expect(store.getSession(id).sessionMetadata?.counter).toBe(0);
    expect(store.listMessages(id).map((m) => m.id)).toEqual(["a"]);
  });
  it("does not attribute directory changes made by an untracked command to the session", async () => {
    await fs.writeFile(path.join(root, "outside"), "human");
    message("a");
    const cp = (await captureCheckpoint(id, "reply", "a"))!;
    await withCheckpointMutation(id, () =>
      fs.writeFile(path.join(root, "outside"), "command effect"),
    );
    const preview = await previewHistory(id, cp.id);
    expect(preview.files).toEqual([]);
    expect(preview.warnings.length).toBeGreaterThan(0);
    expect(preview.canApply).toBe(true);
    await applyHistory(id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: 0,
      requestId: "untracked",
    });
    expect(await fs.readFile(path.join(root, "outside"), "utf8")).toBe(
      "command effect",
    );
  });
  it("allows conversation-only trimming despite manual file conflicts", async () => {
    await fs.writeFile(path.join(root, "file"), "before");
    message("a");
    const cp = (await captureCheckpoint(id, "reply", "a"))!;
    await withCheckpointMutation(
      id,
      () => fs.writeFile(path.join(root, "file"), "agent"),
      false,
      [path.join(root, "file")],
    );
    message("b");
    await fs.writeFile(path.join(root, "file"), "human");
    expect((await previewHistory(id, cp.id, true)).canApply).toBe(false);
    expect((await previewHistory(id, cp.id, false)).canApply).toBe(true);
    await applyHistory(id, {
      action: "rollback",
      checkpointId: cp.id,
      revision: 0,
      requestId: "chat",
      includeFiles: false,
    });
    expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe("human");
    expect(store.listMessages(id).map((m) => m.id)).toEqual(["a"]);
  });
  it("upgrades a legacy failed checkpoint into an explicit transcript-only boundary", async () => {
    message("a");
    message("b");
    const db = getRawSqlite();
    db.prepare(
      "INSERT INTO conversation_checkpoints(id,session_id,ordinal,kind,message_id,step_id,mutation_cursor,payload_json,created_at) VALUES ('old',?,1,'reply','a',NULL,0,?,?)",
    ).run(
      id,
      JSON.stringify({
        version: 1,
        error: "Snapshot file exceeds the 128 MiB safety limit.",
      }),
      new Date().toISOString(),
    );
    const migration = await fs.readFile(
      path.resolve("api/db/migrations/0049_conversation_undo_journal.sql"),
      "utf8",
    );
    db.exec(
      migration.slice(migration.indexOf("UPDATE conversation_checkpoints")),
    );
    const cp = getCheckpoint(id, "old");
    expect(cp.payload.boundary.legacy).toBe(true);
    expect((await previewHistory(id, "old")).warnings.length).toBeGreaterThan(
      0,
    );
    await applyHistory(id, {
      action: "rollback",
      checkpointId: "old",
      revision: 0,
      requestId: "legacy",
    });
    expect(store.listMessages(id).map((m) => m.id)).toEqual(["a"]);
  });
  it("requires a fresh read after trimming history without restoring current files", async () => {
    const db=getRawSqlite();
    const addRead=(key:string)=>db.prepare("INSERT INTO agent_runtime_tool_calls(id,session_id,tool_id,category,input_summary,input_ref_json,status,started_at,ended_at) VALUES (?,?,'file.read','read','file',?,'completed',?,?)").run(key,id,JSON.stringify({path:"file"}),new Date().toISOString(),new Date().toISOString());
    await fs.writeFile(path.join(root,"file"),"old");addRead("old-read");recordSessionFileRead(id,"file");message("point");const cp=(await captureCheckpoint(id,"reply","point"))!;
    await fs.writeFile(path.join(root,"file"),"new protected contents");addRead("future-read");recordSessionFileRead(id,"file");
    await applyHistory(id,{action:"rollback",checkpointId:cp.id,revision:0,requestId:"read-reset",includeFiles:false});
    rebuildSessionFileReads(id,filterHistoryFileReads(id,store.listToolCalls(id)));
    expect(()=>assertSessionFileReadForWrite(id,"file")).toThrow(/not read/);
    addRead("fresh-read");rebuildSessionFileReads(id,filterHistoryFileReads(id,store.listToolCalls(id)));
    expect(()=>assertSessionFileReadForWrite(id,"file")).not.toThrow();
  });

});
