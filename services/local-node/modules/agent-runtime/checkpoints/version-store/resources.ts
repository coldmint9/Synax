import { statSync } from "node:fs";
import type Database from "libsql";
import { VersionStoreError } from "./limits.js";
import { atomicVersionWrite } from "./transaction.js";

export interface VersionDiskUsage {
  databaseBytes: number; walBytes: number; shmBytes: number;
  sqliteAllocatedBytes: number; freePageBytes: number;
}
function size(filename: string): number {
  if (!filename) return 0;
  try { return statSync(filename).size; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export class VersionResources {
  private readonly usage;
  private readonly limit;
  private readonly mainFile;
  private readonly pageCount;
  private readonly pageSize;
  private readonly freePages;
  constructor(private readonly db: Database.Database) {
    this.usage = db.prepare("SELECT metadata_bytes AS bytes,metadata_limit AS limit_bytes FROM conversation_v3_storage WHERE id=1");
    this.limit = db.prepare<[number]>("UPDATE conversation_v3_storage SET metadata_limit=? WHERE id=1");
    this.mainFile = db.prepare("SELECT file FROM pragma_database_list WHERE name='main' LIMIT 1");
    this.pageCount = db.prepare("PRAGMA page_count");
    this.pageSize = db.prepare("PRAGMA page_size");
    this.freePages = db.prepare("PRAGMA freelist_count");
  }

  metadata(): { bytes: number; limit: number } {
    const row = this.usage.get() as { bytes: number; limit_bytes: number } | undefined;
    if (!row) throw new VersionStoreError("VERSION_STORAGE_CORRUPT", "Version metadata counters are missing.");
    return { bytes: row.bytes, limit: row.limit_bytes };
  }

  /** Lowering below existing use blocks growth, never deletes retained content. */
  setMetadataLimit(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new VersionStoreError("VERSION_BUDGET_INVALID", "Metadata budget must be a positive safe integer.");
    atomicVersionWrite(this.db, () => {
      if (!this.limit.run(bytes).changes) throw new VersionStoreError("VERSION_STORAGE_CORRUPT", "Version metadata counters are missing.");
    });
  }

  /** Observation, NOT a physical quota. Includes shared DB pages, excludes external
   * file blobs and temporary spill files; the runtime disk controller must add them. */
  disk(): VersionDiskUsage {
    const file = (this.mainFile.get() as { file: string }).file;
    const pageCount = (this.pageCount.get() as { page_count: number }).page_count;
    const pageSize = (this.pageSize.get() as { page_size: number }).page_size;
    const freePages = (this.freePages.get() as { freelist_count: number }).freelist_count;
    return {
      databaseBytes: size(file), walBytes: file ? size(`${file}-wal`) : 0, shmBytes: file ? size(`${file}-shm`) : 0,
      sqliteAllocatedBytes: pageCount * pageSize, freePageBytes: freePages * pageSize,
    };
  }
}
