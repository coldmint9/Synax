/** Limits apply before serialization/SQLite/IPC, not after a large result is read. */
export const CHUNK_BYTES = 64 * 1024;
export const TREE_NODE_BYTES = 16 * 1024;
export const VERSION_BYTES = 4 * 1024;
export const MAX_REFERENCES = 256;
export const PAGE_ROWS = 256;
export const PAGE_BYTES = 1024 * 1024;
export const KEY_BYTES = 1024;
export const MAX_TREE_DEPTH = 32;
export const OBJECT_KINDS = ["chunk", "tree", "record", "version"] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];
export const HASH_PATTERN = /^[0-9a-f]{64}$/;

export class VersionStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "VersionStoreError";
  }
}

export function objectByteLimit(kind: ObjectKind): number {
  if (!OBJECT_KINDS.includes(kind))
    throw new VersionStoreError("VERSION_OBJECT_KIND", "Unknown version object kind.");
  return kind === "chunk" ? CHUNK_BYTES : kind === "version" ? VERSION_BYTES : TREE_NODE_BYTES;
}

export function assertObjectId(id: string, label = "identity"): void {
  if (typeof id !== "string" || !HASH_PATTERN.test(id))
    throw new VersionStoreError("VERSION_OBJECT_ID", `Invalid object ${label}.`);
}
