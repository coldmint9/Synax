import fs from "node:fs/promises";
import path from "node:path";
import Database from "libsql";
import { setImmediate as yieldNow } from "node:timers/promises";
import { atomicVersionWrite } from "./version-store/transaction.js";
import { historyError } from "./guards.js";

/** Scratch-only reference set. A cycle never reuses an old mark as complete. Its
 * main file is capped at 64MiB and its page cache at 2MiB (not a total RSS cap). */
export class BlobMarks {
  private readonly insert;
  private readonly find;
  private batch: string[] = [];
  private sealed = false;
  private constructor(
    private readonly db: Database.Database,
    private readonly file: string,
  ) {
    db.exec(
      "PRAGMA page_size=4096; PRAGMA max_page_count=16384; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; CREATE TABLE live(hash BLOB PRIMARY KEY CHECK(length(hash)=32)) WITHOUT ROWID;",
    );
    this.insert = db.prepare<{ hash: Uint8Array }>(
      "INSERT OR IGNORE INTO live(hash) VALUES(:hash)",
    );
    this.find = db.prepare<{ hash: Uint8Array }>(
      "SELECT 1 AS present FROM live WHERE hash=:hash",
    );
  }
  static async create(directory: string): Promise<BlobMarks> {
    const scratch = path.join(directory, "gc-scratch");
    await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(scratch);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw historyError(
        "Unsafe file GC scratch directory.",
        "SNAPSHOT_GC_LIMIT",
      );
    const file = path.join(scratch, "live.sqlite");
    await BlobMarks.removeScratch(file);
    const db = new Database(file);
    try {
      return new BlobMarks(db, file);
    } catch (error) {
      db.close();
      await BlobMarks.removeScratch(file);
      throw error;
    }
  }
  private static async removeScratch(file: string): Promise<void> {
    for (const suffix of ["", "-journal", "-wal", "-shm"])
      await fs.rm(file + suffix, { force: true });
  }
  private flush(): void {
    if (!this.batch.length) return;
    try {
      atomicVersionWrite(this.db, () => {
        for (const hash of this.batch)
          this.insert.run({ hash: Buffer.from(hash, "hex") });
      });
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_FULL")
        throw historyError(
          "File GC scratch budget exceeded; collection was cancelled before sweeping.",
          "SNAPSHOT_GC_LIMIT",
        );
      throw error;
    }
    this.batch = [];
  }
  async mark(text: string): Promise<void> {
    if (this.sealed) throw new Error("File GC mark is already sealed.");
    for (const match of text.matchAll(/[a-f0-9]{64}/g)) {
      this.batch.push(match[0]);
      if (this.batch.length === 256) {
        this.flush();
        await yieldNow();
      }
    }
  }
  seal(): void {
    this.flush();
    this.sealed = true;
  }
  has(hash: string): boolean {
    if (!this.sealed) throw new Error("File GC mark is not complete/sealed.");
    return Boolean(this.find.get({ hash: Buffer.from(hash, "hex") }));
  }
  async close(): Promise<void> {
    try {
      this.db.close();
    } finally {
      await BlobMarks.removeScratch(this.file);
    }
  }
}
