import { VersionObjects } from "./objects.js";
import { VersionStoreError, assertObjectId } from "./limits.js";
import { readNode } from "./tree-nodes.js";

const ROOT_KEYS = ["transcriptRoot", "stateRoot", "sessionTreeRoot", "fileManifestRoot", "aggregateRoot"] as const;
export type VersionRoots = Record<(typeof ROOT_KEYS)[number], string | null>;

/** Fixed schema/order makes equal root sets share one immutable version object. */
export function createVersion(objects: VersionObjects, input: Partial<VersionRoots> = {}): string {
  if (Object.keys(input).some(key => !ROOT_KEYS.includes(key as (typeof ROOT_KEYS)[number])))
    throw new VersionStoreError("VERSION_ROOT_SCHEMA", "Unknown version root field.");
  const roots = Object.fromEntries(ROOT_KEYS.map(key => [key, input[key] ?? null])) as VersionRoots;
  const references = [...new Set(ROOT_KEYS.flatMap(key => roots[key] === null ? [] : [roots[key]!]))].sort();
  for (const reference of references) readNode(objects, reference);
  return objects.put("version", Buffer.from(JSON.stringify({ format: 3, roots })), references);
}

export function readVersion(objects: VersionObjects, id: string): VersionRoots {
  const stored = objects.get(id, "version");
  try {
    const value = JSON.parse(stored.bytes.toString()) as { format: number; roots: VersionRoots };
    if (value?.format !== 3 || !value.roots || Object.keys(value.roots).length !== ROOT_KEYS.length) throw new Error();
    for (const key of ROOT_KEYS) {
      if (value.roots[key] !== null) assertObjectId(value.roots[key]);
    }
    const references = [...new Set(ROOT_KEYS.flatMap(key => value.roots[key] === null ? [] : [value.roots[key]!]))].sort();
    if (references.length !== stored.references.length || references.some((ref, i) => ref !== stored.references[i])) throw new Error();
    return value.roots;
  } catch {
    throw new VersionStoreError("VERSION_ROOT_CORRUPT", "Invalid immutable version root manifest.");
  }
}
