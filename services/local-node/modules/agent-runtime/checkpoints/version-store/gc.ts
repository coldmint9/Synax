import { performance } from "node:perf_hooks";
import { VersionObjects, MAX_OBJECT_STORAGE_BYTES, objectStorageBytes } from "./objects.js";
import { HASH_BYTES, REFERENCE_BYTES, hashBytes } from "./hash-codec.js";
import { MAX_REFERENCES, PAGE_BYTES, PAGE_ROWS, VersionStoreError, objectByteLimit, type ObjectKind } from "./limits.js";
import { atomicVersionWrite } from "./transaction.js";

export interface CollectionBudget {
  maxObjects?: number; maxEdges?: number; maxBytes?: number; maxOwnershipRows?: number; maxMs?: number;
}
export interface CollectionResult {
  removed: number; bytes: number; edges: number; ownershipRows: number; remaining: boolean; elapsedMs: number;
  exhausted: "objects" | "bytes" | "edges" | "ownership" | "time" | null;
}
interface Candidate { id: string; bytes: number; edges: number; payloadBytes: number; refBytes: number; kind: ObjectKind }
function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new VersionStoreError("VERSION_GC_BUDGET", `Invalid GC ${name} budget.`);
  return value;
}

/** Immutable objects can only reference earlier objects. Therefore a durable
 * zero-reference partial index is sufficient; no whole-history mark set exists. */
export class VersionCollector {
  private readonly candidates;
  private readonly hasProof;
  private readonly proofs;
  private readonly removeProof;
  private readonly remaining;
  constructor(private readonly objects: VersionObjects) {
    const db = objects.db;
    this.candidates = db.prepare<[number]>(
      "SELECT CASE WHEN length(hash)=32 THEN lower(hex(hash)) ELSE NULL END AS id,kind,logical_bytes AS bytes,length(payload) AS payloadBytes,length(refs) AS refBytes,length(refs)/32 AS edges FROM conversation_v3_objects WHERE ref_count=0 ORDER BY hash LIMIT ?",
    );
    this.hasProof = db.prepare<{ hash: Uint8Array }>("SELECT 1 AS present FROM conversation_v3_owned_versions WHERE version_id=:hash LIMIT 1");
    this.proofs = db.prepare<[Uint8Array, number]>("SELECT session_id FROM conversation_v3_owned_versions WHERE version_id=? ORDER BY session_id LIMIT ?");
    this.removeProof = db.prepare<[string, Uint8Array]>("DELETE FROM conversation_v3_owned_versions WHERE session_id=? AND version_id=?");
    this.remaining = db.prepare("SELECT 1 AS present FROM conversation_v3_objects WHERE ref_count=0 LIMIT 1");
  }

  collect(budget: CollectionBudget = {}): CollectionResult {
    const maxObjects = integer(budget.maxObjects ?? 64, 1, PAGE_ROWS, "object");
    const maxEdges = integer(budget.maxEdges ?? 1024, MAX_REFERENCES, PAGE_ROWS * MAX_REFERENCES, "edge");
    const maxBytes = integer(budget.maxBytes ?? PAGE_BYTES, MAX_OBJECT_STORAGE_BYTES, PAGE_BYTES, "byte");
    const maxOwnershipRows = integer(budget.maxOwnershipRows ?? 256, 1, PAGE_ROWS, "ownership");
    const maxMs = budget.maxMs ?? 10;
    if (!Number.isFinite(maxMs) || maxMs <= 0 || maxMs > 1000)
      throw new VersionStoreError("VERSION_GC_BUDGET", "Invalid GC time budget.");
    const start = performance.now(), deadline = start + maxMs;
    return atomicVersionWrite(this.objects.db, () => {
      const result: CollectionResult = { removed: 0, bytes: 0, edges: 0, ownershipRows: 0, remaining: false, elapsedMs: 0, exhausted: null };
      // Metadata only, <=256 rows. Even a corrupted oversized blob is never read
      // before its size is checked; valid payloads are read one object at a time.
      const candidates = this.candidates.all(maxObjects) as Candidate[];
      for (const candidate of candidates) {
        if (performance.now() >= deadline) { result.exhausted = "time"; break; }
        const binary = hashBytes(candidate.id);
        if (!Number.isSafeInteger(candidate.bytes) || candidate.payloadBytes > objectByteLimit(candidate.kind) || candidate.refBytes > REFERENCE_BYTES || candidate.refBytes % HASH_BYTES ||
            candidate.bytes !== objectStorageBytes(candidate.payloadBytes, candidate.edges))
          throw new VersionStoreError("VERSION_OBJECT_CORRUPT", "Object size/accounting integrity check failed during GC.");
        if (result.bytes + candidate.bytes > maxBytes) { result.exhausted = "bytes"; break; }
        if (result.edges + candidate.edges > maxEdges) { result.exhausted = "edges"; break; }
        if (this.hasProof.get({ hash: binary })) {
          const available = maxOwnershipRows - result.ownershipRows;
          if (!available) { result.exhausted = "ownership"; break; }
          const rows = this.proofs.all(binary, available) as { session_id: string }[];
          for (const row of rows) {
            if (performance.now() >= deadline) { result.exhausted = "time"; break; }
            result.ownershipRows += Number(this.removeProof.run(row.session_id, binary).changes);
          }
          if (result.exhausted === "time") break;
          if (this.hasProof.get({ hash: binary })) { result.exhausted = "ownership"; break; }
        }
        if (performance.now() >= deadline) { result.exhausted = "time"; break; }
        const removed = this.objects.reclaim(candidate.id);
        if (removed) { result.removed++; result.bytes += removed.bytes; result.edges += removed.edges; }
      }
      result.remaining = Boolean(this.remaining.get());
      if (result.remaining && !result.exhausted && result.removed >= maxObjects) result.exhausted = "objects";
      if (!result.remaining) result.exhausted = null;
      result.elapsedMs = performance.now() - start;
      // Deadline is cooperative, not an interrupt of native SQLite or COMMIT.
      return result;
    });
  }
}
