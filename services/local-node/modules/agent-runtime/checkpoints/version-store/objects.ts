import { createHash } from "node:crypto";
import type Database from "libsql";
import {
  CHUNK_BYTES, MAX_REFERENCES, VersionStoreError,
  assertObjectId, objectByteLimit, type ObjectKind,
} from "./limits.js";
import { HASH_BYTES, REFERENCE_BYTES, hashBytes, packReferences, unpackReferences } from "./hash-codec.js";
import { atomicVersionWrite } from "./transaction.js";

export interface ObjectBudget { maxBytes: number; maxObjects: number }
export interface StoredObject { kind: ObjectKind; bytes: Buffer; references: string[] }
export interface ObjectStats { objects: number; bytes: number }

// Admission accounts for object metadata and packed references as well as payload. Physical DB, indexes,
// WAL and temporary-file accounting belongs to the outer disk-budget controller.
const OBJECT_OVERHEAD = 128;
const EDGE_OVERHEAD = HASH_BYTES;
export const MAX_OBJECT_STORAGE_BYTES = OBJECT_OVERHEAD + CHUNK_BYTES + REFERENCE_BYTES;
export function objectStorageBytes(payloadBytes: number, referenceCount: number): number {
  return OBJECT_OVERHEAD + payloadBytes + referenceCount * EDGE_OVERHEAD;
}

function identity(kind: ObjectKind, bytes: Uint8Array, references: readonly string[]): string {
  return createHash("sha256")
    .update(`synax.checkpoint.v3\0${kind}\0${bytes.byteLength}\0`)
    .update(bytes).update("\0").update(references.join(",")).digest("hex");
}

export class VersionObjects {
  private readonly budget: ObjectBudget;
  private readonly exists;
  private readonly insert;
  private readonly retain;
  private readonly read;
  private readonly readStats;
  private readonly reserve;
  private readonly orphan;
  private readonly remove;
  private readonly release;

  constructor(readonly db: Database.Database, budget: ObjectBudget, private readonly beforeGrow?: (bytes: number) => void) {
    for (const value of [budget.maxBytes, budget.maxObjects]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new VersionStoreError("VERSION_BUDGET_INVALID", "Object budget must be a positive safe integer.");
    }
    this.budget = { ...budget };
    try {
      const row = db.prepare("SELECT format FROM conversation_v3_storage WHERE id=1").get() as { format: number } | undefined;
      if (row?.format !== 2) throw new Error();
    } catch {
      throw new VersionStoreError("VERSION_SCHEMA_REQUIRED", "Compact version storage migration is required.");
    }
    this.exists = db.prepare<{ hash: Uint8Array }>("SELECT 1 AS present FROM conversation_v3_objects WHERE hash=:hash");
    this.insert = db.prepare<[Uint8Array, ObjectKind, Uint8Array, Uint8Array, number]>(
      "INSERT INTO conversation_v3_objects(hash,kind,payload,refs,logical_bytes) VALUES(?,?,?,?,?)",
    );
    this.retain = db.prepare<{ hash: Uint8Array }>(
      "UPDATE conversation_v3_objects SET ref_count=ref_count+1 WHERE hash=:hash",
    );
    this.read = db.prepare<[number, number, Uint8Array]>(
      "SELECT kind,CASE WHEN length(payload)<=? THEN payload ELSE NULL END AS payload,CASE WHEN length(refs)<=? THEN refs ELSE NULL END AS refs FROM conversation_v3_objects WHERE hash=?",
    );
    this.readStats = db.prepare("SELECT objects,bytes FROM conversation_v3_storage WHERE id=1");
    this.reserve = db.prepare<[number, number, number]>(
      "UPDATE conversation_v3_storage SET objects=objects+1,bytes=bytes+? WHERE id=1 AND bytes<=? AND objects<?",
    );
    // A bare Buffer as the sole argument is treated as named parameters by this
    // libSQL binding. Always use explicit named maps for single binary arguments.
    this.orphan = db.prepare<{ hash: Uint8Array }>("SELECT logical_bytes AS bytes FROM conversation_v3_objects WHERE hash=:hash AND ref_count=0");
    this.remove = db.prepare<{ hash: Uint8Array }>("DELETE FROM conversation_v3_objects WHERE hash=:hash AND ref_count=0");
    this.release = db.prepare<{ hash: Uint8Array }>("UPDATE conversation_v3_objects SET ref_count=ref_count-1 WHERE hash=:hash AND ref_count>0");
  }

  put(kind: ObjectKind, bytes: Uint8Array, references: readonly string[] = []): string {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > objectByteLimit(kind))
      throw new VersionStoreError("VERSION_OBJECT_SIZE", "Object size exceeds its bounded payload limit.");
    if (references.length > MAX_REFERENCES)
      throw new VersionStoreError("VERSION_REFERENCE_LIMIT", "Object reference count exceeds its limit.");
    for (const ref of references) assertObjectId(ref, "reference");
    const refs = [...new Set(references)].sort();
    const payload = Buffer.from(bytes);
    const hash = identity(kind, payload, refs);
    const cost = objectStorageBytes(bytes.byteLength, refs.length);
    return atomicVersionWrite(this.db, () => {
      const binary = hashBytes(hash);
      if (this.exists.get({ hash: binary })) return hash;
      this.beforeGrow?.(cost);
      if (cost > this.budget.maxBytes || !this.reserve.run(
        cost, this.budget.maxBytes - cost, this.budget.maxObjects,
      ).changes)
        throw new VersionStoreError("VERSION_BUDGET_EXCEEDED", "Version storage budget exceeded; growth was not committed.");
      // Retain BEFORE inserting the parent: every referenced object must already
      // exist. This enforces an immutable DAG, enabling safe reference-count GC.
      for (const ref of refs) {
        if (!this.retain.run({ hash: hashBytes(ref) }).changes)
          throw new VersionStoreError("VERSION_REFERENCE_MISSING", "Object reference is missing; publish children first.");
      }
      this.insert.run(binary, kind, payload, packReferences(refs), cost);
      return hash;
    });
  }

  get(hash: string, expectedKind?: ObjectKind): StoredObject {
    assertObjectId(hash);
    const row = this.read.get(expectedKind ? objectByteLimit(expectedKind) : CHUNK_BYTES, REFERENCE_BYTES, hashBytes(hash)) as
      { kind: ObjectKind; payload: Uint8Array | null; refs: Uint8Array | null } | undefined;
    if (!row) throw new VersionStoreError("VERSION_OBJECT_MISSING", "Version object is missing.");
    if (expectedKind && row.kind !== expectedKind)
      throw new VersionStoreError("VERSION_OBJECT_KIND", "Unexpected version object kind.");
    if (!(row.payload instanceof Uint8Array) || row.payload.byteLength > objectByteLimit(row.kind))
      throw new VersionStoreError("VERSION_OBJECT_CORRUPT", "Object integrity check failed: invalid payload size.");
    if (!(row.refs instanceof Uint8Array))
      throw new VersionStoreError("VERSION_OBJECT_CORRUPT", "Object reference integrity check failed.");
    const references = unpackReferences(row.refs);
    if (references.length > MAX_REFERENCES || identity(row.kind, row.payload, references) !== hash)
      throw new VersionStoreError("VERSION_OBJECT_CORRUPT", "Object integrity check failed.");
    return { kind: row.kind, bytes: Buffer.from(row.payload), references };
  }

  /** Collector primitive: no recursive deletion. Weak ownership proofs must be
   * pruned first; FK RESTRICT and ref_count guard any still-protected root. */
  reclaim(hash: string): { bytes: number; edges: number } | null {
    const binding = { hash: hashBytes(hash) };
    return atomicVersionWrite(this.db, () => {
      const row = this.orphan.get(binding) as { bytes: number } | undefined;
      if (!row) return null;
      const stored = this.get(hash);
      if (row.bytes !== objectStorageBytes(stored.bytes.byteLength, stored.references.length))
        throw new VersionStoreError("VERSION_OBJECT_CORRUPT", "Object accounting integrity check failed.");
      if (!this.remove.run(binding).changes) return null;
      for (const reference of stored.references) {
        if (!this.release.run({ hash: hashBytes(reference) }).changes)
          throw new VersionStoreError("VERSION_OBJECT_CORRUPT", "Object reference-count integrity check failed.");
      }
      return { bytes: row.bytes, edges: stored.references.length };
    });
  }

  stats(): ObjectStats {
    const row = this.readStats.get() as ObjectStats | undefined;
    if (!row) throw new VersionStoreError("VERSION_STORAGE_CORRUPT", "Version storage counters are missing.");
    return { objects: row.objects, bytes: row.bytes };
  }
}
