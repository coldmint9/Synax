import { recoverOrphanedCheckpointWriters } from "../checkpoints/mutations.js";
import {
  beginSnapshotPrune,
  endSnapshotPrune,
} from "../checkpoints/storage-leases.js";
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
import { pruneCheckpointBlobs } from "../checkpoints/gc.js";
import { applyHistory } from "../checkpoints/operations.js";
import { getRawSqlite } from "../../../db/index.js";
let id: string, root: string;
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-file-gc-v3-"));
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
    id: "reply",
    sessionId: id,
    runId: null,
    stepId: null,
    role: "assistant",
    content: "Before",
    metadata: {},
    createdAt: "now",
  });
  return (await captureCheckpoint(id, "reply", "reply"))!;
}
it("keeps v3 before-images and mutation evidence when there are no legacy checkpoints", async () => {
  await fs.writeFile(path.join(root, "a"), "before");
  const cp = await checkpoint();
  await withCheckpointMutation(
    id,
    () => fs.writeFile(path.join(root, "a"), "after"),
    false,
    [path.join(root, "a")],
  );
  const row = getRawSqlite()
    .prepare(
      "SELECT changes_json FROM conversation_mutations WHERE owner_session_id=?",
    )
    .get(id) as { changes_json: string };
  const hash = JSON.parse(row.changes_json)[0].before.hash;
  expect(
    getRawSqlite()
      .prepare("SELECT count(*) AS n FROM conversation_checkpoints")
      .get(),
  ).toMatchObject({ n: 0 });
  await pruneCheckpointBlobs();
  await expect(checkpointFiles.get(hash)).resolves.toEqual(
    Buffer.from("before"),
  );
  expect(
    getRawSqlite()
      .prepare(
        "SELECT count(*) AS n FROM conversation_mutations WHERE owner_session_id=?",
      )
      .get(id),
  ).toMatchObject({ n: 1 });
  await applyHistory(id, {
    checkpointId: cp.id,
    revision: versionRepository().head(id).revision,
    requestId: "undo",
    action: "rollback",
    includeFiles: true,
  });
  expect(await fs.readFile(path.join(root, "a"), "utf8")).toBe("before");
});
it("fails closed before deleting any blob if a reference source exceeds the scan budget", async () => {
  const cp = await checkpoint(),
    hash = await checkpointFiles.put(
      Buffer.from("do not delete on incomplete mark"),
    );
  getRawSqlite()
    .prepare(
      "INSERT INTO conversation_history_operations(id,session_id,request_hash,state,payload_json,created_at) VALUES('large',?,'hash','fork_preparing',?,'now')",
    )
    .run(
      id,
      JSON.stringify({
        kind: "fork",
        hash,
        padding: "x".repeat(2 * 1024 * 1024),
      }),
    );
  await expect(pruneCheckpointBlobs()).rejects.toMatchObject({
    code: "SNAPSHOT_GC_LIMIT",
  });
  expect(
    getRawSqlite()
      .prepare(
        "SELECT count(*) AS n FROM conversation_snapshot_leases WHERE kind='gc'",
      )
      .get(),
  ).toMatchObject({ n: 0 });
  await expect(checkpointFiles.get(hash)).resolves.toEqual(
    Buffer.from("do not delete on incomplete mark"),
  );
  expect(versionRepository().checkpoint(id, cp.id).id).toBe(cp.id);
});
it("streams directories and rebuilds marks without retaining hashes from an older cycle", async () => {
  await checkpoint();
  const live = await checkpointFiles.put(Buffer.from("retained")),
    garbage = await checkpointFiles.put(Buffer.from("orphan"));
  getRawSqlite()
    .prepare(
      "INSERT INTO conversation_history_operations(id,session_id,request_hash,state,payload_json,created_at) VALUES('fork-ref',?,'hash','committed',?,'now')",
    )
    .run(id, JSON.stringify({ kind: "fork", manifest: [{ hash: live }] }));
  vi.spyOn(fs, "readdir").mockImplementation(async () => {
    throw new Error("unbounded directory listing");
  });
  await pruneCheckpointBlobs();
  await expect(checkpointFiles.get(live)).resolves.toEqual(
    Buffer.from("retained"),
  );
  await expect(checkpointFiles.get(garbage)).rejects.toThrow();
  getRawSqlite()
    .prepare("DELETE FROM conversation_history_operations WHERE id='fork-ref'")
    .run();
  await pruneCheckpointBlobs();
  await expect(checkpointFiles.get(live)).rejects.toThrow();
});

it("pages orphan-writer and snapshot-lease identities rather than loading every owner", () => {
  const db = getRawSqlite();
  db.transaction(() => {
    for (let n = 0; n < 150; n++) {
      db.prepare(
        "INSERT INTO conversation_snapshot_leases(id,kind,owner_pid) VALUES(?,'capture',?)",
      ).run(`dead-${String(n).padStart(4, "0")}`, 100000 + n);
      db.prepare(
        "INSERT INTO conversation_mutations(id,session_id,owner_session_id,roots_json,state,uncertain,created_at,owner_pid) VALUES(?,?,?,'[]','open',0,'now',?)",
      ).run(`writer-${n}`, id, id, 100000 + n);
    }
  })();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("not alive"), { code: "ESRCH" });
  });
  const prepare = db.prepare.bind(db),
    sqls: string[] = [];
  vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    sqls.push(sql);
    return prepare(sql);
  });
  recoverOrphanedCheckpointWriters();
  const lease = beginSnapshotPrune();
  expect(lease).not.toBeNull();
  if (lease) endSnapshotPrune(lease);
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM conversation_mutations WHERE state='open'",
      )
      .get(),
  ).toMatchObject({ n: 0 });
  expect(
    sqls
      .filter((sql) =>
        /^SELECT .*owner_pid FROM conversation_(snapshot_leases|mutations)/.test(
          sql,
        ),
      )
      .every((sql) => /LIMIT/.test(sql)),
  ).toBe(true);
});

it("does not sweep after malformed reference JSON makes the mark incomplete", async () => {
  await checkpoint();
  const hash = await checkpointFiles.put(
    Buffer.from("keep while source is corrupt"),
  );
  getRawSqlite()
    .prepare(
      "INSERT INTO conversation_mutations(id,session_id,owner_session_id,roots_json,paths_json,changes_json,state,uncertain,created_at,format_version) VALUES('corrupt',?,?,'[]','[]','not-json','closed',0,'now',2)",
    )
    .run(id, id);
  await expect(pruneCheckpointBlobs()).rejects.toMatchObject({
    code: "SNAPSHOT_GC_LIMIT",
  });
  await expect(checkpointFiles.get(hash)).resolves.toEqual(
    Buffer.from("keep while source is corrupt"),
  );
});
