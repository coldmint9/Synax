import type Database from "libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionObjects } from "../checkpoints/version-store/objects.js";
import { atomicVersionWrite } from "../checkpoints/version-store/transaction.js";
import { assertDatabaseWriteAllowed } from "../../../lib/execution-context.js";
import { versionDatabase } from "./version-store-fixture.js";

let db: Database.Database, objects: VersionObjects;
beforeEach(() => { db = versionDatabase(); objects = new VersionObjects(db, { maxBytes: 16 * 1024 * 1024, maxObjects: 10000 }); });
afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe("transaction failure containment", () => {
  it("preserves SQLITE_FULL after SQLite automatically rolls back a nested write", () => {
    const pages = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
    db.exec(`PRAGMA max_page_count=${pages + 1}`);
    let error: unknown;
    try { atomicVersionWrite(db, () => objects.put("chunk", Buffer.alloc(65536, 1))); }
    catch (failure) { error = failure; }
    expect(error).toMatchObject({ code: "SQLITE_FULL" });
    expect(db.inTransaction).toBe(false);
    expect(objects.stats()).toEqual({ objects: 0, bytes: 0 });
    expect(() => objects.put("chunk", Buffer.from("must not auto-commit"))).toThrow(/reopen|unsafe/i);
  });

  it("does not commit an outer action that swallowed a failed savepoint rollback", () => {
    const execute = db.exec.bind(db);
    let fail = true;
    vi.spyOn(db, "exec").mockImplementation(sql => {
      if (fail && sql.startsWith("ROLLBACK TO SAVEPOINT")) { fail = false; throw new Error("injected rollback failure"); }
      return execute(sql);
    });
    expect(() => atomicVersionWrite(db, () => {
      try {
        atomicVersionWrite(db, () => { objects.put("chunk", Buffer.from("must not commit")); throw new Error("action failed"); });
      } catch { /* A caller must not be able to commit the leaked inner write. */ }
    })).toThrow(/reopen|unsafe/i);
    expect(db.inTransaction).toBe(false);
    expect(objects.stats()).toEqual({ objects: 0, bytes: 0 });
    expect(() => objects.put("chunk", Buffer.from("new"))).toThrow(/reopen|unsafe/i);
    expect(() => assertDatabaseWriteAllowed(db, ":memory:")).toThrow(/reopen|unsafe/i);
  });
});
