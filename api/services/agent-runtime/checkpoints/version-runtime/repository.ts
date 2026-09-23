import {
  RuntimeCheckpointIndex,
  type RuntimeCheckpoint,
} from "./checkpoint-index.js";
export type { RuntimeCheckpoint } from "./checkpoint-index.js";
import { assertRuntimeBatch, type RuntimeWrite } from "./batch-input.js";
import {
  writeRuntimeBatch,
  orderKey,
  eventKey,
  scopeKey,
  scopeFields,
  type TableState,
} from "./batch-write.js";
import { readVersionSnapshot } from "../version-store/read-snapshot.js";
import { createHash } from "node:crypto";
import { VersionObjects } from "../version-store/objects.js";
import { VersionHeads, type HeadState } from "../version-store/heads.js";
import { VersionTree } from "../version-store/tree.js";
import {
  createVersion,
  readVersion,
  type VersionRoots,
} from "../version-store/versions.js";
import { atomicVersionWrite } from "../version-store/transaction.js";
import {
  PAGE_BYTES,
  PAGE_ROWS,
  VersionStoreError,
  assertObjectId,
} from "../version-store/limits.js";
import { RuntimeRecordCodec } from "./record-codec.js";

export interface RecordPageOptions {
  reverse?: boolean;
  preview?: boolean;
  scope?: { field: string; value: string };
  limit?: number;
  maxBytes?: number;
  cursor?: string;
  fields?: readonly string[];
}
const allowedTables = [
  "messages",
  "events",
  "runs",
  "steps",
  "parts",
  "tools",
  "permissions",
  "artifacts",
  "contexts",
  "thinking",
  "compactions",
  "interactions",
  "work",
  "assets",
] as const;
function tableName(table: string): void {
  if (!allowedTables.includes(table as (typeof allowedTables)[number]))
    throw new VersionStoreError(
      "VERSION_TABLE",
      "Unsupported versioned runtime table.",
    );
}
function stale(): never {
  throw new VersionStoreError(
    "HISTORY_STALE",
    "Conversation revision changed; refresh the view.",
  );
}

export class RuntimeVersionRepository {
  readonly records: RuntimeRecordCodec;
  private readonly tree: VersionTree;
  private readonly heads: VersionHeads;
  private readonly checkpointIndex: RuntimeCheckpointIndex;
  constructor(readonly objects: VersionObjects) {
    this.records = new RuntimeRecordCodec(objects);
    this.tree = new VersionTree(objects);
    this.heads = new VersionHeads(objects.db, objects);
    this.checkpointIndex = new RuntimeCheckpointIndex(objects);
  }
  head(sessionId: string): HeadState {
    return this.heads.read(sessionId);
  }
  create(sessionId: string, session: Record<string, unknown>): HeadState {
    return atomicVersionWrite(this.objects.db, () => {
      const record = this.records.write(
        "session",
        sessionId,
        sessionId,
        0,
        session,
      );
      const stateRoot = this.tree.update(null, [
        { key: "session", value: record },
      ]);
      return this.heads.create(
        sessionId,
        createVersion(this.objects, { stateRoot }),
      );
    });
  }
  private roots(sessionId: string): { head: HeadState; roots: VersionRoots } {
    const head = this.head(sessionId);
    return { head, roots: readVersion(this.objects, head.versionId) };
  }
  private table(roots: VersionRoots, table: string): TableState {
    tableName(table);
    const ref = this.tree.get(roots.stateRoot, `table/${table}`);
    if (!ref)
      return {
        kind: "table",
        version: 1,
        ids: null,
        order: null,
        next: 1,
        count: 0,
      };
    const stored = this.objects.get(ref, "record"),
      value = JSON.parse(stored.bytes.toString()) as TableState;
    if (
      value.kind !== "table" ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.next) ||
      value.next < 1 ||
      !Number.isSafeInteger(value.count) ||
      value.count < 0
    )
      throw new VersionStoreError(
        "VERSION_TABLE_CORRUPT",
        "Invalid version table manifest.",
      );
    const refs = [
      ...new Set(
        [value.ids, value.order].filter((id): id is string => id !== null),
      ),
    ].sort();
    for (const id of refs) assertObjectId(id);
    if (
      refs.length !== stored.references.length ||
      refs.some((ref, i) => ref !== stored.references[i]) ||
      this.tree.size(value.ids) !== value.count ||
      this.tree.size(value.order) !== value.count
    )
      throw new VersionStoreError(
        "VERSION_TABLE_CORRUPT",
        "Version table count/reference integrity failed.",
      );
    return value;
  }
  private publish(
    sessionId: string,
    head: HeadState,
    roots: VersionRoots,
  ): HeadState {
    return this.heads.publish({
      sessionId,
      versionId: createVersion(this.objects, roots),
      expectedRevision: head.revision,
      expectedEpoch: head.epoch,
    });
  }
  put(
    sessionId: string,
    table: string,
    id: string,
    fields: Record<string, unknown>,
  ): HeadState {
    return this.publishBatch(sessionId, [{ table, id, fields }]);
  }
  putBatch(sessionId: string, writes: readonly RuntimeWrite[]): HeadState {
    assertRuntimeBatch(writes);
    return this.publishBatch(sessionId, writes);
  }
  private publishBatch(
    sessionId: string,
    writes: readonly RuntimeWrite[],
  ): HeadState {
    for (const write of writes) tableName(write.table);
    if (!writes.length) return this.head(sessionId);
    return atomicVersionWrite(this.objects.db, () => {
      const { head, roots } = this.roots(sessionId);
      writeRuntimeBatch(
        this.objects,
        this.records,
        this.tree,
        sessionId,
        roots,
        writes,
        (table) => this.table(roots, table),
      );
      return this.publish(sessionId, head, roots);
    });
  }
  remove(sessionId: string, table: string, id: string): HeadState {
    return atomicVersionWrite(this.objects.db, () => {
      const { head, roots } = this.roots(sessionId),
        state = this.table(roots, table),
        ref = this.tree.get(state.ids, id);
      if (!ref) return head;
      const header = this.records.header(ref),
        fields = scopeFields(table),
        old = this.records.read(
          ref,
          4096,
          table === "events" ? ["type", ...fields] : fields,
        );
      state.ids = this.tree.update(state.ids, [{ key: id, value: null }]);
      state.order = this.tree.update(state.order, [
        { key: orderKey(header.order), value: null },
      ]);
      state.count--;
      const manifest = this.objects.put(
        "record",
        Buffer.from(JSON.stringify(state)),
        [state.ids, state.order].filter((ref): ref is string => ref !== null),
      );
      const changes: { key: string; value: string | null }[] = [
        { key: `table/${table}`, value: manifest },
      ];
      const keys = fields
        .filter((field) => typeof old[field] === "string")
        .map((field) => scopeKey(table, field, old[field]));
      if (table === "events") keys.push(eventKey(old.type));
      for (const key of keys)
        changes.push({
          key,
          value: this.tree.update(this.tree.get(roots.stateRoot, key) ?? null, [
            { key: orderKey(header.order), value: null },
          ]),
        });
      roots.stateRoot = this.tree.update(roots.stateRoot, changes);
      if (table === "messages") roots.transcriptRoot = state.order;
      return this.publish(sessionId, head, roots);
    });
  }
  session(sessionId: string, fields: Record<string, unknown>): HeadState {
    return atomicVersionWrite(this.objects.db, () => {
      const { head, roots } = this.roots(sessionId),
        record = this.records.write("session", sessionId, sessionId, 0, fields);
      roots.stateRoot = this.tree.update(roots.stateRoot, [
        { key: "session", value: record },
      ]);
      return this.publish(sessionId, head, roots);
    });
  }
  readSession(sessionId: string) {
    return readVersionSnapshot(this.objects.db, () =>
      this.readSessionSnapshot(sessionId),
    );
  }
  private readSessionSnapshot(sessionId: string): Record<string, unknown> {
    const { roots } = this.roots(sessionId),
      record = this.tree.get(roots.stateRoot, "session");
    if (!record)
      throw new VersionStoreError(
        "VERSION_SESSION_MISSING",
        "Historical session record is missing.",
      );
    return this.records.read(record, PAGE_BYTES);
  }
  count(sessionId: string, table: string) {
    return readVersionSnapshot(this.objects.db, () =>
      this.countSnapshot(sessionId, table),
    );
  }
  private countSnapshot(sessionId: string, table: string): number {
    return this.table(this.roots(sessionId).roots, table).count;
  }
  recordReference(
    sessionId: string,
    table: string,
    id: string,
  ): string | undefined {
    return readVersionSnapshot(this.objects.db, () =>
      this.tree.get(this.table(this.roots(sessionId).roots, table).ids, id),
    );
  }
  previewRecord(sessionId: string, table: string, id: string): Record<string, unknown> | undefined {
    const ref = this.recordReference(sessionId, table, id);
    return ref ? this.records.preview(ref) : undefined;
  }
  get(sessionId: string, table: string, id: string, budget = PAGE_BYTES) {
    return readVersionSnapshot(this.objects.db, () =>
      this.getSnapshot(sessionId, table, id, budget),
    );
  }
  private getSnapshot(
    sessionId: string,
    table: string,
    id: string,
    budget = PAGE_BYTES,
  ): Record<string, unknown> | undefined {
    const ref = this.tree.get(
      this.table(this.roots(sessionId).roots, table).ids,
      id,
    );
    return ref ? this.records.read(ref, budget) : undefined;
  }
  last(
    sessionId: string,
    table: string,
    fields?: readonly string[],
    scope?: { field: string; value: string },
  ): Record<string, unknown> | undefined {
    return readVersionSnapshot(this.objects.db, () => {
      const { roots } = this.roots(sessionId),
        state = this.table(roots, table);
      const root = scope
        ? (this.tree.get(
            roots.stateRoot,
            scopeKey(table, scope.field, scope.value),
          ) ?? null)
        : state.order;
      const entry = this.tree.last(root);
      return entry
        ? this.records.read(entry.value, PAGE_BYTES, fields)
        : undefined;
    });
  }
  latestEvent(sessionId: string, types: readonly string[]) {
    return readVersionSnapshot(this.objects.db, () =>
      this.latestEventSnapshot(sessionId, types),
    );
  }
  private latestEventSnapshot(
    sessionId: string,
    types: readonly string[],
  ): Record<string, unknown> | null {
    if (types.length > 64)
      throw new VersionStoreError(
        "VERSION_PAGE_BUDGET",
        "Event type query exceeds its limit.",
      );
    const { roots } = this.roots(sessionId);
    let latest: { key: string; value: string } | undefined;
    for (const type of types) {
      const found = this.tree.last(
        this.tree.get(roots.stateRoot, eventKey(type)) ?? null,
      );
      if (found && (!latest || found.key > latest.key)) latest = found;
    }
    return latest ? this.records.read(latest.value, PAGE_BYTES) : null;
  }
  countEventsAfter(sessionId: string, eventId: string, type: string) {
    return readVersionSnapshot(this.objects.db, () =>
      this.countEventsAfterSnapshot(sessionId, eventId, type),
    );
  }
  private countEventsAfterSnapshot(
    sessionId: string,
    eventId: string,
    type: string,
  ): number {
    const { roots } = this.roots(sessionId),
      state = this.table(roots, "events");
    const reference = this.tree.get(state.ids, eventId),
      after = reference ? this.records.header(reference).order : 0;
    const index = this.tree.get(roots.stateRoot, eventKey(type)) ?? null;
    return this.tree.size(index) - this.tree.rank(index, orderKey(after));
  }
  content(
    sessionId: string,
    table: string,
    id: string,
    field: string,
    cursor = 0,
    expectedRevision?: number,
  ) {
    return readVersionSnapshot(this.objects.db, () =>
      this.contentSnapshot(
        sessionId,
        table,
        id,
        field,
        cursor,
        expectedRevision,
      ),
    );
  }
  private contentSnapshot(
    sessionId: string,
    table: string,
    id: string,
    field: string,
    cursor = 0,
    expectedRevision?: number,
  ): { text: string; next?: number; revision: number } {
    const { head, roots } = this.roots(sessionId),
      ref = this.tree.get(this.table(roots, table).ids, id);
    if (
      (expectedRevision !== undefined && expectedRevision !== head.revision) ||
      (cursor > 0 && expectedRevision === undefined)
    )
      stale();
    if (!ref)
      throw new VersionStoreError(
        "VERSION_RECORD_MISSING",
        "Record is missing.",
      );
    const value = this.records.header(ref).fields[field];
    if (!value)
      throw new VersionStoreError(
        "VERSION_FIELD_MISSING",
        "Content field is missing.",
      );
    if ("inline" in value) {
      if (cursor !== 0 || typeof value.inline !== "string")
        throw new VersionStoreError(
          "VERSION_FIELD",
          "Invalid inline text cursor/field.",
        );
      return { text: value.inline, revision: head.revision };
    }
    if (value.encoding !== "text")
      throw new VersionStoreError("VERSION_FIELD", "Field is not text.");
    return {
      ...this.records.text.page(value.ref, cursor),
      revision: head.revision,
    };
  }
  /** Complete execution history. Page limits bound each read, never the result.
   * UI callers use page() instead; execution must never consume a preview. */
  list(
    sessionId: string,
    table: string,
    scope?: RecordPageOptions["scope"],
  ): Record<string, unknown>[] {
    return readVersionSnapshot(this.objects.db, () => {
      const items: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      do {
        const page = this.pageSnapshot(sessionId, table, {
          limit: PAGE_ROWS,
          scope,
          cursor,
        });
        items.push(...page.items);
        cursor = page.next;
      } while (cursor);
      return items;
    });
  }
  page(sessionId: string, table: string, options: RecordPageOptions = {}) {
    return readVersionSnapshot(this.objects.db, () =>
      this.pageSnapshot(sessionId, table, options),
    );
  }
  private pageSnapshot(
    sessionId: string,
    table: string,
    options: RecordPageOptions = {},
  ): { items: Record<string, unknown>[]; next?: string; revision: number } {
    const { head, roots } = this.roots(sessionId),
      { limit = 64, maxBytes = PAGE_BYTES } = options;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > PAGE_ROWS ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 512 ||
      maxBytes > PAGE_BYTES
    )
      throw new VersionStoreError(
        "VERSION_PAGE_BUDGET",
        "Invalid runtime page limit/budget.",
      );
    const state = this.table(roots, table);
    const orderRoot = options.scope
      ? (this.tree.get(roots.stateRoot, scopeKey(table, options.scope.field, options.scope.value)) ?? null)
      : state.order;
    let after: string | undefined;
    if (options.cursor) {
      if (options.cursor.length > 2048) stale();
      try {
        const cursor = JSON.parse(
          Buffer.from(options.cursor, "base64url").toString(),
        );
        if (
          cursor.version !== orderRoot ||
          cursor.epoch !== head.epoch ||
          cursor.table !== table ||
          Boolean(cursor.reverse) !== Boolean(options.reverse) ||
          JSON.stringify(cursor.scope ?? null) !==
            JSON.stringify(options.scope ?? null) ||
          typeof cursor.after !== "string"
        )
          stale();
        after = cursor.after;
      } catch {
        stale();
      }
    }
    const page = this.tree.page(orderRoot, { after, limit, reverse: options.reverse });
    const items: Record<string, unknown>[] = [];
    let bytes = 512,
      last = after;
    for (const entry of page.entries) {
      let item: Record<string, unknown>;
      try {
        item = options.preview
          ? this.records.preview(entry.value, options.fields)
          : this.records.read(entry.value, maxBytes - bytes, options.fields);
        if (Buffer.byteLength(JSON.stringify(item)) + bytes + 1 > maxBytes)
          throw new VersionStoreError("VERSION_RECORD_BUDGET", "Page preview budget exceeded.");
      } catch (error) {
        if (
          items.length &&
          error instanceof VersionStoreError &&
          error.code === "VERSION_RECORD_BUDGET"
        )
          break;
        throw error;
      }
      items.push(item);
      bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
      last = entry.key;
    }
    const more = page.next !== undefined || items.length < page.entries.length;
    return {
      items,
      ...(more && last !== undefined
        ? {
            next: Buffer.from(
              JSON.stringify({
                version: orderRoot,
                epoch: head.epoch,
                table,
                scope: options.scope,
                reverse: options.reverse,
                after: last,
              }),
            ).toString("base64url"),
          }
        : {}),
      revision: head.revision,
    };
  }
  /** Boundary map is updated only at checkpoint capture, not on every delta or
   * tool write. It is a branch-specific epoch -> audit sequence upper bound. */
  runtimeVisibility(sessionId: string, epoch: number): number | undefined {
    const { head, roots } = this.roots(sessionId);
    if (epoch === head.epoch) return Number.MAX_SAFE_INTEGER;
    const ref = this.tree.get(roots.aggregateRoot, orderKey(epoch));
    return ref ? Number(JSON.parse(this.objects.get(ref, "record").bytes.toString()).through) : undefined;
  }
  runtimeEpochs(sessionId: string): { epoch: number; through: number }[] {
    return readVersionSnapshot(this.objects.db, () => {
      const { head, roots } = this.roots(sessionId);
      const epochs = [{ epoch: head.epoch, through: Number.MAX_SAFE_INTEGER }];
      let after: string | undefined;
      do {
        const page = this.tree.page(roots.aggregateRoot, {
          reverse: true,
          limit: PAGE_ROWS,
          after,
        });
        for (const entry of page.entries) {
          if (Number(entry.key) === head.epoch) continue;
          epochs.push({
            epoch: Number(entry.key),
            through: Number(
              JSON.parse(
                this.objects.get(entry.value, "record").bytes.toString(),
              ).through,
            ),
          });
        }
        after = page.next;
      } while (after);
      return epochs;
    });
  }
  capture(
    sessionId: string,
    kind: "input" | "reply",
    messageId: string,
    stepId: string | null,
    mutationCursor: number,
    omitRunId?: string,
  ): RuntimeCheckpoint {
    this.assertRollbackEnabled(sessionId);
    return atomicVersionWrite(this.objects.db, () => {
      const previous = this.checkpointIndex.findExisting(sessionId, kind, messageId);
      if (previous) return previous;
      let { head, roots } = this.roots(sessionId);
      const mode = this.objects.db.prepare("SELECT boundary_only,runtime_sequence FROM conversation_v3_heads WHERE session_id=?").get(sessionId) as { boundary_only: number; runtime_sequence: number };
      if (mode.boundary_only) {
        const record = this.objects.put("record", Buffer.from(JSON.stringify({ through: mode.runtime_sequence })));
        roots.aggregateRoot = this.tree.update(roots.aggregateRoot, [{ key: orderKey(head.epoch), value: record }]);
        head = this.publish(sessionId, head, roots);
      }
      return this.checkpointIndex.capture({
        sessionId,
        kind,
        messageId,
        stepId,
        mutationCursor,
        omitRunId,
        versionId: head.versionId,
        messageCount: this.table(roots, "messages").count,
      });
    });
  }
  checkpoint(sessionId: string, id: string): RuntimeCheckpoint {
    return readVersionSnapshot(this.objects.db, () =>
      this.checkpointIndex.get(sessionId, id),
    );
  }
  checkpoints(
    sessionId: string,
    options: { after?: string; limit?: number; reverse?: boolean } = {},
  ): { items: RuntimeCheckpoint[]; next?: string } {
    return readVersionSnapshot(this.objects.db, () =>
      this.checkpointIndex.page(sessionId, options),
    );
  }
  preview(sessionId: string, checkpointId: string) {
    return readVersionSnapshot(this.objects.db, () =>
      this.previewSnapshot(sessionId, checkpointId),
    );
  }
  private previewSnapshot(
    sessionId: string,
    checkpointId: string,
  ): { revision: number; removedMessages: number } {
    const cp = this.checkpoint(sessionId, checkpointId);
    return {
      revision: this.head(sessionId).revision,
      removedMessages: Math.max(
        0,
        this.count(sessionId, "messages") - cp.payload.boundary.messageCount,
      ),
    };
  }
  private assertRollbackEnabled(sessionId: string): void {
    if ((this.objects.db.prepare("SELECT rollback_enabled FROM conversation_v3_heads WHERE session_id=?").get(sessionId) as { rollback_enabled: number } | undefined)?.rollback_enabled === 0)
      throw new VersionStoreError("HISTORY_APPEND_ONLY", "Forked conversations do not support checkpoints, rollback or history editing.");
  }
  rollback(
    sessionId: string,
    request: {
      checkpointId: string;
      revision: number;
      requestId: string;
      action?: "rollback" | "edit";
      requestHash?: string;
    },
  ): HeadState {
    this.assertRollbackEnabled(sessionId);
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          checkpointId: request.checkpointId,
          revision: request.revision,
          action: request.action ?? "rollback",
          requestHash: request.requestHash,
        }),
      )
      .digest("hex");
    return atomicVersionWrite(this.objects.db, () => {
      const common = {
        sessionId,
        requestId: request.requestId,
        expectedRevision: request.revision,
        requestHash,
      };
      const previous = this.heads.retrySwitch(common);
      if (previous) return previous;
      const cp = this.checkpoint(sessionId, request.checkpointId);
      if (this.head(sessionId).revision !== request.revision) stale();
      if (cp.kind !== (request.action === "edit" ? "input" : "reply"))
        throw new VersionStoreError(
          "HISTORY_CONFLICT",
          "Reply rollback requires a reply checkpoint boundary.",
        );
      const result = this.heads.switch({
        ...common,
        targetVersionId: cp.payload.versionId,
      });
      this.checkpointIndex.truncate(sessionId, cp, request.action !== "edit");
      return result;
    });
  }
}
