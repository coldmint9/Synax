import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import NativeDatabase from "libsql";
import { auditIndexes } from "../index-audit.js";

const fixtures: Array<{ root: string; db: NativeDatabase.Database }> = [];

afterEach(() => {
  for (const { root, db } of fixtures.splice(0)) {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("database index audit", () => {
  it("reports redundant non-unique indexes without mutating the database", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-index-audit-"));
    const db = new NativeDatabase(path.join(root, "context.db"));
    fixtures.push({ root, db });
    db.exec(`
      CREATE TABLE records(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE UNIQUE INDEX records_session_revision_unique ON records(session_id, revision);
      CREATE INDEX records_session_revision_lookup ON records(session_id, revision);
    `);

    const report = auditIndexes(db, ["records"]);
    expect(report.duplicateGroups).toEqual([
      expect.objectContaining({
        table: "records",
        columns: ["session_id", "revision"],
        redundantIndexes: ["records_session_revision_lookup"],
      }),
    ]);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get("records_session_revision_lookup"),
    ).toBeTruthy();
  });

  it("keeps indexes with different column order in separate audit groups", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-index-audit-"));
    const db = new NativeDatabase(path.join(root, "context.db"));
    fixtures.push({ root, db });
    db.exec(`
      CREATE TABLE records(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL);
      CREATE INDEX records_session_sequence ON records(session_id, sequence);
      CREATE INDEX records_sequence_session ON records(sequence, session_id);
    `);

    expect(auditIndexes(db, ["records"]).duplicateGroups).toHaveLength(0);
  });
});
