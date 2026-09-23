import { readFileSync } from "node:fs";
import Database from "libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionObjects } from "../checkpoints/version-store/objects.js";
import { VersionTree } from "../checkpoints/version-store/tree.js";
import { atomicVersionWrite } from "../checkpoints/version-store/transaction.js";
import { versionDatabase } from "./version-store-fixture.js";

let db: Database.Database, objects: VersionObjects;
beforeEach(() => { db = versionDatabase(); objects = new VersionObjects(db, { maxBytes: 16 * 1024 * 1024, maxObjects: 10000 }); });
afterEach(() => db.close());
const count = (id: string) => (db.prepare("SELECT ref_count AS n FROM conversation_v3_objects WHERE hash=?").get([Buffer.from(id, "hex")]) as { n: number }).n;

describe("compact immutable reference representation", () => {
  it("stores binary identities and a single compact adjacency list without edge indexes", () => {
    const child = objects.put("chunk", Buffer.from("child"));
    const parent = objects.put("record", Buffer.from("parent"), [child]);
    const row = db.prepare("SELECT typeof(hash) AS type,length(hash) AS bytes FROM conversation_v3_objects LIMIT 1").get();
    expect(row).toMatchObject({ type: "blob", bytes: 32 });
    expect(db.prepare("SELECT length(refs) AS bytes FROM conversation_v3_objects WHERE hash=?").get([Buffer.from(parent, "hex")])).toMatchObject({ bytes: 32 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='conversation_v3_edges'").get()).toBeUndefined();
    expect(objects.get(parent).references).toEqual([child]);
  });

  it("counts unique parent references exactly once and rolls back failed increments", () => {
    const child = objects.put("chunk", Buffer.from("child"));
    expect(count(child)).toBe(0);
    const parent = objects.put("record", Buffer.from("parent"), [child, child]);
    expect(count(child)).toBe(1);
    expect(objects.put("record", Buffer.from("parent"), [child])).toBe(parent);
    expect(count(child)).toBe(1);
    objects.put("record", Buffer.from("other"), [child]);
    expect(count(child)).toBe(2);
    expect(() => atomicVersionWrite(db, () => { objects.put("record", Buffer.from("aborted"), [child]); throw new Error("abort"); })).toThrow("abort");
    expect(count(child)).toBe(2);
  });

  it("prevents in-place mutation of immutable payloads and reference lists", () => {
    const child = objects.put("chunk", Buffer.from("child"));
    expect(() => db.prepare("UPDATE conversation_v3_objects SET payload=?").run([Buffer.from("tamper")])).toThrow(/immutable/i);
    expect(objects.get(child).bytes.toString()).toBe("child");
  });

  it("uses small reference positions in tree payloads rather than duplicated hex hashes", () => {
    const changes = Array.from({ length: 128 }, (_, i) => ({ key: String(i).padStart(4, "0"), value: objects.put("chunk", Buffer.from(`value-${i}`)) }));
    const tree = new VersionTree(objects), root = tree.update(null, changes)!;
    const stored = objects.get(root, "tree"), raw = JSON.parse(stored.bytes.toString());
    expect(raw.v).toBe(2);
    expect(typeof raw.entries[0][1]).toBe("number");
    expect(stored.bytes.length).toBeLessThan(4096);
    expect(stored.references).toHaveLength(128);
    expect(tree.get(root, "0042")).toBe(changes[42].value);
  });

  it("checks oversized packed references before materializing them", () => {
    const child = objects.put("chunk", Buffer.from("child"));
    db.exec("DROP TRIGGER conversation_v3_objects_immutable; PRAGMA ignore_check_constraints=ON;");
    db.prepare("UPDATE conversation_v3_objects SET refs=? WHERE hash=?").run(Buffer.alloc(1024 * 1024), Buffer.from(child, "hex"));
    expect(() => objects.get(child)).toThrow(/integrity/i);
  });

  it("does not destructively upgrade a populated unpublished prototype", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.exec("PRAGMA foreign_keys=ON");
      for (const name of ["0051_conversation_version_core.sql", "0052_conversation_version_heads.sql"])
        legacy.exec(readFileSync(new URL(`../../../db/migrations/${name}`, import.meta.url), "utf8"));
      legacy.prepare("INSERT INTO conversation_v3_objects(hash,kind,payload,logical_bytes) VALUES(?,'chunk',?,128)").run("a".repeat(64), Buffer.from("keep me"));
      const sql = readFileSync(new URL("../../../db/migrations/0053_conversation_compact_versions.sql", import.meta.url), "utf8");
      expect(() => atomicVersionWrite(legacy, () => legacy.exec(sql))).toThrow(/prototype/i);
      const row = legacy.prepare("SELECT hash,payload FROM conversation_v3_objects").get() as { hash: string; payload: Uint8Array };
      expect(row.hash).toBe("a".repeat(64));
      expect(Buffer.from(row.payload).toString()).toBe("keep me");
      expect(legacy.prepare("SELECT name FROM sqlite_master WHERE name='conversation_v3_compact_guard'").get()).toBeUndefined();
    } finally { legacy.close(); }
  });
});
