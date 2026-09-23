import { MAX_REFERENCES, VersionStoreError, assertObjectId } from "./limits.js";

export const HASH_BYTES = 32;
export const REFERENCE_BYTES = HASH_BYTES * MAX_REFERENCES;
export function hashBytes(id: string): Buffer {
  assertObjectId(id);
  return Buffer.from(id, "hex");
}
export function packReferences(references: readonly string[]): Buffer {
  if (references.length > MAX_REFERENCES)
    throw new VersionStoreError("VERSION_REFERENCE_LIMIT", "Object reference count exceeds its limit.");
  const bytes = Buffer.alloc(references.length * HASH_BYTES);
  references.forEach((id, index) => hashBytes(id).copy(bytes, index * HASH_BYTES));
  return bytes;
}
export function unpackReferences(bytes: Uint8Array): string[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > REFERENCE_BYTES || bytes.byteLength % HASH_BYTES)
    throw new VersionStoreError("VERSION_OBJECT_CORRUPT", "Object reference integrity check failed.");
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const references: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += HASH_BYTES) {
    const id = data.toString("hex", offset, offset + HASH_BYTES);
    if (references.length && references.at(-1)! >= id)
      throw new VersionStoreError("VERSION_OBJECT_CORRUPT", "Object reference integrity check failed: unordered or duplicate references.");
    references.push(id);
  }
  return references;
}
