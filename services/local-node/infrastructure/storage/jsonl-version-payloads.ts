import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'libsql';
import { appendTranscriptBatch, readTranscript } from './transcript-jsonl.js';
import { ImmutablePayloads } from './immutable-payloads.js';
import type { VersionPayloadStore } from './version-payload-store.js';

type TransactionDatabase = Database.Database & { transaction<T>(action: () => T): () => T };
const fences = new WeakMap<Database.Database, { files: Set<string>; directories: Set<string> }>();
function sync(file: string, directory = false): void {
  if (directory && process.platform === 'win32') return;
  const fd = fs.openSync(file, (directory ? fs.constants.O_RDONLY : fs.constants.O_RDWR) | (fs.constants.O_NOFOLLOW ?? 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
/** Every payload is flushed before its SQL reference can commit. One fsync per
 * touched segment per outer transaction, not one fsync per tiny DAG node. */
function durabilityFence(db: TransactionDatabase) {
  let fence = fences.get(db);
  if (fence) return fence;
  fence = { files: new Set(), directories: new Set() };
  fences.set(db, fence);
  const pending = fence;
  const original = db.exec.bind(db);
  Object.defineProperty(db, 'exec', { configurable: true, value(sql: string) {
    if (db.inTransaction && /\b(?:COMMIT|END)\b/i.test(sql) && pending.files.size) {
      for (const file of pending.files) sync(file);
      for (const directory of pending.directories) sync(directory, true);
    }
    const result = original(sql);
    if (!db.inTransaction) { pending.files.clear(); pending.directories.clear(); }
    return result;
  } });
  return fence;
}

export class JsonlVersionPayloads implements VersionPayloadStore {
  readonly jsonl = true;
  private owner = '__shared__';
  private readonly fallback: ImmutablePayloads;
  private readonly fence;
  private readonly cache = new Map<string, Buffer>();
  private cacheBytes = 0;
  constructor(private readonly db: TransactionDatabase, readonly root: string, fallbackRoot: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.fallback = new ImmutablePayloads(fallbackRoot);
    this.fence = durabilityFence(db);
  }
  withOwner<T>(owner: string, action: () => T): T {
    const previous = this.owner; this.owner = owner;
    try { return action(); } finally { this.owner = previous; }
  }
  put(bytes: Uint8Array): string {
    if (bytes.byteLength > 65536) throw new Error('Version payload exceeds its chunk budget.');
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (!this.db.inTransaction) return this.db.transaction(() => this.put(bytes))();
    if (this.db.prepare('SELECT 1 FROM jsonl_payload_records WHERE hash=?').get(hash)) { this.get(hash); return hash; }
    let head = this.db.prepare('SELECT s.* FROM jsonl_payload_heads h JOIN jsonl_payload_segments s ON s.id=h.segment WHERE h.owner=?').get(this.owner) as { id: string; committed_bytes: number; sealed: number } | undefined;
    if (!head || head.sealed || head.committed_bytes >= 8 * 1024 * 1024) {
      if (head) this.db.prepare('UPDATE jsonl_payload_segments SET sealed=1 WHERE id=?').run(head.id);
      head = { id: randomUUID(), committed_bytes: 0, sealed: 0 };
      this.db.prepare('INSERT INTO jsonl_payload_segments(id,owner) VALUES(?,?)').run(head.id, this.owner);
      this.db.prepare('INSERT INTO jsonl_payload_heads(owner,segment) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET segment=excluded.segment').run(this.owner, head.id);
    }
    const [location] = appendTranscriptBatch(this.root, head.id, head.committed_bytes,
      [{ hash, kind: 'version_payload', payload: Buffer.from(bytes), references: [] }], (file, directory) => {
        this.fence.files.add(file); this.fence.directories.add(directory); this.fence.directories.add(this.root); this.fence.directories.add(path.dirname(this.root));
      });
    this.db.prepare('INSERT INTO jsonl_payload_records(hash,segment,offset,length,payload_bytes) VALUES(?,?,?,?,?)').run(hash, head.id, location.offset, location.length, bytes.byteLength);
    this.db.prepare('UPDATE jsonl_payload_segments SET committed_bytes=? WHERE id=?').run(location.offset + location.length, head.id);
    // Do not cache an uncommitted location: rollback may remove it.
    return hash;
  }
  get(hash: string, maxBytes = 65536): Buffer {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid payload identity.');
    const row = this.db.prepare('SELECT p.*,s.committed_bytes FROM jsonl_payload_records p JOIN jsonl_payload_segments s ON s.id=p.segment WHERE p.hash=?').get(hash) as { segment: string; offset: number; length: number; payload_bytes: number; committed_bytes: number } | undefined;
    if (!row) return this.fallback.get(hash, maxBytes);
    if (row.payload_bytes > maxBytes || row.offset + row.length > row.committed_bytes) throw new Error('JSONL payload index exceeds its committed boundary.');
    const cached = this.cache.get(hash);
    if (cached) { this.cache.delete(hash); this.cache.set(hash, cached); return Buffer.from(cached); }
    const record = readTranscript(this.root, row.segment, row.offset, row.length);
    if (record.kind !== 'version_payload' || record.hash !== hash || record.payload.length !== row.payload_bytes || createHash('sha256').update(record.payload).digest('hex') !== hash)
      throw new Error('JSONL version payload integrity check failed.');
    {
      while (this.cacheBytes + record.payload.length > 16 * 1024 * 1024 && this.cache.size) {
        const first = this.cache.keys().next().value!; this.cacheBytes -= this.cache.get(first)!.length; this.cache.delete(first);
      }
      this.cache.set(hash, Buffer.from(record.payload)); this.cacheBytes += record.payload.length;
    }
    return record.payload;
  }
  remove(hash: string): void {
    if (!this.db.inTransaction) { this.db.transaction(() => this.remove(hash))(); return; }
    const cached = this.cache.get(hash); if (cached) { this.cacheBytes -= cached.length; this.cache.delete(hash); }
    this.db.prepare('DELETE FROM jsonl_payload_records WHERE hash=?').run(hash);
    // Sealed pack files are reclaimed separately, after index deletion commits.
    // Keep the binary source until explicit offline backup/cleanup.
  }
  collectSealed(limit = 4): number {
    if (this.db.inTransaction) return 0;
    return this.db.transaction(() => {
      const rows = this.db.prepare('SELECT id FROM jsonl_payload_segments s WHERE sealed=1 AND NOT EXISTS(SELECT 1 FROM jsonl_payload_records p WHERE p.segment=s.id) LIMIT ?').all(limit) as { id: string }[];
      for (const row of rows) {
        try { fs.unlinkSync(path.join(this.root, 'transcripts', `${row.id}.jsonl`)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        this.db.prepare('DELETE FROM jsonl_payload_segments WHERE id=?').run(row.id);
      }
      return rows.length;
    })();
  }
}
