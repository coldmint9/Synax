import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "libsql";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptIndex } from "../transcript-index.js";
let root: string;
let db: Database.Database;
let store: TranscriptIndex;
const object = (text: string) => TranscriptIndex.identify({kind: "chunk", payload: Buffer.from(text), references: []});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-index-"));
  db = new Database(path.join(root, "index.db"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
  store = new TranscriptIndex(db, root);
  store.initialize();
});
afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(root, {recursive:true, force:true}); });
it("deduplicates and reads committed objects after reopening the database", () => {
  const a = object("中文正文\nwith newline");
  expect(store.putBatch([a,a])).toEqual([a.hash,a.hash]);
  store.putBatch([a]);
  expect(fs.readdirSync(path.join(root,"transcripts"))).toHaveLength(1);
  db.close(); db = new Database(path.join(root,"index.db"));
  store = new TranscriptIndex(db,root);
  expect(store.get(a.hash)).toEqual(a);
});
it("does not publish indexes when file sync fails, and retries safely", () => {
  const a = object("not acknowledged");
  const sync = vi.spyOn(fs,"fsyncSync").mockImplementation(() => { throw new Error("injected sync failure"); });
  expect(() => store.putBatch([a])).toThrow("injected sync failure");
  sync.mockRestore();
  expect(store.get(a.hash)).toBeUndefined();
  expect(db.inTransaction).toBe(false);
  store.putBatch([a]); expect(store.get(a.hash)).toEqual(a);
});
it("keeps post-sync index failures invisible and never promotes orphan files", () => {
  const a = object("orphan");
  db.exec("CREATE TRIGGER reject_transcript BEFORE INSERT ON transcript_objects BEGIN SELECT RAISE(ABORT,'injected index failure'); END");
  expect(() => store.putBatch([a])).toThrow("injected index failure");
  expect(store.get(a.hash)).toBeUndefined();
  expect(fs.readdirSync(path.join(root,"transcripts"))).toHaveLength(1);
  db.exec("DROP TRIGGER reject_transcript");
  store.putBatch([a]); expect(store.get(a.hash)).toEqual(a);
  expect(fs.readdirSync(path.join(root,"transcripts"))).toHaveLength(2);
});
it("rejects NORMAL sync and nested transaction acknowledgements", () => {
  db.exec("PRAGMA synchronous=NORMAL");
  expect(() => store.putBatch([object("x")])).toThrow("TRANSCRIPT_DURABILITY_REQUIRED");
  db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
  expect(() => store.putBatch([object("x")])).toThrow("TRANSCRIPT_NESTED_TRANSACTION");
  db.exec("ROLLBACK");
});
it("rejects corrupt committed payloads, including deduplicated writes", () => {
  const a = object("checksum"); store.putBatch([a]);
  const file = path.join(root,"transcripts",fs.readdirSync(path.join(root,"transcripts"))[0]);
  fs.truncateSync(file,10);
  expect(() => store.get(a.hash)).toThrow();
  expect(() => store.putBatch([a])).toThrow();
});
it("rejects index pointers past the committed high-water mark", () => {
  const a=object("tail"); store.putBatch([a]);
  db.exec("UPDATE transcript_segments SET committed_bytes=0");
  expect(() => store.get(a.hash)).toThrow("TRANSCRIPT_INDEX_CORRUPT");
});
