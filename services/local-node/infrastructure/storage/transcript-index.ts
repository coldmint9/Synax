import { randomUUID, createHash } from "node:crypto";
import type Database from "libsql";
import { appendTranscriptBatch, readTranscript, type TranscriptRecord } from "./transcript-jsonl.js";

/** Staging implementation: does not change the live runtime schema or backend.
 * Use a dedicated FULL-synchronous SQLite connection. One transaction reserves
 * the writer across file sync and index commit. No async callbacks or nested
 * transactions: callers must not acknowledge an outer, uncommitted transaction.
 * Logical history/heads are deliberately not derived from uncommitted log tails.
 */
export class TranscriptIndex {
  constructor(private readonly db: Database.Database, private readonly root: string) {}

  initialize(): void {
    this.assertDurableConnection();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_segments (
        id TEXT PRIMARY KEY, committed_bytes INTEGER NOT NULL CHECK(committed_bytes>=0)
      );
      CREATE TABLE IF NOT EXISTS transcript_objects (
        hash TEXT PRIMARY KEY, segment TEXT NOT NULL REFERENCES transcript_segments(id),
        offset INTEGER NOT NULL, length INTEGER NOT NULL, payload_bytes INTEGER NOT NULL,
        CHECK(offset>=0 AND length>0 AND payload_bytes>=0)
      );
    `);
  }

  private assertDurableConnection(): void {
    if (this.db.inTransaction) throw new Error("TRANSCRIPT_NESTED_TRANSACTION");
    const sync = this.db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    if (sync.synchronous < 2) throw new Error("TRANSCRIPT_DURABILITY_REQUIRED");
    const database = (this.db.prepare("PRAGMA database_list").all() as { name: string; file: string }[]).find(row => row.name === "main");
    if (!database?.file) throw new Error("TRANSCRIPT_PERSISTENT_INDEX_REQUIRED");
  }

  /** Content identity includes kind and references. Callers can use this stable
   * identity in immutable version records without duplicating body bytes. */
  static identify(record: Omit<TranscriptRecord, "hash">): TranscriptRecord {
    const hash = createHash("sha256").update(JSON.stringify([record.kind, record.references])).update("\0").update(record.payload).digest("hex");
    return { ...record, hash };
  }

  putBatch(records: readonly TranscriptRecord[]): string[] {
    this.assertDurableConnection();
    if (!records.length || records.length > 256) throw new Error("TRANSCRIPT_BATCH_SIZE");
    for (const record of records) {
      if (TranscriptIndex.identify(record).hash !== record.hash) throw new Error("TRANSCRIPT_IDENTITY");
    }
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const missing = new Map<string, TranscriptRecord>();
      for (const record of records) {
        if (db.prepare("SELECT 1 FROM transcript_objects WHERE hash=?").get(record.hash)) {
          this.get(record.hash); // Do not acknowledge a corrupted deduplicated object.
        } else missing.set(record.hash, record);
      }
      if (missing.size) {
        // Sealed bounded segments avoid rewriting committed tails or invalidating
        // readers during rollback. A failed transaction leaves an orphan file;
        // reclamation must run under exclusive maintenance, not during reads.
        const segment = randomUUID();
        const values = [...missing.values()];
        const locations = appendTranscriptBatch(this.root, segment, 0, values);
        const tail = locations.at(-1)!;
        db.prepare("INSERT INTO transcript_segments(id,committed_bytes) VALUES(?,?)").run(segment, tail.offset + tail.length);
        const insert = db.prepare("INSERT INTO transcript_objects(hash,segment,offset,length,payload_bytes) VALUES(?,?,?,?,?)");
        values.forEach((record, i) => {
          const location = locations[i];
          insert.run(record.hash, segment, location.offset, location.length, location.payloadBytes);
        });
      }
      db.exec("COMMIT");
      return records.map(record => record.hash);
    } catch (cause) {
      if (db.inTransaction) {
        try { db.exec("ROLLBACK"); } catch (rollback) {
          throw new AggregateError([cause, rollback], "TRANSCRIPT_ROLLBACK_FAILED", { cause: rollback });
        }
      }
      throw cause;
    }
  }

  get(hash: string): TranscriptRecord | undefined {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("TRANSCRIPT_IDENTITY");
    const row = this.db.prepare(`SELECT o.*,s.committed_bytes FROM transcript_objects o
      JOIN transcript_segments s ON s.id=o.segment WHERE o.hash=?`).get(hash) as
      { segment: string; offset: number; length: number; payload_bytes: number; committed_bytes: number } | undefined;
    if (!row) return undefined;
    if (row.offset + row.length > row.committed_bytes) throw new Error("TRANSCRIPT_INDEX_CORRUPT");
    const record = readTranscript(this.root, row.segment, row.offset, row.length);
    if (record.hash !== hash || record.payload.length !== row.payload_bytes || TranscriptIndex.identify(record).hash !== hash) throw new Error("TRANSCRIPT_INDEX_CORRUPT");
    return record;
  }
}
