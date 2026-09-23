import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionObjects } from "../checkpoints/version-store/objects.js";
import { VersionHeads } from "../checkpoints/version-store/heads.js";
import { VersionPins } from "../checkpoints/version-store/pins.js";
import { VersionResources } from "../checkpoints/version-store/resources.js";
import { VersionTree } from "../checkpoints/version-store/tree.js";
import { createVersion } from "../checkpoints/version-store/versions.js";
import { atomicVersionWrite } from "../checkpoints/version-store/transaction.js";
import { versionDatabase } from "./version-store-fixture.js";

let db: Database.Database, objects: VersionObjects, pins: VersionPins, resources: VersionResources, heads: VersionHeads;
let first: string, second: string;
const budget = { maxBytes: 16 * 1024 * 1024, maxObjects: 10000 };
const reqHash = createHash("sha256").update("test").digest("hex");
const refs = (id: string) => (db.prepare("SELECT ref_count AS n FROM conversation_v3_objects WHERE hash=?").get([Buffer.from(id, "hex")]) as { n: number }).n;
function version(store: VersionObjects, text: string) {
  return createVersion(store, { transcriptRoot: new VersionTree(store).update(null, [{ key: "a", value: store.put("chunk", Buffer.from(text)) }]) });
}
beforeEach(() => {
  db = versionDatabase(); objects = new VersionObjects(db, budget); pins = new VersionPins(db); resources = new VersionResources(db); heads = new VersionHeads(db, objects);
  first = version(objects, "first"); second = version(objects, "second");
});
afterEach(() => db.close());

describe("durable version pins and metadata admission", () => {
  it("keeps checkpoint and fork roots referenced when the current head moves", () => {
    heads.create("s", first);
    const pin = { id: "checkpoint:1", objectId: first, kind: "checkpoint" as const, owner: "cp-owner" };
    pins.hold(pin);
    heads.publish({ sessionId: "s", versionId: second, expectedRevision: 0, expectedEpoch: 1 });
    expect(refs(first)).toBe(1);
    heads.fork({ sourceSessionId: "s", targetSessionId: "fork", versionId: first, expectedRevision: 1, requestId: "fork", requestHash: reqHash });
    expect(refs(first)).toBe(2);
    expect(pins.release(pin.id, pin.owner)).toBe(true);
    expect(refs(first)).toBe(1);
    expect(refs(second)).toBe(1);
  });

  it("holds and releases idempotently without charging metadata or references twice", () => {
    const pin = { id: "reader:1", objectId: first, kind: "reader" as const, owner: "reader-nonce" };
    pins.hold(pin);
    const usage = resources.metadata();
    pins.hold(pin);
    expect(resources.metadata()).toEqual(usage);
    expect(refs(first)).toBe(1);
    expect(() => pins.hold({ ...pin, objectId: second })).toThrow(/identity/i);
    expect(() => pins.release(pin.id, "other-owner")).toThrow(/owner/i);
    expect(refs(first)).toBe(1);
    expect(pins.release(pin.id, pin.owner)).toBe(true);
    expect(pins.release(pin.id, pin.owner)).toBe(false);
    expect(refs(first)).toBe(0);
    expect(resources.metadata().bytes).toBe(0);
  });

  it("moves only a writer pin with matching owner and expected root, atomically", () => {
    pins.hold({ id: "writer", objectId: first, kind: "writer", owner: "write-nonce" });
    expect(() => pins.moveWriter({ id: "writer", owner: "write-nonce", expectedObjectId: second, objectId: second })).toThrow(/changed/i);
    pins.moveWriter({ id: "writer", owner: "write-nonce", expectedObjectId: first, objectId: second });
    expect(refs(first)).toBe(0); expect(refs(second)).toBe(1);
    expect(() => atomicVersionWrite(db, () => { pins.moveWriter({ id: "writer", owner: "write-nonce", expectedObjectId: second, objectId: first }); throw new Error("abort"); })).toThrow("abort");
    expect(refs(first)).toBe(0); expect(refs(second)).toBe(1);
    pins.hold({ id: "cp", objectId: first, kind: "checkpoint", owner: "cp-owner" });
    expect(() => pins.moveWriter({ id: "cp", owner: "cp-owner", expectedObjectId: first, objectId: second })).toThrow(/writer/i);
  });

  it("paginates ownership without materializing all pins", () => {
    for (let n = 0; n < 15; n++) pins.hold({ id: String(n).padStart(2, "0"), objectId: first, kind: "reader", owner: "read-owner" });
    const page = pins.page("read-owner", { limit: 4 });
    expect(page.items.map(item => item.id)).toEqual(["00", "01", "02", "03"]);
    expect(pins.page("read-owner", { after: page.next, limit: 4 }).items.map(item => item.id)).toEqual(["04", "05", "06", "07"]);
    expect(() => pins.page("read-owner", { limit: 257 })).toThrow(/limit/i);
  });

  it("rolls back a pin or head publication when the metadata budget is exhausted", () => {
    resources.setMetadataLimit(1);
    expect(() => pins.hold({ id: "p", objectId: first, kind: "checkpoint", owner: "o" })).toThrow(/budget/i);
    expect(() => heads.create("s", first)).toThrow(/budget/i);
    expect(resources.metadata().bytes).toBe(0);
    expect(refs(first)).toBe(0);
    expect(() => heads.read("s")).toThrow(/exist/i);
  });

  it("rolls back head/epoch changes if there is no space for their idempotency result", () => {
    heads.create("s", first);
    heads.publish({ sessionId: "s", versionId: second, expectedRevision: 0, expectedEpoch: 1 });
    resources.setMetadataLimit(resources.metadata().bytes);
    expect(() => heads.switch({ sessionId: "s", targetVersionId: first, expectedRevision: 1, requestId: "undo", requestHash: reqHash })).toThrow(/budget/i);
    expect(heads.read("s")).toMatchObject({ versionId: second, revision: 1, epoch: 1 });
    expect(refs(first)).toBe(0); expect(refs(second)).toBe(1);
    // INSERT OR IGNORE on an already-owned root must not consume more quota.
    heads.publish({ sessionId: "s", versionId: second, expectedRevision: 1, expectedEpoch: 1 });
    expect(heads.read("s").revision).toBe(2);
  });

  it("rejects absent roots even when a caller forgot to enable foreign keys", () => {
    db.exec("PRAGMA foreign_keys=OFF");
    expect(() => pins.hold({ id: "bad", objectId: "f".repeat(64), kind: "reader", owner: "nonce" })).toThrow(/missing/i);
    expect(resources.metadata().bytes).toBe(0);
    pins.hold({ id: "writer", objectId: first, kind: "writer", owner: "nonce" });
    expect(() => pins.moveWriter({ id: "writer", owner: "nonce", expectedObjectId: first, objectId: "f".repeat(64) })).toThrow(/missing/i);
    expect(refs(first)).toBe(1);
  });

  it("does not allow charged pin identities to change behind the budget ledger", () => {
    pins.hold({ id: "reader", objectId: first, kind: "reader", owner: "nonce" });
    const before = resources.metadata();
    expect(() => db.prepare("UPDATE conversation_v3_pins SET owner=? WHERE id='reader'").run("a-much-longer-owner")).toThrow(/immutable/i);
    expect(resources.metadata()).toEqual(before);
  });

  it("preserves independent reader pins across connections and process-style reopen", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "synax-version-pins-"));
    const filename = path.join(directory, "test.db");
    let a = versionDatabase(filename), b: Database.Database | undefined;
    try {
      const store = new VersionObjects(a, budget), root = version(store, "persistent");
      new VersionPins(a).hold({ id: "read-a", objectId: root, kind: "reader", owner: "nonce-a" });
      b = versionDatabase(filename);
      new VersionPins(b).hold({ id: "read-b", objectId: root, kind: "reader", owner: "nonce-b" });
      new VersionPins(a).release("read-a", "nonce-a");
      a.close(); a = versionDatabase(filename);
      const reopened = new VersionPins(a);
      expect(reopened.page("nonce-b").items[0].objectId).toBe(root);
      expect(new VersionObjects(a, budget).get(root).kind).toBe("version");
      expect(reopened.release("read-b", "nonce-b")).toBe(true);
      const disk = new VersionResources(a).disk();
      expect(disk.databaseBytes).toBeGreaterThan(0);
      expect(disk.sqliteAllocatedBytes).toBeGreaterThanOrEqual(disk.freePageBytes);
    } finally { b?.close(); a.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
