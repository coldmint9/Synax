import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionObjects } from "../checkpoints/version-store/objects.js";
import { VersionTree } from "../checkpoints/version-store/tree.js";
import { VersionHeads } from "../checkpoints/version-store/heads.js";
import { createVersion, readVersion } from "../checkpoints/version-store/versions.js";
import { atomicVersionWrite } from "../checkpoints/version-store/transaction.js";
import { versionDatabase } from "./version-store-fixture.js";

let db: Database.Database, objects: VersionObjects, heads: VersionHeads;
let first: string, second: string;
const budget = { maxBytes: 128 * 1024 * 1024, maxObjects: 100_000 };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function version(store: VersionObjects, text: string): string {
  const content = store.put("chunk", Buffer.from(text));
  const root = new VersionTree(store).update(null, [{ key: "message", value: content }]);
  return createVersion(store, { transcriptRoot: root });
}
beforeEach(() => {
  db = versionDatabase(); objects = new VersionObjects(db, budget); heads = new VersionHeads(db, objects);
  first = version(objects, "first"); second = version(objects, "second");
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function ready() {
  heads.create("source", first);
  heads.publish({ sessionId: "source", versionId: second, expectedRevision: 0, expectedEpoch: 1 });
  return { sessionId: "source", targetVersionId: first, expectedRevision: 1, requestId: "undo", requestHash: hash("undo") };
}

describe("version manifests and atomic heads", () => {
  it("creates deterministic typed manifests and rejects invalid tree roots", () => {
    expect(createVersion(objects)).toBe(createVersion(objects, { transcriptRoot: null }));
    expect(readVersion(objects, first).transcriptRoot).not.toBeNull();
    const chunk = objects.put("chunk", Buffer.from("not a tree"));
    expect(() => createVersion(objects, { transcriptRoot: chunk })).toThrow(/kind/i);
    const bad = objects.put("version", Buffer.from('{"format":3,"roots":{}}'));
    expect(() => readVersion(objects, bad)).toThrow(/version/i);
  });

  it("switches an owned root without rewriting objects and increments the execution epoch", () => {
    const request = ready();
    const before = objects.stats();
    const read = vi.spyOn(objects, "get");
    expect(heads.switch(request)).toEqual({ sessionId: "source", versionId: first, revision: 2, epoch: 2 });
    expect(read.mock.calls.length).toBe(1);
    expect(objects.stats()).toEqual(before);
    expect(heads.read("source").versionId).toBe(first);
  });

  it("returns an identical committed result on retries even after the head advances", () => {
    const request = ready();
    const result = heads.switch(request);
    heads.publish({ sessionId: "source", versionId: second, expectedRevision: 2, expectedEpoch: 2 });
    expect(heads.switch(request)).toEqual(result);
    expect(heads.read("source").versionId).toBe(second);
    expect(heads.read("source").revision).toBe(3);
  });

  it("rejects conflicting reuse of a request id including dishonest request hashes", () => {
    const request = ready();
    heads.switch(request);
    expect(() => heads.switch({ ...request, requestHash: hash("other") })).toThrow(/request/i);
    expect(() => heads.switch({ ...request, targetVersionId: second })).toThrow(/request/i);
  });

  it("rejects stale revisions and late writers with the old epoch", () => {
    const request = ready();
    expect(() => heads.switch({ ...request, expectedRevision: 0 })).toThrow(/revision/i);
    heads.switch(request);
    expect(() => heads.publish({ sessionId: "source", versionId: second, expectedRevision: 2, expectedEpoch: 1 })).toThrow(/epoch/i);
    expect(heads.read("source")).toEqual({ sessionId: "source", versionId: first, revision: 2, epoch: 2 });
  });

  it("does not allow a supplied hash to restore another session's unowned version", () => {
    heads.create("source", first); heads.create("other", second);
    expect(() => heads.switch({ sessionId: "source", targetVersionId: second, expectedRevision: 0, requestId: "foreign", requestHash: hash("foreign") })).toThrow(/owned/i);
    expect(heads.read("source").versionId).toBe(first);
  });

  it("forks an owned version by reference with separate revisions and epochs", () => {
    ready();
    const request = { sourceSessionId: "source", targetSessionId: "fork", versionId: first, expectedRevision: 1, requestId: "fork-op", requestHash: hash("fork-op") };
    const before = objects.stats();
    const fork = heads.fork(request);
    expect(fork).toEqual({ sessionId: "fork", versionId: first, revision: 0, epoch: 1 });
    expect(heads.fork(request)).toEqual(fork);
    expect(objects.stats()).toEqual(before);
    heads.publish({ sessionId: "fork", versionId: second, expectedRevision: 0, expectedEpoch: 1 });
    expect(heads.read("source")).toEqual({ sessionId: "source", versionId: second, revision: 1, epoch: 1 });
    expect(heads.read("fork").revision).toBe(1);
  });

  it("never overwrites an existing fork destination", () => {
    ready(); heads.create("occupied", second);
    expect(() => heads.fork({ sourceSessionId: "source", targetSessionId: "occupied", versionId: first, expectedRevision: 1, requestId: "fork-op", requestHash: hash("fork-op") })).toThrow(/exists/i);
    expect(heads.read("occupied").versionId).toBe(second);
    expect(db.prepare("SELECT count(*) AS n FROM conversation_v3_operations").get()).toMatchObject({ n: 0 });
  });

  it("rolls back head, epoch and idempotency result together on failure", () => {
    const request = ready();
    expect(() => atomicVersionWrite(db, () => { heads.switch(request); throw new Error("injected crash"); })).toThrow("injected crash");
    expect(heads.read("source")).toEqual({ sessionId: "source", versionId: second, revision: 1, epoch: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM conversation_v3_operations").get()).toMatchObject({ n: 0 });
    expect(heads.switch(request).epoch).toBe(2);
  });

  it("keeps immutable object bytes constant through repeated root switches", () => {
    ready();
    const before = objects.stats();
    for (let n = 0; n < 200; n++) {
      const head = heads.read("source");
      heads.switch({ sessionId: "source", targetVersionId: n % 2 ? second : first, expectedRevision: head.revision, requestId: `undo-${n}`, requestHash: hash(`undo-${n}`) });
    }
    expect(objects.stats()).toEqual(before);
    expect(heads.read("source").epoch).toBe(201);
  });

  it("rejects overlong identities and mismatched database connections", () => {
    expect(() => heads.create("s".repeat(257), first)).toThrow(/identity/i);
    const other = versionDatabase();
    try { expect(() => new VersionHeads(other, objects)).toThrow(/connection/i); }
    finally { other.close(); }
  });

  it("reopens committed head and request result from disk", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "synax-version-heads-"));
    const file = path.join(directory, "test.db");
    let disk = versionDatabase(file);
    try {
      const store = new VersionObjects(disk, budget), original = version(store, "one"), next = version(store, "two");
      let diskHeads = new VersionHeads(disk, store);
      diskHeads.create("s", original);
      diskHeads.publish({ sessionId: "s", versionId: next, expectedRevision: 0, expectedEpoch: 1 });
      const request = { sessionId: "s", targetVersionId: original, expectedRevision: 1, requestId: "undo", requestHash: hash("undo") };
      const result = diskHeads.switch(request);
      disk.close(); disk = versionDatabase(file);
      diskHeads = new VersionHeads(disk, new VersionObjects(disk, budget));
      expect(diskHeads.read("s")).toEqual(result);
      expect(diskHeads.switch(request)).toEqual(result);
    } finally { disk.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
