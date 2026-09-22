import { createHash } from "node:crypto";
import type Database from "libsql";
import {
  CHUNK_BYTES, MAX_REFERENCES, VersionStoreError,
  assertObjectId, objectByteLimit, type ObjectKind,
} from "./limits.js";
import { atomicVersionWrite } from "./transaction.js";

export interface ObjectBudget { maxBytes: number; maxObjects: number }
export interface StoredObject { kind: ObjectKind; bytes: Buffer; references: string[] }
export interface ObjectStats { objects: number; bytes: number }

// Admission accounts for metadata/edges as well as payload. Physical DB, indexes,
// WAL and temporary-file accounting belongs to the outer disk-budget controller.
const OBJECT_OVERHEAD = 128;
const EDGE_OVERHEAD = 160;

function identity(kind: ObjectKind, bytes: Uint8Array, references: readonly string[]): string {
  return createHash("sha256")
    .update(`synax.checkpoint.v3\0${kind}\0${bytes.byteLength}\0`)
    .update(bytes).update("\0").update(references.join(",")).digest("hex");
}

export class VersionObjects {
  private readonly budget: ObjectBudget;
  private readonly exists;
  private readonly insert;
  private readonly insertEdge;
  private readonly read;
  private readonly readEdges;
  private readonly readStats;
  private readonly reserve;

  constructor(readonly db: Database.Database, budget: ObjectBudget) {
    for (const value of [budget.maxBytes, budget.maxObjects]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new VersionStoreError("VERSION_BUDGET_INVALID", "Object budget must be a positive safe integer.");
    }
    this.budget = { ...budget };
    this.exists = db.prepare<[string]>("SELECT 1 AS present FROM conversation_v3_objects WHERE hash=?");
    this.insert = db.prepare<[string, ObjectKind, Uint8Array, number]>(
      "INSERT INTO conversation_v3_objects(hash,kind,payload,logical_bytes) VALUES(?,?,?,?)",
    );
    this.insertEdge = db.prepare<[string, string]>(
      "INSERT INTO conversation_v3_edges(source_hash,target_hash) VALUES(?,?)",
    );
    this.read = db.prepare<[number, string]>(
      "SELECT kind,CASE WHEN length(payload)<=? THEN payload ELSE NULL END AS payload FROM conversation_v3_objects WHERE hash=?",
    );
    this.readEdges = db.prepare<[string, number]>(
      "SELECT target_hash FROM conversation_v3_edges WHERE source_hash=? ORDER BY target_hash LIMIT ?",
    );
    this.readStats = db.prepare("SELECT objects,bytes FROM conversation_v3_storage WHERE id=1");
    this.reserve = db.prepare<[number, number, number]>(
      "UPDATE conversation_v3_storage SET objects=objects+1,bytes=bytes+? WHERE id=1 AND bytes<=? AND objects<?",
    );
  }

  put(kind: ObjectKind, bytes: Uint8Array, references: readonly string[] = []): string {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > objectByteLimit(kind))
      throw new VersionStoreError("VERSION_OBJECT_SIZE", "Object size exceeds its bounded payload limit.");
    if (references.length > MAX_REFERENCES)
      throw new VersionStoreError("VERSION_REFERENCE_LIMIT", "Object reference count exceeds its limit.");
    for (const ref of references) assertObjectId(ref, "reference");
    const refs = [...new Set(references)].sort();
    const hash = identity(kind, bytes, refs);
    const cost = OBJECT_OVERHEAD + bytes.byteLength + refs.length * EDGE_OVERHEAD;
    return atomicVersionWrite(this.db, () => {
      if (this.exists.get(hash)) return hash;
      for (const ref of refs) {
        if (!this.exists.get(ref))
          throw new VersionStoreError("VERSION_REFERENCE_MISSING", "Object reference is missing; publish children first.");
      }
      if (cost > this.budget.maxBytes || !this.reserve.run(
        cost, this.budget.maxBytes - cost, this.budget.maxObjects,
      ).changes)
        throw new VersionStoreError("VERSION_BUDGET_EXCEEDED", "Version storage budget exceeded; growth was not committed.");
      this.insert.run(hash, kind, bytes, cost);
      for (const ref of refs) this.insertEdge.run(hash, ref);
      return hash;
    });
  }

  get(hash: string, expectedKind?: ObjectKind): StoredObject {
    assertObjectId(hash);
    const row = this.read.get(expectedKind ? objectByteLimit(expectedKind) : CHUNK_BYTES, hash) as
      { kind: ObjectKind; payload: Uint8Array | null } | undefined;
    if (!row) throw new VersionStoreError("VERSION_OBJECT_MISSING", "Version object is missing.");
    if (expectedKind && row.kind !== expectedKind)
      throw new VersionStoreError("VERSION_OBJECT_KIND", "Unexpected version object kind.");
    if (!(row.payload instanceof Uint8Array) || row.payload.byteLength > objectByteLimit(row.kind))
      throw new VersionStoreError("VERSION_OBJECT_CORRUPT", "Object integrity check failed: invalid payload size.");
    const references = (this.readEdges.all(hash, MAX_REFERENCES + 1) as { target_hash: string }[])
      .map(row => row.target_hash);
    if (references.length > MAX_REFERENCES || identity(row.kind, row.payload, references) !== hash)
      throw new VersionStoreError("VERSION_OBJECT_CORRUPT", "Object integrity check failed.");
    return { kind: row.kind, bytes: Buffer.from(row.payload), references };
  }

  stats(): ObjectStats {
    const row = this.readStats.get() as ObjectStats | undefined;
    if (!row) throw new VersionStoreError("VERSION_STORAGE_CORRUPT", "Version storage counters are missing.");
    return { objects: row.objects, bytes: row.bytes };
  }
}
