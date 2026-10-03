import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionObjects } from "../checkpoints/version-store/objects.js";
import { VersionPins } from "../checkpoints/version-store/pins.js";
import { VersionHeads } from "../checkpoints/version-store/heads.js";
import { VersionTree } from "../checkpoints/version-store/tree.js";
import { createVersion } from "../checkpoints/version-store/versions.js";
import { VersionCollector } from "../checkpoints/version-store/gc.js";
import { atomicVersionWrite } from "../checkpoints/version-store/transaction.js";
import { versionDatabase } from "./version-store-fixture.js";

let db: Database.Database, objects: VersionObjects, pins: VersionPins, collector: VersionCollector;
const budget = { maxBytes: 64 * 1024 * 1024, maxObjects: 100000 };
beforeEach(() => { db = versionDatabase(); objects = new VersionObjects(db, budget); pins = new VersionPins(db); collector = new VersionCollector(objects); });
afterEach(() => db.close());
function drain(gc = collector) {
  let removed = 0;
  for (let round = 0; round < 2000; round++) {
    const result = gc.collect({ maxMs: 1000 }); removed += result.removed;
    if (!result.remaining) return removed;
  }
  throw new Error("Collector failed to make bounded progress");
}
function version(text: string) {
  return createVersion(objects, { transcriptRoot: new VersionTree(objects).update(null, [{ key: "a", value: objects.put("chunk", Buffer.from(text)) }]) });
}

describe("bounded immutable DAG collection", () => {
  it("retains shared descendants until every strong parent pin is released", () => {
    const shared = objects.put("chunk", Buffer.from("shared"));
    const left = objects.put("record", Buffer.from("left"), [shared]);
    const right = objects.put("record", Buffer.from("right"), [shared]);
    pins.hold({ id: "l", objectId: left, kind: "reader", owner: "l-owner" });
    pins.hold({ id: "r", objectId: right, kind: "checkpoint", owner: "r-owner" });
    expect(drain()).toBe(0);
    pins.release("l", "l-owner");
    expect(drain()).toBe(1);
    expect(objects.get(shared).bytes.toString()).toBe("shared");
    expect(objects.get(right).references).toEqual([shared]);
    pins.release("r", "r-owner");
    expect(drain()).toBe(2);
    expect(objects.stats()).toEqual({ objects: 0, bytes: 0 });
  });

  it("keeps checkpoints and current heads but reclaims abandoned historical versions", () => {
    const heads = new VersionHeads(db, objects), old = version("old"), current = version("current");
    heads.create("s", old);
    pins.hold({ id: "cp", objectId: old, kind: "checkpoint", owner: "cp-owner" });
    heads.publish({ sessionId: "s", versionId: current, expectedRevision: 0, expectedEpoch: 1 });
    drain();
    expect(objects.get(old).kind).toBe("version");
    pins.release("cp", "cp-owner");
    drain();
    expect(() => objects.get(old)).toThrow(/missing/i);
    expect(objects.get(current).kind).toBe("version");
    expect(heads.read("s").versionId).toBe(current);
    expect(db.prepare("SELECT count(*) AS n FROM conversation_v3_owned_versions").get()).toMatchObject({ n: 1 });
  });

  it("bounds object and byte work, allowing collection to continue in later calls", () => {
    for (let n = 0; n < 5; n++) objects.put("chunk", Buffer.alloc(65536, n));
    const result = collector.collect({ maxObjects: 5, maxBytes: 74000, maxMs: 1000 });
    expect(result.removed).toBe(1);
    expect(result.bytes).toBeLessThanOrEqual(74000);
    expect(result.remaining).toBe(true);
    const next = collector.collect({ maxObjects: 2, maxMs: 1000 });
    expect(next.removed).toBe(2);
    expect(drain()).toBe(2);
  });

  it("bounds released reference edges, not just the number of parent objects", () => {
    for (let group = 0; group < 2; group++) {
      const refs = Array.from({ length: 200 }, (_, n) => objects.put("chunk", Buffer.from(`${group}-${n}`)));
      objects.put("record", Buffer.from(`parent-${group}`), refs);
    }
    const result = collector.collect({ maxObjects: 5, maxEdges: 256, maxMs: 1000 });
    expect(result.removed).toBe(1);
    expect(result.edges).toBe(200);
    expect(result.remaining).toBe(true);
    drain(); expect(objects.stats().objects).toBe(0);
  });

  it("pages weak ownership fanout instead of triggering an unbounded cascade", () => {
    const heads = new VersionHeads(db, objects), old = version("shared"), current = version("current");
    for (let n = 0; n < 30; n++) {
      heads.create(`s-${n}`, old);
      heads.publish({ sessionId: `s-${n}`, versionId: current, expectedRevision: 0, expectedEpoch: 1 });
    }
    const result = collector.collect({ maxOwnershipRows: 5, maxMs: 1000 });
    expect(result.ownershipRows).toBe(5);
    expect(result.removed).toBe(0);
    expect(result.remaining).toBe(true);
    expect(objects.get(old).kind).toBe("version");
    drain(); expect(() => objects.get(old)).toThrow(/missing/i);
    expect(objects.get(current).kind).toBe("version");
  });

  it("rolls back the entire batch, including counters, on an injected deletion failure", () => {
    const ids = ["a", "b", "c"].map(text => objects.put("chunk", Buffer.from(text))).sort();
    db.exec(`CREATE TRIGGER fail_gc BEFORE DELETE ON conversation_v3_objects WHEN OLD.hash=X'${ids[1]}' BEGIN SELECT RAISE(ABORT,'injected GC failure'); END`);
    const before = objects.stats();
    expect(() => collector.collect({ maxMs: 1000 })).toThrow("injected GC failure");
    expect(objects.stats()).toEqual(before);
    for (const id of ids) expect(objects.get(id).kind).toBe("chunk");
    db.exec("DROP TRIGGER fail_gc");
    expect(drain()).toBe(3);
  });

  it("does not decrement arbitrary targets when an orphan's references are corrupted", () => {
    const a = objects.put("chunk", Buffer.from("a")), b = objects.put("chunk", Buffer.from("b"));
    const parent = objects.put("record", Buffer.from("p"), [a]);
    pins.hold({ id: "b", objectId: b, kind: "reader", owner: "b-owner" });
    db.exec("DROP TRIGGER conversation_v3_objects_immutable");
    db.prepare("UPDATE conversation_v3_objects SET refs=? WHERE hash=?").run(Buffer.from(b, "hex"), Buffer.from(parent, "hex"));
    const before = objects.stats();
    expect(() => collector.collect({ maxMs: 1000 })).toThrow(/integrity/i);
    expect(objects.stats()).toEqual(before);
    expect(objects.get(b).bytes.toString()).toBe("b");
  });

  it("resumes remaining durable work after closing and reopening the connection", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "synax-version-gc-"));
    const file = path.join(directory, "test.db");
    let disk = versionDatabase(file);
    try {
      let store = new VersionObjects(disk, budget);
      const refs = Array.from({ length: 100 }, (_, n) => store.put("chunk", Buffer.from(`${n}`)));
      store.put("record", Buffer.from("parent"), refs);
      expect(new VersionCollector(store).collect({ maxObjects: 1, maxMs: 1000 }).removed).toBe(1);
      disk.close(); disk = versionDatabase(file); store = new VersionObjects(disk, budget);
      expect(drain(new VersionCollector(store))).toBe(100);
      expect(store.stats()).toEqual({ objects: 0, bytes: 0 });
    } finally { disk.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("matches an independent reference-count oracle through mixed writes and maintenance", () => {
    const tree = new VersionTree(objects), heads = new VersionHeads(db, objects);
    let root: string | null = null, head = heads.create("s", createVersion(objects));
    const retained: string[] = [];
    for (let n = 0; n < 100; n++) {
      atomicVersionWrite(db, () => {
        root = tree.update(root, [{ key: `k${n % 20}`, value: objects.put("chunk", Buffer.from(`value-${n}`)) }]);
        const id = createVersion(objects, { transcriptRoot: root });
        head = heads.publish({ sessionId: "s", versionId: id, expectedRevision: head.revision, expectedEpoch: head.epoch });
        if (n % 10 === 0) {
          const pin = `cp-${n}`; retained.push(pin);
          pins.hold({ id: pin, objectId: id, kind: "checkpoint", owner: "cp-owner" });
          if (retained.length > 3) pins.release(retained.shift()!, "cp-owner");
        }
      });
      collector.collect({ maxObjects: 8, maxMs: 1000 });
    }
    drain();
    const rows = db.prepare("SELECT lower(hex(hash)) AS id,ref_count AS count FROM conversation_v3_objects").all() as { id: string; count: number }[];
    const expected = new Map(rows.map(row => [row.id, 0]));
    for (const row of rows) for (const ref of objects.get(row.id).references) expected.set(ref, expected.get(ref)! + 1);
    for (const row of db.prepare("SELECT lower(hex(version_id)) AS id FROM conversation_v3_heads UNION ALL SELECT lower(hex(object_id)) AS id FROM conversation_v3_pins").all() as { id: string }[]) expected.set(row.id, expected.get(row.id)! + 1);
    for (const row of rows) expect(row.count).toBe(expected.get(row.id));
    for (let n = 80; n < 100; n++) expect(objects.get(tree.get(root, `k${n % 20}`)!).bytes.toString()).toBe(`value-${n}`);
  });
});
