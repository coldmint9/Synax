import { createHash } from "node:crypto";
import type { VersionObjects } from "../version-store/objects.js";
import { VersionTree, type TreeChange } from "../version-store/tree.js";
import type { VersionRoots } from "../version-store/versions.js";
import { PAGE_ROWS, VersionStoreError } from "../version-store/limits.js";
import type { RuntimeRecordCodec } from "./record-codec.js";
import type { RuntimeWrite } from "./batch-input.js";

export interface TableState {
  kind: "table";
  version: 1;
  ids: string | null;
  order: string | null;
  next: number;
  count: number;
}
export const orderKey = (order: number) => order.toString().padStart(16, "0");
export function eventKey(type: unknown): string {
  if (
    typeof type !== "string" ||
    !type.length ||
    type.length > 128 ||
    !type.isWellFormed() ||
    type.includes("\0") ||
    Buffer.byteLength(type) > 128
  )
    throw new VersionStoreError("VERSION_EVENT_TYPE", "Invalid event type.");
  return `event-type/${type}`;
}

const scopes: Record<string, readonly string[]> = {
  messages: ["runId", "stepId"],
  steps: ["runId"],
  parts: ["runId", "stepId"],
  tools: ["runId", "stepId"],
  permissions: ["runId", "stepId"],
  artifacts: [],
  contexts: [],
  compactions: ["runId"],
  interactions: ["runId", "stepId"],
};
export function scopeKey(table: string, field: string, value: unknown): string {
  if (
    !scopes[table]?.includes(field) ||
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value) > 256
  )
    throw new VersionStoreError("VERSION_SCOPE", "Invalid execution scope.");
  return `scope/${table}/${field}/${createHash("sha256").update(value).digest("hex")}`;
}
/** Caller owns a synchronous transaction. Each touched path is published once per
 * bounded change chunk, not once per event; superseded row payloads are not stored. */
export function writeRuntimeBatch(
  objects: VersionObjects,
  records: RuntimeRecordCodec,
  tree: VersionTree,
  sessionId: string,
  roots: VersionRoots,
  writes: readonly RuntimeWrite[],
  readTable: (table: string) => TableState,
): void {
  const groups = new Map<string, RuntimeWrite[]>();
  for (const write of writes) {
    if (write.table === "events") eventKey(write.fields.type);
    const rows = groups.get(write.table) ?? [];
    rows.push(write);
    groups.set(write.table, rows);
  }
  const stateChanges: TreeChange[] = [];
  const apply = (root: string | null, changes: readonly TreeChange[]) => {
    for (let start = 0; start < changes.length; start += PAGE_ROWS)
      root = tree.update(root, changes.slice(start, start + PAGE_ROWS));
    return root;
  };
  for (const [table, rows] of groups) {
    const state = readTable(table);
    if (!Number.isSafeInteger(state.next + rows.length))
      throw new VersionStoreError(
        "VERSION_RECORD_ORDER",
        "Runtime order exhausted.",
      );
    const latest = new Map<string, { write: RuntimeWrite; order: number }>();
    rows.forEach((write, index) =>
      latest.set(write.id, { write, order: state.next + index }),
    );
    const ids: TreeChange[] = [],
      orders: TreeChange[] = [],
      types = new Map<string, TreeChange[]>();
    const typeChange = (key: string, change: TreeChange) => {
      const items = types.get(key) ?? [];
      items.push(change);
      types.set(key, items);
    };
    for (const { write, order: appendOrder } of latest.values()) {
      const previous = tree.get(state.ids, write.id),
        old = previous ? records.header(previous) : undefined;
      const order =
        old && table !== "events" && table !== "messages"
          ? old.order
          : appendOrder;
      const record = records.write(
        table,
        sessionId,
        write.id,
        order,
        write.fields,
      );
      ids.push({ key: write.id, value: record });
      if (old) orders.push({ key: orderKey(old.order), value: null });
      else state.count++;
      orders.push({ key: orderKey(order), value: record });
      const scopeFields = scopes[table] ?? [];
      const prior =
        old && previous && scopeFields.length
          ? records.read(previous, 4096, scopeFields)
          : {};
      for (const field of scopeFields) {
        if (old && typeof prior[field] === "string")
          typeChange(scopeKey(table, field, prior[field]), {
            key: orderKey(old.order),
            value: null,
          });
        if (typeof write.fields[field] === "string")
          typeChange(scopeKey(table, field, write.fields[field]), {
            key: orderKey(order),
            value: record,
          });
      }
      if (table === "events") {
        if (old && previous)
          typeChange(eventKey(records.read(previous, 1024, ["type"]).type), {
            key: orderKey(old.order),
            value: null,
          });
        typeChange(eventKey(write.fields.type), {
          key: orderKey(order),
          value: record,
        });
      }
    }
    state.ids = apply(state.ids, ids);
    state.order = apply(state.order, orders);
    state.next += rows.length;
    const manifest = objects.put("record", Buffer.from(JSON.stringify(state)), [
      state.ids!,
      state.order!,
    ]);
    stateChanges.push({ key: `table/${table}`, value: manifest });
    for (const [key, changes] of types)
      stateChanges.push({
        key,
        value: apply(tree.get(roots.stateRoot, key) ?? null, changes),
      });
    if (table === "messages") roots.transcriptRoot = state.order;
  }
  roots.stateRoot = apply(roots.stateRoot, stateChanges);
}

export function scopeFields(table: string): readonly string[] {
  return scopes[table] ?? [];
}
