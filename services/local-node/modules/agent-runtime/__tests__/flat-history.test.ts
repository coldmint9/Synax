import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AgentRuntimeMessage, AgentSession } from "../contracts.js";
vi.setConfig({ testTimeout: 30000, hookTimeout: 60000 });

let root: string;
let db: ReturnType<
  (typeof import("../../../infrastructure/database/index.js"))["getRawSqlite"]
>;
let store: (typeof import("../session-store.js"))["agentRuntimeStore"];
let simple: typeof import("../simple-history.js");
let reader: typeof import("../flat-history-reader.js");
let migration: typeof import("../flat-history-migration.js");
let operations: typeof import("../checkpoints/operations.js");
let bridge: typeof import("../checkpoints/version-runtime/bridge.js");
let close: () => void;
const now = (n: number) =>
  new Date(Date.UTC(2026, 9, 14, 0, 0, n)).toISOString();
const session = (id = "flat"): AgentSession => ({
  id,
  projectId: "project-alpha",
  parentSessionId: null,
  childSessionIds: [],
  nodeId: null,
  profileId: "planner",
  status: "completed",
  title: null,
  prompt: "original",
  contextSnapshotId: null,
  thinkingMode: "standard",
  reasoningEffort: null,
  permissionRules: [],
  createdAt: now(0),
  updatedAt: now(0),
  completedAt: now(0),
  resultSummary: null,
  blockedReason: null,
  skillIds: [],
  mcpServerIds: [],
  activeRunId: null,
  pendingResumeToken: null,
  sessionMetadata: { historyStorage: "sqlite-flat" },
});
const message = (n: number, id = "flat"): AgentRuntimeMessage => ({
  id: `${id}-m${n}`,
  sessionId: id,
  runId: null,
  stepId: null,
  role: n % 2 ? "assistant" : "user",
  content: `message ${n}`,
  metadata: {},
  createdAt: now(n),
});
function seed(count = 60, id = "flat") {
  store.createSession(session(id));
  simple.initializeSimpleHistory(id);
  for (let n = 0; n < count; n++) store.appendMessage(message(n, id));
}
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-flat-test-"));
  vi.stubEnv("DATA_ROOT", root);
  vi.stubEnv("SYNAX_HISTORY_MODE", "flat");
  vi.stubEnv("SYNAX_TRANSCRIPT_STORAGE", "jsonl");
  vi.stubEnv("LOG_LEVEL", "error");
  vi.resetModules();
  const database = await import("../../../infrastructure/database/index.js");
  db = database.getRawSqlite();
  close = database.closeDb;
  ({ agentRuntimeStore: store } = await import("../session-store.js"));
  simple = await import("../simple-history.js");
  reader = await import("../flat-history-reader.js");
  migration = await import("../flat-history-migration.js");
  operations = await import("../checkpoints/operations.js");
  bridge = await import("../checkpoints/version-runtime/bridge.js");
}, 60000);
beforeEach(async () => {
  const { resetAgentRuntimeFixtures } =
    await import("./agent-runtime-fixtures.js");
  resetAgentRuntimeFixtures();
  db.exec("PRAGMA synchronous=FULL");
});
afterAll(() => {
  close?.();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("flat SQLite conversation history", () => {
  it("creates new sessions without a version DAG even with the former JSONL flag set", async () => {
    const { agentSessionRuntime } = await import("../session-runtime.js");
    const created = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "planner",
      prompt: "hello",
    });
    expect(created.sessionMetadata?.historyStorage).toBe("sqlite-flat");
    expect(simple.simpleHistorySession(created.id)).toBe(true);
    expect(bridge.versionedSession(created.id)).toBe(false);
    store.appendMessage(message(1, created.id));
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM agent_runtime_messages WHERE session_id=?",
        )
        .get(created.id),
    ).toMatchObject({ n: 1 });
    expect(
      db.prepare("SELECT count(*) AS n FROM jsonl_payload_records").get(),
    ).toMatchObject({ n: 0 });
  });
  it("pages by sequence without duplicates and keeps old cursors valid across append", () => {
    seed();
    const first = reader.readFlatHistoryWindow("flat");
    expect(first.messages).toHaveLength(24);
    expect(first.messages[0].id).toBe("flat-m36");
    store.appendMessage(message(60));
    const second = reader.readFlatHistoryWindow(
      "flat",
      first.historyWindow.olderCursor,
    );
    const third = reader.readFlatHistoryWindow(
      "flat",
      second.historyWindow.olderCursor,
    );
    expect(
      [...third.messages, ...second.messages, ...first.messages].map(
        (item) => item.id,
      ),
    ).toEqual(Array.from({ length: 60 }, (_, n) => `flat-m${n}`));
    expect(third.historyWindow.hasEarlier).toBe(false);
    expect(() =>
      reader.readFlatHistoryWindow("other", first.historyWindow.olderCursor),
    ).toThrow();
  });
  it("bounds body reads and exposes a projection marker", () => {
    seed(2);
    store.appendMessage({
      ...message(1),
      content: "x".repeat(200000),
      metadata: { huge: "x".repeat(200000) },
    });
    const row = reader.readFlatHistoryWindow("flat").messages.at(-1)!;
    expect(String(row.content).length).toBeLessThanOrEqual(2048);
    expect(row.historyProjection).toEqual({
      omittedFields: ["content", "metadata"],
    });
    expect(store.getMessage("flat", "flat-m1")?.content.length).toBe(200000);
    expect(store.listMessages("flat").map((m) => m.id)).toEqual([
      "flat-m0",
      "flat-m1",
    ]);
  });
  it("reads a warmed window with a fixed small number of SQL statements", () => {
    seed(100);
    reader.readFlatHistoryWindow("flat");
    let calls = 0;
    const original = db.prepare.bind(db);
    Object.defineProperty(db, "prepare", {
      configurable: true,
      value(sql: string) {
        const stmt = original(sql);
        return new Proxy(stmt, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            return typeof value !== "function"
              ? value
              : (...args: unknown[]) => {
                  calls++;
                  return value.apply(target, args);
                };
          },
        });
      },
    });
    try {
      expect(reader.readFlatHistoryWindow("flat").messages).toHaveLength(24);
      expect(calls).toBeLessThanOrEqual(10);
    } finally {
      Object.defineProperty(db, "prepare", {
        configurable: true,
        value: original,
      });
    }
  });
  it("truncates permanently, invalidates cursors, clears summaries and preserves other sessions", async () => {
    seed();
    seed(2, "other");
    const first = reader.readFlatHistoryWindow("flat");
    store.updateSession("flat", {
      sessionMetadata: {
        historyStorage: "sqlite-flat",
        contextCompaction: { summary: "future" },
        plan: { future: true },
      },
      resultSummary: "future",
    });
    db.prepare(
      "INSERT INTO agent_runtime_compaction_summaries(id,session_id,summary_text) VALUES('summary','flat','future')",
    ).run();
    const cp = "flat:flat-m11";
    const preview = await operations.previewHistory("flat", cp, false);
    expect(preview.removedMessages).toBe(48);
    const request = {
      action: "rollback" as const,
      checkpointId: cp,
      revision: preview.revision,
      requestId: "cut",
      includeFiles: false,
    };
    const result = await operations.applyHistory("flat", request);
    expect(await operations.applyHistory("flat", request)).toEqual(result);
    expect(store.listMessages("flat")).toHaveLength(12);
    expect(store.listMessages("other")).toHaveLength(2);
    expect(
      store.getSession("flat").sessionMetadata?.contextCompaction,
    ).toBeUndefined();
    expect(store.getSession("flat").resultSummary).toBeNull();
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM agent_runtime_compaction_summaries WHERE session_id='flat'",
        )
        .get(),
    ).toMatchObject({ n: 0 });
    for (const table of [
      "conversation_history_operations",
      "conversation_history_journal",
      "conversation_v3_heads",
    ])
      expect(
        db
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id='flat'`)
          .get(),
      ).toMatchObject({ n: 0 });
    expect(() =>
      reader.readFlatHistoryWindow("flat", first.historyWindow.olderCursor),
    ).toThrow(/changed/);
    store.appendMessage(message(90));
    expect(store.listMessages("flat").at(-1)?.id).toBe("flat-m90");
    await expect(
      operations.applyHistory("flat", { ...request, requestId: "different" }),
    ).rejects.toMatchObject({ code: "HISTORY_STALE" });
  });
  it("rejects file restoration and active execution without changing data", async () => {
    seed(4);
    const revision = simple.simpleHistoryRevision("flat");
    const request = {
      action: "rollback" as const,
      checkpointId: "flat:flat-m1",
      revision,
      requestId: "cut",
      includeFiles: true,
    };
    await expect(
      operations.applyHistory("flat", request),
    ).rejects.toMatchObject({ code: "HISTORY_FILES_UNAVAILABLE" });
    store.updateSession("flat", { status: "running" });
    await expect(
      operations.applyHistory("flat", { ...request, includeFiles: false }),
    ).rejects.toMatchObject({ code: "HISTORY_SESSION_BUSY" });
    expect(store.listMessages("flat")).toHaveLength(4);
  });
  it("deletes later runs and rejects delayed execution writes after truncation", async () => {
    seed(4);
    const run = (id: string, n: number) => ({
      id,
      sessionId: "flat",
      status: "completed" as const,
      startedAt: now(n),
      completedAt: now(n),
      triggerMessageId: `flat-m${n}`,
      currentStep: 0,
      stopReason: null,
      model: null,
      metadata: { executionLease: { epoch: id, closed: true } },
    });
    store.appendRun(run("keep", 0));
    store.appendRun(run("remove", 2));
    store.appendMessage({ ...message(0), runId: "keep" });
    store.appendMessage({ ...message(1), runId: "keep" });
    store.appendMessage({ ...message(2), runId: "remove" });
    store.appendMessage({ ...message(3), runId: "remove" });
    await operations.applyHistory("flat", {
      action: "rollback",
      checkpointId: "flat:flat-m1",
      revision: simple.simpleHistoryRevision("flat"),
      requestId: "runs",
      includeFiles: false,
    });
    expect(store.listRuns("flat").map((run) => run.id)).toEqual(["keep"]);
    const { runWithExecutionContext } =
      await import("../../../infrastructure/runtime/execution-context.js");
    expect(() =>
      runWithExecutionContext(
        { sessionId: "flat", runId: "remove", epoch: "remove", hostId: "test" },
        () => store.appendMessage(message(8)),
      ),
    ).toThrow(/superseded|closed/);
  });
  it("supports destructive input editing with a retryable accepted run", async () => {
    seed(4);
    const request = {
      action: "edit" as const,
      checkpointId: "flat:flat-m2",
      revision: simple.simpleHistoryRevision("flat"),
      requestId: "edit",
      message: "replacement",
      includeFiles: false,
    };
    const result = await operations.applyHistory("flat", request);
    expect(result.input?.message).toBe("replacement");
    expect(result.runId).toBeTruthy();
    expect(store.listMessages("flat").map((row) => row.id)).toEqual([
      "flat-m0",
      "flat-m1",
    ]);
    expect((await operations.applyHistory("flat", request)).runId).toBe(
      result.runId,
    );
  });
  it("migrates only visible JSONL history and leaves raw entities usable", () => {
    const s = session("versioned");
    store.createSession(s);
    db.transaction(() => bridge.initializeFreshJsonlHistory(s))();
    for (let n = 0; n < 6; n++) store.appendMessage(message(n, s.id));
    store.appendRun({
      id: "old-run",
      sessionId: s.id,
      status: "completed",
      startedAt: now(0),
      completedAt: now(5),
      triggerMessageId: null,
      currentStep: 0,
      stopReason: null,
      model: null,
      metadata: {},
    });
    const before = store.listMessages(s.id);
    expect(migration.migrateFlatHistory(s.id).migrated).toBe(true);
    expect(bridge.versionedSession(s.id)).toBe(false);
    expect(simple.simpleHistorySession(s.id)).toBe(true);
    expect(store.listMessages(s.id)).toEqual(before);
    expect(store.listRuns(s.id).map((run) => run.id)).toEqual(["old-run"]);
    expect(migration.migrateFlatHistory(s.id).migrated).toBe(false);
    store.appendMessage(message(6, s.id));
    expect(store.listMessages(s.id)).toHaveLength(7);
  });
  it("rolls back failed conversion without changing the source backend", () => {
    const s = session("broken");
    store.createSession(s);
    db.transaction(() => bridge.initializeFreshJsonlHistory(s))();
    store.appendMessage(message(1, s.id));
    db.exec(
      "CREATE TRIGGER fail_flat BEFORE INSERT ON conversation_flat_heads BEGIN SELECT RAISE(ABORT,'test failure'); END",
    );
    try {
      expect(() => migration.migrateFlatHistory(s.id)).toThrow("test failure");
    } finally {
      db.exec("DROP TRIGGER fail_flat");
    }
    expect(bridge.versionedSession(s.id)).toBe(true);
    expect(store.listMessages(s.id)).toHaveLength(1);
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM agent_runtime_messages WHERE session_id=?",
        )
        .get(s.id),
    ).toMatchObject({ n: 0 });
  });
  it("serves bounded HTTP windows, timeline and Unicode content pages", async () => {
    seed(30);
    store.appendMessage({ ...message(29), content: "😀".repeat(9000) });
    const { agentRuntimeRoutes } =
      await import("../../../transport/http/agent-runtime.js");
    const window = await agentRuntimeRoutes.request(
      "/sessions/flat/history-window",
    );
    expect(window.status).toBe(200);
    expect((await window.json()).messages).toHaveLength(24);
    const timeline = await agentRuntimeRoutes.request(
      "/sessions/flat/history-timeline",
    );
    expect((await timeline.json()).items).toHaveLength(30);
    const first = await (
      await agentRuntimeRoutes.request(
        "/sessions/flat/messages/flat-m29/content",
      )
    ).json();
    expect(first.text).toBe("😀".repeat(8192));
    const second = await (
      await agentRuntimeRoutes.request(
        `/sessions/flat/messages/flat-m29/content?cursor=${first.next}&revision=${first.revision}`,
      )
    ).json();
    expect(first.text + second.text).toBe("😀".repeat(9000));
    expect(
      (
        await agentRuntimeRoutes.request(
          "/sessions/flat/messages/flat-m29/content?cursor=1",
        )
      ).status,
    ).toBe(409);
  });
  it("rolls back the entire truncation transaction when cleanup fails", async () => {
    seed(6);
    const revision = simple.simpleHistoryRevision("flat");
    db.exec(
      "CREATE TRIGGER fail_flat_cut BEFORE UPDATE ON conversation_flat_heads BEGIN SELECT RAISE(ABORT,'cut failed'); END",
    );
    try {
      await expect(
        operations.applyHistory("flat", {
          action: "rollback",
          checkpointId: "flat:flat-m1",
          revision,
          requestId: "failed",
          includeFiles: false,
        }),
      ).rejects.toThrow("cut failed");
    } finally {
      db.exec("DROP TRIGGER fail_flat_cut");
    }
    expect(store.listMessages("flat")).toHaveLength(6);
    expect(simple.simpleHistoryRevision("flat")).toBe(revision);
  });
  it("blocks pending media, and drops stopped child results when cutting", async () => {
    seed(4);
    store.createSession({ ...session("child"), parentSessionId: "flat" });
    simple.initializeSimpleHistory("child");
    store.appendMessage(message(1, "child"));
    db.prepare(
      "INSERT INTO media_jobs(id,session_id,project_id,provider_id,model_id,operation,input_json,idempotency_key,status,created_at,updated_at) VALUES('job','flat','project-alpha','p','m','image','{}','key','running',?,?)",
    ).run(now(3), now(3));
    const request = {
      action: "rollback" as const,
      checkpointId: "flat:flat-m1",
      revision: simple.simpleHistoryRevision("flat"),
      requestId: "children",
      includeFiles: false,
    };
    await expect(
      operations.applyHistory("flat", request),
    ).rejects.toMatchObject({ code: "HISTORY_SESSION_BUSY" });
    db.prepare("UPDATE media_jobs SET status='cancelled' WHERE id='job'").run();
    await operations.applyHistory("flat", request);
    expect(store.tryGetSession("child")).toBeUndefined();
    expect(simple.simpleHistorySession("child")).toBe(false);
    expect(store.getSession("flat").childSessionIds).toEqual([]);
  });
  it("keeps only the selected version prefix when converting a rolled-back session", () => {
    const s = session("branch");
    store.createSession(s);
    db.transaction(() => bridge.initializeFreshJsonlHistory(s))();
    for (let n = 0; n < 4; n++) store.appendMessage(message(n, s.id));
    const repo = bridge.versionRepository();
    const checkpoint = repo.capture(s.id, "reply", "branch-m3", null, 0);
    for (let n = 4; n < 8; n++) store.appendMessage(message(n, s.id));
    repo.rollback(s.id, {
      checkpointId: checkpoint.id,
      revision: repo.head(s.id).revision,
      requestId: "branch-cut",
      action: "rollback",
    });
    const before = store.listMessages(s.id);
    migration.migrateFlatHistory(s.id);
    expect(store.listMessages(s.id)).toEqual(before);
    expect(before.map((row) => row.id)).toEqual([
      "branch-m0",
      "branch-m1",
      "branch-m2",
      "branch-m3",
    ]);
  });
  it("retires old cleanup jobs so background maintenance cannot delete converted rows", async () => {
    const s = session("cleanup");
    store.createSession(s);
    db.transaction(() => bridge.initializeFreshJsonlHistory(s))();
    store.appendMessage(message(1, s.id));
    db.prepare(
      "INSERT INTO conversation_v3_migrations(session_id,staging_id,source_revision,state) VALUES(?,?,0,'cleanup')",
    ).run(s.id, "retired-stage");
    migration.migrateFlatHistory(s.id);
    const { maintainVersionHistory } =
      await import("../checkpoints/version-runtime/maintenance.js");
    maintainVersionHistory();
    maintainVersionHistory();
    expect(store.listMessages(s.id).map((message) => message.id)).toEqual([
      "cleanup-m1",
    ]);
    expect(
      db
        .prepare("SELECT 1 FROM conversation_v3_migrations WHERE session_id=?")
        .get(s.id),
    ).toBeUndefined();
  });
  it("normalizes duplicate legacy sequences once before enabling destructive boundaries", () => {
    store.createSession(session("legacy"));
    for (let n = 0; n < 4; n++) store.appendMessage(message(n, "legacy"));
    db.prepare(
      "UPDATE agent_runtime_messages SET sequence=0 WHERE session_id='legacy'",
    ).run();
    migration.migrateFlatHistory("legacy");
    expect(
      (
        db
          .prepare(
            "SELECT sequence FROM agent_runtime_messages WHERE session_id='legacy' ORDER BY sequence",
          )
          .all() as { sequence: number }[]
      ).map((row) => row.sequence),
    ).toEqual([1, 2, 3, 4]);
  });
  it("forks a flat prefix without building any version objects", async () => {
    seed(6);
    const objectCount = (
      db.prepare("SELECT count(*) AS n FROM conversation_v3_objects").get() as {
        n: number;
      }
    ).n;
    const { previewSimpleFork, forkSimpleConversation } =
      await import("../checkpoints/simple-fork.js");
    const preview = await previewSimpleFork(
      "flat",
      "flat:flat-m3",
      "reuse_worktree",
    );
    const fork = await forkSimpleConversation(
      "flat",
      "flat:flat-m3",
      preview.revision,
      "fork",
      "reuse_worktree",
    );
    expect(
      store.listMessages(fork.sessionId).map((row) => row.content),
    ).toEqual(["message 0", "message 1", "message 2", "message 3"]);
    expect(simple.simpleHistorySession(fork.sessionId)).toBe(true);
    expect(bridge.versionedSession(fork.sessionId)).toBe(false);
    expect(
      db.prepare("SELECT count(*) AS n FROM conversation_v3_objects").get(),
    ).toMatchObject({ n: objectCount });
  });
});
