import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

// Synthetic, disposable database only. Never opens the user's data directory.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-flat-benchmark-"));
for (const name of [
  "SYNAX_STORAGE_OWNER_ENDPOINT",
  "SYNAX_STORAGE_OWNER_TOKEN",
  "SYNAX_STORAGE_OWNER_ROOT",
  "SYNAX_RUNTIME_HOST_ID",
  "SYNAX_RUNTIME_DATA_ROOT",
])
  delete process.env[name];
process.env.DATA_ROOT = root;
process.env.NODE_ENV = "test";
process.env.SYNAX_HISTORY_MODE = "flat";
process.env.SYNAX_TRANSCRIPT_STORAGE = "jsonl";
process.env.LOG_LEVEL = "error";
const { startStorageOwner, stopStorageOwner } =
  await import("../services/local-node/infrastructure/database/owner-client.js");
if (process.argv.includes("--owner")) startStorageOwner(root);
const { getRawSqlite, closeDb } =
  await import("../services/local-node/infrastructure/database/index.js");
try {
  const db = getRawSqlite();
  const { agentRuntimeStore: store } =
    await import("../services/local-node/modules/agent-runtime/session-store.js");
  const { initializeFreshJsonlHistory } =
    await import("../services/local-node/modules/agent-runtime/checkpoints/version-runtime/bridge.js");
  const { readHistoryWindow } =
    await import("../services/local-node/modules/agent-runtime/checkpoints/version-runtime/window.js");
  const { readFlatHistoryWindow } =
    await import("../services/local-node/modules/agent-runtime/flat-history-reader.js");
  const { migrateFlatHistory } =
    await import("../services/local-node/modules/agent-runtime/flat-history-migration.js");
  let counting = false,
    sql = 0;
  const prepare = db.prepare.bind(db);
  Object.defineProperty(db, "prepare", {
    configurable: true,
    value(query: string) {
      const statement = prepare(query);
      return new Proxy(statement, {
        get(target, key) {
          const method = Reflect.get(target, key, target);
          return typeof method !== "function"
            ? method
            : (...args: unknown[]) => {
                if (counting) sql++;
                return method.apply(target, args);
              };
        },
      });
    },
  });
  const session = store.createSession({
    id: "benchmark",
    projectId: "benchmark",
    parentSessionId: null,
    childSessionIds: [],
    nodeId: null,
    profileId: "planner",
    status: "completed",
    title: null,
    prompt: "Benchmark",
    contextSnapshotId: null,
    thinkingMode: "standard",
    permissionRules: [],
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
    completedAt: null,
    resultSummary: null,
    blockedReason: null,
    skillIds: [],
    mcpServerIds: [],
    activeRunId: null,
    pendingResumeToken: null,
    sessionMetadata: {},
  });
  db.transaction(() => initializeFreshJsonlHistory(session))();
  for (let n = 0; n < 120; n++)
    store.appendMessage({
      id: `message-${n}`,
      sessionId: session.id,
      role: n % 2 ? "assistant" : "user",
      runId: null,
      stepId: null,
      content: `${n} ` + "History benchmark. ".repeat(100),
      contentParts: [],
      metadata: {},
      createdAt: new Date(Date.UTC(2026, 9, 14, 0, 0, n)).toISOString(),
    });
  function measure(read: () => { messages: unknown[] }) {
    for (let n = 0; n < 3; n++) read();
    const durations: number[] = [];
    sql = 0;
    counting = true;
    try {
      for (let n = 0; n < 15; n++) {
        const start = performance.now();
        assert.equal(read().messages.length, 24);
        durations.push(performance.now() - start);
      }
    } finally {
      counting = false;
    }
    durations.sort((a, b) => a - b);
    return {
      medianMs: +durations[7].toFixed(2),
      p95Ms: +durations[14].toFixed(2),
      sqlPerPage: sql / 15,
    };
  }
  const before = readHistoryWindow(session.id).messages;
  const jsonl = measure(() => readHistoryWindow(session.id));
  migrateFlatHistory(session.id);
  assert.deepEqual(
    JSON.parse(JSON.stringify(readFlatHistoryWindow(session.id).messages)),
    JSON.parse(JSON.stringify(before)),
  );
  const flat = measure(() => readFlatHistoryWindow(session.id));
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        owner: process.argv.includes("--owner"),
        node: process.version,
        cpu: os.cpus()[0]?.model,
        messages: 120,
        pageSize: 24,
        cache: "warm",
        jsonl,
        flat,
        medianSpeedup: +(jsonl.medianMs / flat.medianMs).toFixed(2),
      },
      null,
      2,
    ),
  );
} finally {
  closeDb();
  stopStorageOwner();
  fs.rmSync(root, { recursive: true, force: true });
}
