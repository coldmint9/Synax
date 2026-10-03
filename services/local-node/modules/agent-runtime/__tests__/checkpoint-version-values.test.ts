import type Database from "libsql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VersionObjects } from "../checkpoints/version-store/objects.js";
import { VersionText } from "../checkpoints/version-store/text.js";
import { RuntimeRecordCodec } from "../checkpoints/version-runtime/record-codec.js";
import { versionDatabase } from "./version-store-fixture.js";
let db: Database.Database,
  objects: VersionObjects,
  text: VersionText,
  records: RuntimeRecordCodec;
beforeEach(() => {
  db = versionDatabase();
  objects = new VersionObjects(db, {
    maxBytes: 64 * 1024 * 1024,
    maxObjects: 100000,
  });
  text = new VersionText(objects);
  records = new RuntimeRecordCodec(objects);
});
afterEach(() => db.close());

describe("bounded runtime values", () => {
  it("round-trips multi-chunk Unicode without cutting surrogate pairs", () => {
    const value = "a".repeat(65535) + '🙂漢字\n\\"'.repeat(20000);
    const id = text.write(value),
      info = text.info(id);
    expect(info.bytes).toBe(Buffer.byteLength(value));
    expect(info.jsonBytes).toBe(Buffer.byteLength(JSON.stringify(value)));
    expect(info.chunks).toBeGreaterThan(1);
    let cursor: number | undefined = 0,
      result = "";
    while (cursor !== undefined) {
      const page = text.page(id, cursor);
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(65536);
      result += page.text;
      cursor = page.next;
    }
    expect(result).toBe(value);
    expect(text.read(id, 1024 * 1024)).toBe(value);
    const stats = objects.stats();
    expect(text.write(value)).toBe(id);
    expect(objects.stats()).toEqual(stats);
  });
  it("rejects oversized materialization but still exposes bounded chunk reads", () => {
    const value = "large content ".repeat(200000),
      id = text.write(value);
    expect(() => text.read(id, 1024)).toThrow(/budget|page/i);
    expect(text.page(id, 0).text.length).toBeLessThanOrEqual(65536);
    expect(() => text.write("x".repeat(16 * 1024 * 1024 + 1))).toThrow(
      /limit|size/i,
    );
  });
  it("handles empty text and rejects invalid text manifests", () => {
    const id = text.write("");
    expect(text.read(id, 1)).toBe("");
    expect(text.page(id, 0)).toEqual({ text: "" });
    const bad = objects.put(
      "record",
      Buffer.from(
        '{"kind":"text","version":1,"bytes":1,"chars":1,"chunks":0,"root":null,"jsonBytes":3}',
      ),
    );
    expect(() => text.info(bad)).toThrow(/text|integrity/i);
    expect(() => text.page(id, 1)).toThrow(/cursor/i);
  });
  it("stores large fields externally and projects metadata without loading content", () => {
    const content = "x".repeat(2 * 1024 * 1024);
    const id = records.write("messages", "session", "message", 1, {
      id: "message",
      sessionId: "session",
      role: "assistant",
      content,
      metadata: { n: 1 },
      createdAt: "now",
    });
    expect(objects.get(id, "record").bytes.length).toBeLessThan(16384);
    expect(records.read(id, 1024, ["id", "metadata"])).toEqual({
      id: "message",
      metadata: { n: 1 },
    });
    expect(() => records.read(id, 1024)).toThrow(/budget|page/i);
    expect(records.read(id, 3 * 1024 * 1024).content).toBe(content);
    expect(records.header(id)).toMatchObject({
      table: "messages",
      scope: "session",
      id: "message",
      order: 1,
    });
  });
  it("retains ordinary JSON semantics and rejects cyclic/over-budget metadata before publication", () => {
    const id = records.write("messages", "s", "m", 0, {
      metadata: {
        empty: null,
        omit: undefined,
        array: [undefined, 1],
        date: new Date("2020-01-01T00:00:00Z"),
      },
      badUnicode: "\ud800",
    });
    expect(records.read(id, 4096)).toEqual({
      metadata: {
        empty: null,
        array: [null, 1],
        date: "2020-01-01T00:00:00.000Z",
      },
      badUnicode: "\ud800",
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const before = objects.stats();
    expect(() =>
      records.write("messages", "s", "bad", 0, { metadata: cycle }),
    ).toThrow(/cyclic|JSON/i);
    expect(() =>
      records.write("messages", "s", "bad", 0, {
        metadata: { large: "x".repeat(1024 * 1024 + 1) },
      }),
    ).toThrow(/budget|limit/i);
    expect(objects.stats()).toEqual(before);
  });
});
