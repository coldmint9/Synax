import type Database from "libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionObjects } from "../checkpoints/version-store/objects.js";
import { RuntimeVersionRepository } from "../checkpoints/version-runtime/repository.js";
import { versionDatabase } from "./version-store-fixture.js";
let db: Database.Database,
  objects: VersionObjects,
  repo: RuntimeVersionRepository;
const fields = (id: string, type = "thought_delta") => ({
  id,
  sessionId: "s",
  type,
  summary: id,
  timestamp: "now",
  visibility: "internal",
  payload: { delta: id },
});
beforeEach(() => {
  db = versionDatabase();
  objects = new VersionObjects(db, {
    maxBytes: 64 * 1024 * 1024,
    maxObjects: 100000,
  });
  repo = new RuntimeVersionRepository(objects);
  repo.create("s", { id: "s", prompt: "start" });
});
afterEach(() => db.close());
describe("bounded runtime batch publication", () => {
  it("publishes all events with one revision, preserving ordered content and counts", () => {
    const before = repo.head("s");
    const events = Array.from({ length: 128 }, (_, n) => ({
      table: "events",
      id: `e-${n}`,
      fields: fields(`e-${n}`),
    }));
    const result = repo.putBatch("s", events);
    expect(result.revision).toBe(before.revision + 1);
    expect(result.epoch).toBe(before.epoch);
    expect(repo.page("s", "events", { limit: 256 }).items).toEqual(
      events.map((event) => event.fields),
    );
    expect(repo.count("s", "events")).toBe(128);
    const stats = objects.stats();
    expect(repo.putBatch("s", [])).toEqual(result);
    expect(objects.stats()).toEqual(stats);
  });
  it("coalesces duplicate IDs with the same last-write ordering as individual writes", () => {
    repo.put("s", "events", "a", fields("a"));
    repo.put("s", "events", "b", fields("b"));
    repo.putBatch("s", [
      { table: "events", id: "a", fields: fields("a", "message_delta") },
      { table: "events", id: "c", fields: fields("c") },
      { table: "events", id: "a", fields: fields("a", "progress_updated") },
    ]);
    expect(repo.page("s", "events").items.map((row) => row.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(repo.count("s", "events")).toBe(3);
    expect(repo.latestEvent("s", ["message_delta"])).toBeNull();
    expect(repo.latestEvent("s", ["thought_delta"])?.id).toBe("c");
    expect(repo.latestEvent("s", ["progress_updated"])?.id).toBe("a");
    expect(repo.countEventsAfter("s", "b", "thought_delta")).toBe(1);
  });
  it("keeps checkpoint snapshots intact across a mixed-table batch", () => {
    repo.put("s", "messages", "a", { id: "a", content: "before" });
    const cp = repo.capture("s", "reply", "a", null, 0);
    repo.putBatch("s", [
      { table: "messages", id: "a", fields: { id: "a", content: "after" } },
      { table: "events", id: "e", fields: fields("e") },
    ]);
    repo.rollback("s", {
      checkpointId: cp.id,
      revision: repo.head("s").revision,
      requestId: "undo",
    });
    expect(repo.get("s", "messages", "a")?.content).toBe("before");
    expect(repo.count("s", "events")).toBe(0);
  });
  it("rejects row/byte/depth/accessor/cycle excess before any partial publication", () => {
    const before = repo.head("s"),
      stats = objects.stats();
    expect(() =>
      repo.putBatch(
        "s",
        Array.from({ length: 257 }, (_, n) => ({
          table: "events",
          id: `e-${n}`,
          fields: fields(`e-${n}`),
        })),
      ),
    ).toThrow(/batch|limit/i);
    expect(() =>
      repo.putBatch("s", [
        {
          table: "messages",
          id: "large",
          fields: { content: "汉".repeat(400000) },
        },
      ]),
    ).toThrow(/budget|limit/i);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      repo.putBatch("s", [{ table: "events", id: "bad", fields: cyclic }]),
    ).toThrow(/cyclic|JSON/i);
    let accessed = false;
    const evil = {
      get id() {
        accessed = true;
        return "evil";
      },
    };
    expect(() =>
      repo.putBatch("s", [{ table: "events", id: "bad", fields: evil }]),
    ).toThrow(/accessor/i);
    expect(accessed).toBe(false);
    expect(repo.head("s")).toEqual(before);
    expect(objects.stats()).toEqual(stats);
  });
  it("rolls back successful earlier table writes when the final record is invalid", () => {
    const before = repo.head("s"),
      stats = objects.stats();
    expect(() =>
      repo.putBatch("s", [
        {
          table: "messages",
          id: "good",
          fields: { content: "must not survive" },
        },
        { table: "events", id: "bad", fields: { type: "" } },
      ]),
    ).toThrow(/type/i);
    expect(repo.head("s")).toEqual(before);
    expect(objects.stats()).toEqual(stats);
    expect(repo.count("s", "messages")).toBe(0);
  });
  it("allocates materially fewer immutable nodes than sequential publication", () => {
    const other = versionDatabase();
    try {
      const o = new VersionObjects(other, {
          maxBytes: 64 * 1024 * 1024,
          maxObjects: 100000,
        }),
        sequential = new RuntimeVersionRepository(o);
      sequential.create("s", { id: "s", prompt: "start" });
      const rows = Array.from({ length: 128 }, (_, n) => ({
        table: "events",
        id: `e-${n}`,
        fields: fields(`e-${n}`),
      }));
      const before = objects.stats().objects,
        slowBefore = o.stats().objects;
      repo.putBatch("s", rows);
      for (const row of rows)
        sequential.put("s", row.table, row.id, row.fields);
      expect(repo.page("s", "events", { limit: 256 }).items).toEqual(
        sequential.page("s", "events", { limit: 256 }).items,
      );
      expect(objects.stats().objects - before).toBeLessThan(
        (o.stats().objects - slowBefore) / 2,
      );
    } finally {
      other.close();
    }
  });
});
