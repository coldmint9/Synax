import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionObjects } from "../checkpoints/version-store/objects.js";
import { atomicVersionWrite } from "../checkpoints/version-store/transaction.js";
import { versionDatabase } from "./version-store-fixture.js";

let db: Database.Database;
const budget = { maxBytes: 8 * 1024 * 1024, maxObjects: 10_000 };
beforeEach(() => { db = versionDatabase(); });
afterEach(() => { db.close(); });

describe("bounded immutable checkpoint objects", () => {
  it("deduplicates identical bytes but separates kinds and reference identities", () => {
    const store = new VersionObjects(db, budget);
    const a = store.put("chunk", Buffer.from("a"));
    const b = store.put("chunk", Buffer.from("b"));
    const parent = store.put("record", Buffer.from("row"), [a, b]);
    const before = store.stats();
    expect(store.put("record", Buffer.from("row"), [b, a, a])).toBe(parent);
    expect(store.stats()).toEqual(before);
    expect(store.put("chunk", Buffer.from("row"))).not.toBe(parent);
    expect(store.put("record", Buffer.from("row"), [a])).not.toBe(parent);
    expect(store.get(parent)).toEqual({ kind: "record", bytes: Buffer.from("row"), references: [a, b].sort() });
  });

  it("keeps persisted content immutable when callers mutate input or output buffers", () => {
    const store = new VersionObjects(db, budget);
    const input = Buffer.from("original");
    const id = store.put("chunk", input);
    input.fill(0);
    store.get(id).bytes.fill(0);
    expect(store.get(id, "chunk").bytes.toString()).toBe("original");
  });

  it("rejects missing references and leaves no partial object or quota charge", () => {
    const store = new VersionObjects(db, budget);
    const before = store.stats();
    expect(() => store.put("record", Buffer.from("row"), ["f".repeat(64)])).toThrow(/reference/i);
    expect(store.stats()).toEqual(before);
    expect(db.prepare("SELECT count(*) AS n FROM conversation_v3_objects").get()).toMatchObject({ n: 0 });
  });

  it("admits deduplicated writes at quota but atomically rejects new growth", () => {
    const store = new VersionObjects(db, { maxBytes: 1024, maxObjects: 1 });
    const id = store.put("chunk", Buffer.from("first"));
    const before = store.stats();
    expect(store.put("chunk", Buffer.from("first"))).toBe(id);
    expect(() => store.put("chunk", Buffer.from("second"))).toThrow(/budget/i);
    expect(store.stats()).toEqual(before);
    expect(db.prepare("SELECT count(*) AS n FROM conversation_v3_objects").get()).toMatchObject({ n: 1 });
  });

  it("checks byte quotas and payload/reference limits before allocating database rows", () => {
    const store = new VersionObjects(db, { maxBytes: 200, maxObjects: 100 });
    expect(() => store.put("chunk", Buffer.alloc(201))).toThrow(/budget/i);
    expect(() => store.put("chunk", Buffer.alloc(65_537))).toThrow(/size/i);
    expect(() => store.put("tree", Buffer.alloc(16_385))).toThrow(/size/i);
    expect(() => store.put("record", Buffer.from("r"), Array(257).fill("a".repeat(64)))).toThrow(/reference/i);
    expect(() => store.put("version", Buffer.alloc(4097))).toThrow(/size/i);
    expect(store.stats()).toEqual({ objects: 0, bytes: 0 });
  });

  it("requires finite explicit budgets and valid reference identities", () => {
    expect(() => new VersionObjects(db, { maxBytes: Infinity, maxObjects: 1 })).toThrow(/budget/i);
    expect(() => new VersionObjects(db, { maxBytes: 1, maxObjects: -1 })).toThrow(/budget/i);
    const store = new VersionObjects(db, budget);
    expect(() => store.put("record", Buffer.from("r"), ["../bad"])).toThrow(/reference/i);
    expect(() => store.get("../bad")).toThrow(/identity/i);
  });

  it("fails closed for missing, wrong-kind and corrupted objects", () => {
    const store = new VersionObjects(db, budget);
    expect(() => store.get("a".repeat(64))).toThrow(/missing/i);
    const id = store.put("chunk", Buffer.from("before"));
    expect(() => store.get(id, "tree")).toThrow(/kind/i);
    db.prepare("UPDATE conversation_v3_objects SET payload=? WHERE hash=?").run(Buffer.from("broken"), id);
    expect(() => store.get(id)).toThrow(/integrity/i);
  });

  it("rolls back object bytes, edges and counters with its enclosing transaction", () => {
    const store = new VersionObjects(db, budget);
    expect(() => atomicVersionWrite(db, () => {
      const child = store.put("chunk", Buffer.from("child"));
      store.put("record", Buffer.from("parent"), [child]);
      throw new Error("crash before publishing root");
    })).toThrow("crash before publishing root");
    expect(store.stats()).toEqual({ objects: 0, bytes: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM conversation_v3_edges").get()).toMatchObject({ n: 0 });
  });

  it("can reject a nested write without rolling back other valid outer writes", () => {
    const store = new VersionObjects(db, { maxBytes: 1024, maxObjects: 2 });
    atomicVersionWrite(db, () => {
      store.put("chunk", Buffer.from("first"));
      expect(() => store.put("record", Buffer.from("bad"), ["f".repeat(64)])).toThrow();
      store.put("chunk", Buffer.from("second"));
    });
    expect(store.stats().objects).toBe(2);
    expect(db.inTransaction).toBe(false);
  });

  it("rejects asynchronous transaction callbacks instead of committing early", () => {
    const store = new VersionObjects(db, budget);
    expect(() => atomicVersionWrite(db, () => {
      store.put("chunk", Buffer.from("must rollback"));
      return Promise.resolve();
    })).toThrow(/synchronous/i);
    expect(store.stats().objects).toBe(0);
    expect(db.inTransaction).toBe(false);
  });

  it("reopens durable objects without loading an in-memory index", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "synax-version-objects-"));
    const file = path.join(directory, "test.db");
    let disk = versionDatabase(file);
    try {
      const store = new VersionObjects(disk, budget);
      const id = store.put("chunk", Buffer.from("persisted"));
      const stats = store.stats();
      disk.close();
      disk = versionDatabase(file);
      const reopened = new VersionObjects(disk, budget);
      expect(reopened.get(id).bytes.toString()).toBe("persisted");
      expect(reopened.stats()).toEqual(stats);
    } finally {
      disk.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
