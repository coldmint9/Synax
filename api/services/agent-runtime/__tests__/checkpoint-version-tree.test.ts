import type Database from "libsql";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VersionObjects } from "../checkpoints/version-store/objects.js";
import { VersionTree } from "../checkpoints/version-store/tree.js";
import { versionDatabase } from "./version-store-fixture.js";

let db: Database.Database, objects: VersionObjects, tree: VersionTree;
let a: string, b: string;
beforeEach(() => {
  db = versionDatabase();
  objects = new VersionObjects(db, { maxBytes: 128 * 1024 * 1024, maxObjects: 100_000 });
  tree = new VersionTree(objects);
  a = objects.put("chunk", Buffer.from("a"));
  b = objects.put("chunk", Buffer.from("b"));
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function all(root: string | null) {
  const entries: { key: string; value: string }[] = [];
  let after: string | undefined;
  do {
    const page = tree.page(root, { after, limit: 17 });
    entries.push(...page.entries);
    after = page.next;
  } while (after !== undefined);
  return entries;
}

describe("persistent bounded checkpoint tree", () => {
  it("reads empty roots and preserves previous roots after edit and delete", () => {
    expect(tree.size(null)).toBe(0);
    expect(tree.get(null, "a")).toBeUndefined();
    expect(tree.page(null)).toEqual({ entries: [] });
    const first = tree.update(null, [{ key: "z", value: b }, { key: "a", value: a }]);
    const second = tree.update(first, [{ key: "a", value: b }, { key: "z", value: null }]);
    expect(all(first)).toEqual([{ key: "a", value: a }, { key: "z", value: b }]);
    expect(all(second)).toEqual([{ key: "a", value: b }]);
    expect(tree.size(first)).toBe(2);
    expect(tree.size(second)).toBe(1);
    expect(tree.update(second, [{ key: "a", value: null }])).toBeNull();
  });

  it("coalesces repeated changes and does not allocate nodes for no-op updates", () => {
    const root = tree.update(null, [{ key: "a", value: a }, { key: "a", value: b }]);
    expect(tree.get(root, "a")).toBe(b);
    const before = objects.stats();
    expect(tree.update(root, [{ key: "a", value: b }, { key: "absent", value: null }])).toBe(root);
    expect(tree.update(root, [])).toBe(root);
    expect(objects.stats()).toEqual(before);
  });

  it("paginates an immutable root exactly across splits, independently of newer branches", () => {
    let root: string | null = null;
    for (let base = 0; base < 600; base += 100)
      root = tree.update(root, Array.from({ length: 100 }, (_, n) => ({ key: String(base + n).padStart(5, "0"), value: a })));
    const page = tree.page(root, { limit: 3 });
    expect(page.entries.map((e: { key: string }) => e.key)).toEqual(["00000", "00001", "00002"]);
    expect(page.next).toBe("00002");
    tree.update(root, [{ key: "00003", value: null }]);
    expect(tree.page(root, { after: page.next, limit: 2 }).entries.map((e: { key: string }) => e.key)).toEqual(["00003", "00004"]);
    expect(all(root).map(e => e.key)).toEqual(Array.from({ length: 600 }, (_, n) => String(n).padStart(5, "0")));
    expect(tree.page(root, { after: "99999" })).toEqual({ entries: [] });
  });

  it("caps encoded page bytes including the continuation cursor", () => {
    const root = tree.update(null, Array.from({ length: 30 }, (_, n) => ({ key: `${String(n).padStart(2, "0")}\n${"汉".repeat(100)}`, value: a })));
    const page = tree.page(root, { limit: 256, maxBytes: 1000 });
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.next).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1000);
    expect(() => tree.page(root, { maxBytes: 10 })).toThrow(/budget/i);
  });

  it("rejects oversized keys, batches and page limits without modifying the tree", () => {
    const before = objects.stats();
    expect(() => tree.update(null, [{ key: "汉".repeat(342), value: a }])).toThrow(/key/i);
    expect(() => tree.update(null, [{ key: "\ud800", value: a }])).toThrow(/key/i);
    expect(() => tree.update(null, Array.from({ length: 257 }, (_, n) => ({ key: `${n}`, value: a })))).toThrow(/batch/i);
    expect(() => tree.page(null, { limit: 257 })).toThrow(/limit/i);
    expect(() => tree.page(null, { maxBytes: 1024 * 1024 + 1 })).toThrow(/budget/i);
    expect(() => tree.update(null, [{ key: "missing", value: "f".repeat(64) }])).toThrow(/reference/i);
    expect(objects.stats()).toEqual(before);
  });

  it("enforces the response budget even for an empty tree", () => {
    expect(() => tree.page(null, { maxBytes: 1 })).toThrow(/budget/i);
  });

  it("removes whole subtrees without leaving duplicate keys or a tall empty spine", () => {
    let root: string | null = null;
    for (let base = 0; base < 900; base += 100)
      root = tree.update(root, Array.from({ length: 100 }, (_, n) => ({ key: String(base + n).padStart(4, "0"), value: a })));
    const original = root;
    for (let base = 0; base < 800; base += 100)
      root = tree.update(root, Array.from({ length: 100 }, (_, n) => ({ key: String(base + n).padStart(4, "0"), value: null })));
    root = tree.update(root, Array.from({ length: 99 }, (_, n) => ({ key: String(800 + n).padStart(4, "0"), value: null })));
    expect(all(root)).toEqual([{ key: "0899", value: a }]);
    expect(tree.size(original)).toBe(900);
    const read = vi.spyOn(objects, "get");
    expect(tree.get(root, "0899")).toBe(a);
    expect(read.mock.calls.length).toBe(1);
  });

  it("rolls back a partially built multi-page edit when quota admission fails", () => {
    const changes = Array.from({ length: 256 }, (_, n) => ({ key: String(n).padStart(4, "0"), value: a }));
    const small = new VersionObjects(db, { maxBytes: 128 * 1024 * 1024, maxObjects: objects.stats().objects + 1 });
    const before = objects.stats();
    expect(() => new VersionTree(small).update(null, changes)).toThrow(/budget/i);
    expect(objects.stats()).toEqual(before);
  });

  it("makes progress when valid keys expand near the JSON node-size target", () => {
    const changes = Array.from({ length: 16 }, (_, n) => ({ key: String(n).padStart(2, "0") + "\u0000".repeat(1022), value: a }));
    const root = tree.update(null, changes);
    expect(tree.size(root)).toBe(16);
    for (const entry of changes) expect(tree.get(root, entry.key)).toBe(a);
    const stored = objects.get(root!, "tree");
    expect(JSON.parse(stored.bytes.toString()).height).toBeLessThan(6);
  });

  it("fails closed on structurally invalid tree objects even when their hash is valid", () => {
    const bad = objects.put("tree", Buffer.from('{"v":1,"height":0,"count":2,"entries":[["z","' + a + '"],["a","' + a + '"]]}'), [a]);
    expect(() => tree.get(bad, "z")).toThrow(/tree/i);
    const dishonest = objects.put("tree", Buffer.from(JSON.stringify({ v: 1, height: 0, count: 10, entries: [["a", a]] })), [a]);
    expect(() => tree.size(dishonest)).toThrow(/tree/i);
  });

  it("shares untouched multi-level subtrees and bounds single-key reads and writes", () => {
    let root: string | null = null;
    const key = (i: number) => String(i).padStart(6, "0") + "x".repeat(180);
    for (let base = 0; base < 6000; base += 200)
      root = tree.update(root, Array.from({ length: 200 }, (_, n) => ({ key: key(base + n), value: a })));
    expect(tree.size(root)).toBe(6000);
    const read = vi.spyOn(objects, "get");
    expect(tree.get(root, key(3456))).toBe(a);
    expect(read.mock.calls.length).toBeLessThanOrEqual(8);
    read.mockClear();
    expect(tree.page(root, { after: key(3455), limit: 3 }).entries.map((e: { key: string }) => e.key)).toEqual([key(3456), key(3457), key(3458)]);
    expect(read.mock.calls.length).toBeLessThanOrEqual(10);
    const before = objects.stats().objects;
    const next = tree.update(root, [{ key: key(3456), value: b }]);
    expect(objects.stats().objects - before).toBeLessThanOrEqual(8);
    expect(tree.get(root, key(3456))).toBe(a);
    expect(tree.get(next, key(3456))).toBe(b);
    expect(tree.size(next)).toBe(6000);
    const rows = db.prepare("SELECT max(length(payload)) AS size FROM conversation_v3_objects WHERE kind='tree'").get() as { size: number };
    expect(rows.size).toBeLessThanOrEqual(16 * 1024);
  });

  it("agrees with an independent Map oracle through deterministic mixed edits and deletions", () => {
    const expected = new Map<string, string>();
    let root: string | null = null, seed = 42;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let round = 0; round < 80; round++) {
      const changes = Array.from({ length: 25 }, () => ({ key: String(random() % 800).padStart(4, "0"), value: random() % 3 === 0 ? null : random() % 2 ? a : b }));
      for (const change of changes) {
        if (change.value === null) expected.delete(change.key);
        else expected.set(change.key, change.value);
      }
      root = tree.update(root, changes);
      expect(tree.size(root)).toBe(expected.size);
      expect(all(root)).toEqual([...expected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => ({ key, value })));
    }
  });
});
