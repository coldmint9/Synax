import { VersionObjects } from "./objects.js";
import {
  PAGE_BYTES,
  PAGE_ROWS,
  VersionStoreError,
  assertObjectId,
} from "./limits.js";
import { atomicVersionWrite } from "./transaction.js";
import {
  assertKey,
  childRef,
  nodeRef,
  readNode,
  writeBranches,
  writeLeaves,
  type Entry,
  type NodeRef,
  type TreeNode,
} from "./tree-nodes.js";

export interface TreeChange {
  key: string;
  value: string | null;
}
export interface TreeItem {
  key: string;
  value: string;
}
export interface TreePage {
  entries: TreeItem[];
  next?: string;
}
export interface TreePageOptions {
  after?: string;
  limit?: number;
  maxBytes?: number;
}
const EMPTY_PAGE_BYTES = Buffer.byteLength('{"entries":[]}');

/** Ordered by JS's locale-independent UTF-16 ordinal comparison, not localeCompare. */
function upperBound(
  items: readonly (readonly [string, ...unknown[]])[],
  key: string,
): number {
  let low = 0,
    high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle][0] <= key) low = middle + 1;
    else high = middle;
  }
  return low;
}

export class VersionTree {
  constructor(private readonly objects: VersionObjects) {}

  size(root: string | null): number {
    return root === null ? 0 : readNode(this.objects, root).count;
  }

  get(root: string | null, key: string): string | undefined {
    assertKey(key);
    if (root === null) return undefined;
    let node = readNode(this.objects, root);
    while (!("entries" in node)) {
      const child = childRef(
        node.children[Math.max(0, upperBound(node.children, key) - 1)],
        node.height,
      );
      node = readNode(this.objects, child.hash, child);
    }
    const index = upperBound(node.entries, key) - 1;
    return index >= 0 && node.entries[index][0] === key
      ? node.entries[index][1]
      : undefined;
  }

  /** Number of keys <= through, using cached subtree counts. */
  rank(root: string | null, through: string): number {
    assertKey(through);
    if (root === null) return 0;
    let node = readNode(this.objects, root),
      count = 0;
    while (!("entries" in node)) {
      const index = upperBound(node.children, through) - 1;
      if (index < 0) return count;
      for (let i = 0; i < index; i++) count += node.children[i][2];
      const child = childRef(node.children[index], node.height);
      node = readNode(this.objects, child.hash, child);
    }
    return count + upperBound(node.entries, through);
  }

  last(root: string | null): TreeItem | undefined {
    if (root === null) return undefined;
    let node = readNode(this.objects, root);
    while (!("entries" in node)) {
      const child = childRef(node.children.at(-1)!, node.height);
      node = readNode(this.objects, child.hash, child);
    }
    const [key, value] = node.entries.at(-1)!;
    return { key, value };
  }

  update(root: string | null, changes: readonly TreeChange[]): string | null {
    if (changes.length > PAGE_ROWS)
      throw new VersionStoreError(
        "VERSION_TREE_BATCH",
        "Tree update batch exceeds its limit.",
      );
    const dedup = new Map<string, TreeChange>();
    for (const change of changes) {
      assertKey(change.key);
      if (change.value !== null) assertObjectId(change.value, "reference");
      dedup.set(change.key, change);
    }
    const sorted = [...dedup.values()].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
    if (!sorted.length) return root;
    return atomicVersionWrite(this.objects.db, () => {
      let refs: NodeRef[];
      if (root === null) {
        refs = writeLeaves(
          this.objects,
          sorted
            .filter((change) => change.value !== null)
            .map((change) => [change.key, change.value!]),
        );
      } else {
        const node = readNode(this.objects, root);
        refs = this.rewrite(nodeRef(root, node), node, sorted, true);
      }
      if (!refs.length) return null;
      while (refs.length > 1) refs = writeBranches(this.objects, refs);
      // Removing whole subtrees can leave one-child roots. Collapse them so future
      // reads do not retain a chain proportional to old edits or branch history.
      let current = refs[0];
      while (current.height > 0) {
        const node = readNode(this.objects, current.hash, current);
        if ("entries" in node || node.children.length !== 1) break;
        current = childRef(node.children[0], node.height);
      }
      return current.hash;
    });
  }

  /** Keep keys <= through. Only the boundary path is visited; discarded
   * checkpoint versions remain immutable and are reclaimed asynchronously. */
  prefix(root: string | null, through: string): string | null {
    assertKey(through);
    if (root === null) return null;
    return atomicVersionWrite(this.objects.db, () => {
      const node = readNode(this.objects, root);
      const visit = (ref: NodeRef, current: TreeNode): NodeRef[] => {
        if ("entries" in current) {
          const end = upperBound(current.entries, through);
          if (end === current.entries.length) return [ref];
          return writeLeaves(this.objects, current.entries.slice(0, end));
        }
        const index = upperBound(current.children, through) - 1;
        if (index < 0) return [];
        const boundary = childRef(current.children[index], current.height);
        const tail = visit(
          boundary,
          readNode(this.objects, boundary.hash, boundary),
        );
        if (
          index === current.children.length - 1 &&
          tail.length === 1 &&
          tail[0].hash === boundary.hash
        )
          return [ref];
        const children = current.children
          .slice(0, index)
          .map((child) => childRef(child, current.height));
        return writeBranches(this.objects, [...children, ...tail]);
      };
      const refs = visit(nodeRef(root, node), node);
      if (!refs.length) return null;
      let result = refs[0];
      while (result.height > 0) {
        const current = readNode(this.objects, result.hash, result);
        if ("entries" in current || current.children.length !== 1) break;
        result = childRef(current.children[0], current.height);
      }
      return result.hash;
    });
  }

  private rewrite(
    ref: NodeRef,
    node: TreeNode,
    changes: readonly TreeChange[],
    root = false,
  ): NodeRef[] {
    if ("entries" in node) {
      const result: Entry[] = [];
      let cursor = 0;
      for (const entry of node.entries) {
        while (cursor < changes.length && changes[cursor].key < entry[0]) {
          const change = changes[cursor++];
          if (change.value !== null) result.push([change.key, change.value]);
        }
        if (cursor < changes.length && changes[cursor].key === entry[0]) {
          const change = changes[cursor++];
          if (change.value !== null) result.push([change.key, change.value]);
        } else result.push(entry);
      }
      for (; cursor < changes.length; cursor++) {
        const change = changes[cursor];
        if (change.value !== null) result.push([change.key, change.value]);
      }
      if (
        result.length === node.entries.length &&
        result.every(
          (entry, i) =>
            entry[0] === node.entries[i][0] && entry[1] === node.entries[i][1],
        )
      )
        return [ref];
      return writeLeaves(this.objects, result);
    }
    const children: NodeRef[] = [];
    let cursor = 0;
    for (let i = 0; i < node.children.length; i++) {
      const child = childRef(node.children[i], node.height);
      const start = cursor,
        next = node.children[i + 1]?.[0];
      while (
        cursor < changes.length &&
        (next === undefined || changes[cursor].key < next)
      )
        cursor++;
      if (start === cursor) children.push(child);
      else
        children.push(
          ...this.rewrite(
            child,
            readNode(this.objects, child.hash, child),
            changes.slice(start, cursor),
          ),
        );
    }
    if (
      children.length === node.children.length &&
      children.every((child, i) => child.hash === node.children[i][1])
    )
      return [ref];
    if (root && children.length === 1) return children;
    return writeBranches(this.objects, children);
  }

  page(root: string | null, options: TreePageOptions = {}): TreePage {
    const { after, limit = PAGE_ROWS, maxBytes = PAGE_BYTES } = options;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_ROWS)
      throw new VersionStoreError(
        "VERSION_PAGE_LIMIT",
        "Invalid tree page limit.",
      );
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < EMPTY_PAGE_BYTES ||
      maxBytes > PAGE_BYTES
    )
      throw new VersionStoreError(
        "VERSION_PAGE_BUDGET",
        "Invalid tree page byte budget.",
      );
    if (after !== undefined) assertKey(after);
    const entries: TreeItem[] = [];
    if (root === null) return { entries };
    let bytes = EMPTY_PAGE_BYTES;
    for (const [key, value] of this.walk(root, after)) {
      const item = { key, value };
      const addition =
        Buffer.byteLength(JSON.stringify(item)) + (entries.length ? 1 : 0);
      // Reserve the cursor even before we know whether a subsequent item exists.
      const withCursor =
        bytes + addition + 8 + Buffer.byteLength(JSON.stringify(key));
      if (entries.length === limit || withCursor > maxBytes) {
        if (!entries.length)
          throw new VersionStoreError(
            "VERSION_PAGE_BUDGET",
            "Page byte budget cannot fit the next entry and cursor.",
          );
        return { entries, next: entries.at(-1)!.key };
      }
      entries.push(item);
      bytes += addition;
    }
    return { entries };
  }

  private *walk(
    hash: string,
    after?: string,
    expected?: NodeRef,
  ): Generator<Entry> {
    const node = readNode(this.objects, hash, expected);
    if ("entries" in node) {
      const start = after === undefined ? 0 : upperBound(node.entries, after);
      for (let i = start; i < node.entries.length; i++) yield node.entries[i];
    } else {
      const start =
        after === undefined
          ? 0
          : Math.max(0, upperBound(node.children, after) - 1);
      for (let i = start; i < node.children.length; i++) {
        const child = childRef(node.children[i], node.height);
        yield* this.walk(child.hash, after, child);
      }
    }
  }
}
