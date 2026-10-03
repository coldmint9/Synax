import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import NativeDatabase from "libsql";
import { applyMaintenance, planMaintenance, reportStorage } from "../storage-maintenance.js";

const fixtures: Array<{ root: string; db: NativeDatabase.Database }> = [];
function dbFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-storage-"));
  const db = new NativeDatabase(path.join(root, "context.db"));
  db.exec(`
    CREATE TABLE agent_runtime_processes(id TEXT, session_id TEXT, state TEXT, ended_at TEXT, command_label TEXT, kind TEXT);
    CREATE TABLE agent_runtime_stream_records(sequence INTEGER PRIMARY KEY, session_id TEXT, chunk_json TEXT);
    CREATE TABLE agent_runtime_events(id TEXT PRIMARY KEY, session_id TEXT, payload_json TEXT);
    CREATE TABLE agent_runtime_sessions(id TEXT PRIMARY KEY, status TEXT);
    CREATE VIRTUAL TABLE agent_search_messages USING fts5(text);
  `);
  fixtures.push({ root, db });
  return { root, db };
}

afterEach(() => {
  for (const { root, db } of fixtures.splice(0)) {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("storage maintenance", () => {
  it("reports free pages and runtime lifecycle categories", () => {
    const { root, db } = dbFixture();
    db.prepare("INSERT INTO agent_runtime_events VALUES(?,?,?)").run("event", "session", "{}");
    const report = reportStorage(db, path.join(root, "context.db"));
    expect(report.categories.some((entry) => entry.category === "events")).toBe(true);
    expect(report.rows.agent_runtime_events).toBe(1);
    expect(report.pageSize).toBeGreaterThan(0);
    expect(report.integrity).toBe("ok");
  });

  it("plans bounded cleanup without mutating rows and preserves authoritative events", () => {
    const { root, db } = dbFixture();
    const old = new Date(Date.now() - 31 * 86400_000).toISOString();
    db.prepare("INSERT INTO agent_runtime_processes VALUES(?,?,?,?,?,?)").run("process", null, "closed", old, "git", "command");
    db.prepare("INSERT INTO agent_runtime_sessions VALUES(?,?)").run("session", "completed");
    db.prepare("INSERT INTO agent_runtime_events VALUES(?,?,?)").run("event", "session", "{}");
    const insert = db.prepare("INSERT INTO agent_runtime_stream_records VALUES(?,?,?)");
    for (let sequence = 1; sequence <= 1030; sequence++)
      insert.run(sequence, "session", JSON.stringify({ sequence }));

    const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const plan = planMaintenance(db, root);
    expect(plan.closedOwnerlessProcessRows).toBe(1);
    expect(plan.replayRows).toBe(6);
    expect(count("agent_runtime_processes")).toBe(1);
    expect(count("agent_runtime_stream_records")).toBe(1030);

    const applied = applyMaintenance(db, plan, root);
    expect(applied.deletedProcessRows).toBe(1);
    expect(applied.deletedReplayRows).toBe(6);
    expect(count("agent_runtime_stream_records")).toBe(1024);
    expect(count("agent_runtime_events")).toBe(1);
    expect(db.prepare("SELECT min(sequence) AS first FROM agent_runtime_stream_records").get()).toMatchObject({ first: 7 });
  });
});
