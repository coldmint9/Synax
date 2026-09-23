import { withCheckpointMutation } from "../checkpoints/mutations.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  resetAgentRuntimeFixtures,
  plannerSessionInput,
} from "./agent-runtime-fixtures.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { captureCheckpoint } from "../checkpoints/store.js";
import { planFileUndo } from "../checkpoints/file-plan.js";
import { getRawSqlite } from "../../../db/index.js";
let root: string, id: string;
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-file-plan-bounds-"));
  id = agentSessionRuntime.create({ ...plannerSessionInput, workDir: root }).id;
  store.updateSession(id, { status: "completed" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function checkpoint() {
  store.appendMessage({
    id: "reply",
    sessionId: id,
    runId: null,
    stepId: null,
    role: "assistant",
    content: "before",
    metadata: {},
    createdAt: "now",
  });
  return (await captureCheckpoint(id, "reply", "reply"))!;
}
function row(
  owner: string,
  changes: string,
  paths = "[]",
  warning: string | null = null,
) {
  getRawSqlite()
    .prepare(
      "INSERT INTO conversation_mutations(id,session_id,owner_session_id,roots_json,paths_json,changes_json,state,uncertain,created_at,format_version,warning) VALUES(?,?,?,'[]',?,?,'closed',0,'now',2,?)",
    )
    .run(crypto.randomUUID(), owner, owner, paths, changes, warning);
}
it("does not fetch or parse unrelated foreign mutation payloads when there are no owned changes", async () => {
  const cp = await checkpoint();
  row("unrelated", "invalid-json");
  const plan = await planFileUndo(cp);
  expect(plan.changes).toEqual([]);
  expect(plan.conflicts).toEqual([]);
});
it("rejects oversized owned JSON through a controlled resource error rather than full payload materialization", async () => {
  const cp = await checkpoint();
  row(
    id,
    JSON.stringify([
      {
        root,
        path: "a",
        before: null,
        after: null,
        extra: "x".repeat(2 * 1024 * 1024),
      },
    ]),
  );
  await expect(planFileUndo(cp)).rejects.toMatchObject({
    code: "HISTORY_PLAN_LIMIT",
  });
});
it("iterates many owned records without a whole-history result or ever-growing duplicate warnings", async () => {
  const cp = await checkpoint(),
    db = getRawSqlite();
  db.transaction(() => {
    for (let n = 0; n < 500; n++) row(id, "[]", "[]", "preserved warning");
  })();
  const prepare = db.prepare.bind(db),
    observed: string[] = [];
  vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
    observed.push(sql);
    return prepare(sql);
  });
  const plan = await planFileUndo(cp, false);
  expect(plan.warnings).toEqual(["preserved warning"]);
  expect(
    observed.some(
      (sql) => /owner_session_id\s*=\s*\?/.test(sql) && /LIMIT\s+\?/i.test(sql),
    ),
  ).toBe(true);
  expect(
    observed.some((sql) =>
      /SELECT \* FROM conversation_mutations WHERE sequence>\? AND state<>/i.test(
        sql,
      ),
    ),
  ).toBe(false);
});

it("uses foreign path evidence without reading unrelated oversized before-image metadata", async () => {
  await fs.writeFile(path.join(root, "a"), "before");
  const cp = await checkpoint();
  await withCheckpointMutation(
    id,
    () => fs.writeFile(path.join(root, "a"), "after"),
    false,
    [path.join(root, "a")],
  );
  row(
    "foreign",
    JSON.stringify([{ extra: "x".repeat(2 * 1024 * 1024) }]),
    JSON.stringify([{ root, path: "unrelated" }]),
  );
  const plan = await planFileUndo(cp, true);
  expect(plan.changes).toHaveLength(1);
  expect(plan.conflicts).toEqual([]);
});
