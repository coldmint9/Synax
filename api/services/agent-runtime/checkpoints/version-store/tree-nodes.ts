import { type VersionObjects } from "./objects.js";
import {
  KEY_BYTES, MAX_TREE_DEPTH, TREE_NODE_BYTES, VersionStoreError, assertObjectId,
} from "./limits.js";

export type Entry = readonly [key: string, value: string];
export type Child = readonly [firstKey: string, hash: string, count: number];
export type TreeNode =
  | { v: 1; height: 0; count: number; entries: Entry[] }
  | { v: 1; height: number; count: number; children: Child[] };
export interface NodeRef { key: string; hash: string; count: number; height: number }
const MAX_ITEMS = 128;
const TARGET_BYTES = TREE_NODE_BYTES * 0.75 - 128;

export function assertKey(key: string): void {
  if (typeof key !== "string" || !key.isWellFormed() || Buffer.byteLength(key) > KEY_BYTES)
    throw new VersionStoreError("VERSION_TREE_KEY", "Tree key exceeds its size limit or is invalid Unicode.");
}

function corrupt(): never {
  throw new VersionStoreError("VERSION_TREE_CORRUPT", "Invalid checkpoint tree structure.");
}

export function nodeRef(hash: string, node: TreeNode): NodeRef {
  return { hash, key: "entries" in node ? node.entries[0][0] : node.children[0][0], count: node.count, height: node.height };
}

export function childRef(child: Child, parentHeight: number): NodeRef {
  return { key: child[0], hash: child[1], count: child[2], height: parentHeight - 1 };
}

export function readNode(objects: VersionObjects, hash: string, expected?: NodeRef): TreeNode {
  const stored = objects.get(hash, "tree");
  try {
    const node = JSON.parse(stored.bytes.toString()) as TreeNode;
    if (!node || node.v !== 1 || !Number.isSafeInteger(node.height) || node.height < 0 || node.height >= MAX_TREE_DEPTH ||
        !Number.isSafeInteger(node.count) || node.count < 1) corrupt();
    const leaf = node.height === 0;
    const items = leaf ? (node as { entries: Entry[] }).entries : (node as { children: Child[] }).children;
    if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) corrupt();
    let previous: string | undefined, count = 0;
    for (const item of items) {
      if (!Array.isArray(item) || item.length !== (leaf ? 2 : 3)) corrupt();
      assertKey(item[0]);
      assertObjectId(item[1]);
      if (previous !== undefined && item[0] <= previous) corrupt();
      previous = item[0];
      const size = leaf ? 1 : item[2];
      if (!Number.isSafeInteger(size) || size! < 1) corrupt();
      count += size!;
    }
    if (!Number.isSafeInteger(count) || count !== node.count) corrupt();
    const refs = [...new Set(items.map(item => item[1]))].sort();
    if (refs.length !== stored.references.length || refs.some((ref, i) => ref !== stored.references[i])) corrupt();
    if (expected && (expected.height !== node.height || expected.count !== node.count || expected.key !== items[0][0])) corrupt();
    return node;
  } catch (error) {
    if (error instanceof VersionStoreError && error.code === "VERSION_TREE_CORRUPT") throw error;
    return corrupt();
  }
}

/** Each batch is bounded before entering here. Sizes include JSON escaping. */
function partition<T>(items: readonly T[]): T[][] {
  if (!items.length) return [];
  const groups: T[][] = [];
  let group: T[] = [], bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (size > TARGET_BYTES) throw new VersionStoreError("VERSION_TREE_SIZE", "Tree item exceeds its node size budget.");
    if (group.length && (bytes + size > TARGET_BYTES || group.length === MAX_ITEMS)) {
      groups.push(group); group = []; bytes = 0;
    }
    group.push(item); bytes += size;
  }
  groups.push(group);
  if (groups.length < 2) return groups;
  // Redistribute the final two new pages rather than leaving a tiny last page.
  const tail = groups.slice(-2).flat();
  const sizes = tail.map(item => Buffer.byteLength(JSON.stringify(item)) + 1);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (tail.length <= MAX_ITEMS && total <= TARGET_BYTES) {
    groups.splice(-2, 2, tail);
    return groups;
  }
  let left = 0, best = -1, distance = Infinity;
  for (let i = 1; i < tail.length; i++) {
    left += sizes[i - 1];
    if (i > MAX_ITEMS || tail.length - i > MAX_ITEMS || left > TREE_NODE_BYTES - 128 || total - left > TREE_NODE_BYTES - 128) continue;
    if (Math.abs(total - 2 * left) < distance) {
      best = i; distance = Math.abs(total - 2 * left);
    }
  }
  if (best !== -1) groups.splice(-2, 2, tail.slice(0, best), tail.slice(best));
  return groups;
}

function persist(objects: VersionObjects, node: TreeNode): NodeRef {
  if (node.height >= MAX_TREE_DEPTH || !Number.isSafeInteger(node.count))
    throw new VersionStoreError("VERSION_TREE_DEPTH", "Tree exceeds its depth or count limit.");
  const refs = ("entries" in node ? node.entries : node.children).map(item => item[1]);
  const hash = objects.put("tree", Buffer.from(JSON.stringify(node)), refs);
  return nodeRef(hash, node);
}

export function writeLeaves(objects: VersionObjects, entries: readonly Entry[]): NodeRef[] {
  return partition(entries).map(entries => persist(objects, { v: 1, height: 0, count: entries.length, entries }));
}

export function writeBranches(objects: VersionObjects, children: readonly NodeRef[]): NodeRef[] {
  if (!children.length) return [];
  const height = children[0].height + 1;
  if (children.some(child => child.height !== height - 1)) corrupt();
  const tuples: Child[] = children.map(child => [child.key, child.hash, child.count]);
  return partition(tuples).map(children => persist(objects, {
    v: 1, height, count: children.reduce((count, child) => count + child[2], 0), children,
  }));
}
