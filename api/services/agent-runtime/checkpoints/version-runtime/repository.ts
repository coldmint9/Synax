import { readVersionSnapshot } from "../version-store/read-snapshot.js";
import { createHash, randomUUID } from "node:crypto";
import { VersionObjects } from "../version-store/objects.js";
import { VersionHeads, type HeadState } from "../version-store/heads.js";
import { VersionTree } from "../version-store/tree.js";
import {
  createVersion,
  readVersion,
  type VersionRoots,
} from "../version-store/versions.js";
import { atomicVersionWrite } from "../version-store/transaction.js";
import { hashBytes } from "../version-store/hash-codec.js";
import {
  PAGE_BYTES,
  PAGE_ROWS,
  VersionStoreError,
  assertObjectId,
} from "../version-store/limits.js";
import { RuntimeRecordCodec } from "./record-codec.js";

interface TableState {
  kind: "table";
  version: 1;
  ids: string | null;
  order: string | null;
  next: number;
  count: number;
}
export interface RuntimeCheckpoint {
  id: string;
  sessionId: string;
  ordinal: number;
  kind: "input" | "reply";
  messageId: string;
  stepId: string | null;
  mutationCursor: number;
  createdAt: string;
  payload: {
    version: 3;
    versionId: string;
    boundary: {
      cursor: number;
      sessionIds: string[];
      messageCount: number;
      omitRunId?: string;
    };
  };
}
export interface RecordPageOptions {
  limit?: number;
  maxBytes?: number;
  cursor?: string;
  fields?: readonly string[];
}
const orderKey = (order: number) => order.toString().padStart(16, "0");
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
function eventKey(type: unknown): string {
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
  private readonly checkpointState;
  private readonly updateCheckpoints;
  constructor(readonly objects: VersionObjects) {
    this.records = new RuntimeRecordCodec(objects);
    this.tree = new VersionTree(objects);
    this.heads = new VersionHeads(objects.db, objects);
    this.checkpointState = objects.db.prepare<[string]>(
      "SELECT CASE WHEN checkpoint_root IS NULL THEN NULL ELSE lower(hex(checkpoint_root)) END AS root,next_checkpoint AS next FROM conversation_v3_heads WHERE session_id=?",
    );
    this.updateCheckpoints = objects.db.prepare<
      [Uint8Array | null, number, string]
    >(
      "UPDATE conversation_v3_heads SET checkpoint_root=?,next_checkpoint=? WHERE session_id=?",
    );
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
    return atomicVersionWrite(this.objects.db, () => {
      const { head, roots } = this.roots(sessionId),
        state = this.table(roots, table);
      if (!Number.isSafeInteger(state.next + 1))
        throw new VersionStoreError(
          "VERSION_RECORD_ORDER",
          "Runtime order exhausted.",
        );
      const previous = this.tree.get(state.ids, id),
        old = previous ? this.records.header(previous) : undefined;
      const record = this.records.write(
        table,
        sessionId,
        id,
        state.next,
        fields,
      );
      state.ids = this.tree.update(state.ids, [{ key: id, value: record }]);
      state.order = this.tree.update(state.order, [
        ...(old ? [{ key: orderKey(old.order), value: null }] : []),
        { key: orderKey(state.next), value: record },
      ]);
      state.next++;
      if (!old) state.count++;
      const manifest = this.objects.put(
        "record",
        Buffer.from(JSON.stringify(state)),
        [state.ids!, state.order!],
      );
      roots.stateRoot = this.tree.update(roots.stateRoot, [
        { key: `table/${table}`, value: manifest },
      ]);
      if (table === "events") {
        if (old && previous) {
          const priorType = this.records.read(previous, 1024, ["type"]).type,
            key = eventKey(priorType);
          const index = this.tree.update(
            this.tree.get(roots.stateRoot, key) ?? null,
            [{ key: orderKey(old.order), value: null }],
          );
          roots.stateRoot = this.tree.update(roots.stateRoot, [
            { key, value: index },
          ]);
        }
        const key = eventKey(fields.type),
          index = this.tree.update(
            this.tree.get(roots.stateRoot, key) ?? null,
            [{ key: orderKey(state.next - 1), value: record }],
          );
        roots.stateRoot = this.tree.update(roots.stateRoot, [
          { key, value: index },
        ]);
      }
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
    let after: string | undefined;
    if (options.cursor) {
      if (options.cursor.length > 2048) stale();
      try {
        const cursor = JSON.parse(
          Buffer.from(options.cursor, "base64url").toString(),
        );
        if (
          cursor.version !== head.versionId ||
          cursor.table !== table ||
          typeof cursor.after !== "string"
        )
          stale();
        after = cursor.after;
      } catch {
        stale();
      }
    }
    const state = this.table(roots, table),
      page = this.tree.page(state.order, { after, limit }),
      items: Record<string, unknown>[] = [];
    let bytes = 512,
      last = after;
    for (const entry of page.entries) {
      let item: Record<string, unknown>;
      try {
        item = this.records.read(entry.value, maxBytes - bytes, options.fields);
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
              JSON.stringify({ version: head.versionId, table, after: last }),
            ).toString("base64url"),
          }
        : {}),
      revision: head.revision,
    };
  }
  private checkpointIndex(sessionId: string): {
    root: string | null;
    next: number;
  } {
    const state = this.checkpointState.get(sessionId) as
      | { root: string | null; next: number }
      | undefined;
    if (!state)
      throw new VersionStoreError(
        "VERSION_SESSION_MISSING",
        "Versioned session is missing.",
      );
    return state;
  }
  capture(
    sessionId: string,
    kind: "input" | "reply",
    messageId: string,
    stepId: string | null,
    mutationCursor: number,
    omitRunId?: string,
  ): RuntimeCheckpoint {
    return atomicVersionWrite(this.objects.db, () => {
      const { head, roots } = this.roots(sessionId),
        index = this.checkpointIndex(sessionId);
      if (!Number.isSafeInteger(index.next + 1))
        throw new VersionStoreError(
          "VERSION_CHECKPOINT_LIMIT",
          "Checkpoint order exhausted.",
        );
      const cp: RuntimeCheckpoint = {
        id: `vcp_${index.next}_${randomUUID()}`,
        sessionId,
        ordinal: index.next,
        kind,
        messageId,
        stepId,
        mutationCursor,
        createdAt: new Date().toISOString(),
        payload: {
          version: 3,
          versionId: head.versionId,
          boundary: {
            cursor: 0,
            sessionIds: [sessionId],
            messageCount: this.table(roots, "messages").count,
            ...(omitRunId ? { omitRunId } : {}),
          },
        },
      };
      const record = this.objects.put(
        "record",
        Buffer.from(JSON.stringify(cp)),
        [head.versionId],
      );
      const root = this.tree.update(index.root, [
        { key: orderKey(index.next), value: record },
      ]);
      this.updateCheckpoints.run(
        root ? hashBytes(root) : null,
        index.next + 1,
        sessionId,
      );
      return cp;
    });
  }
  private checkpointRecord(ref: string, sessionId: string): RuntimeCheckpoint {
    const object = this.objects.get(ref, "record"),
      cp = JSON.parse(object.bytes.toString()) as RuntimeCheckpoint;
    if (
      cp.sessionId !== sessionId ||
      cp.payload?.version !== 3 ||
      !Number.isSafeInteger(cp.ordinal) ||
      cp.ordinal < 1 ||
      object.references.length !== 1 ||
      object.references[0] !== cp.payload.versionId
    )
      throw new VersionStoreError(
        "VERSION_CHECKPOINT_CORRUPT",
        "Checkpoint integrity check failed.",
      );
    return cp;
  }
  checkpoint(sessionId: string, id: string) {
    return readVersionSnapshot(this.objects.db, () =>
      this.checkpointSnapshot(sessionId, id),
    );
  }
  private checkpointSnapshot(sessionId: string, id: string): RuntimeCheckpoint {
    const match = /^vcp_(\d+)_([0-9a-f-]{36})$/.exec(id),
      ordinal = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(ordinal) || ordinal < 1)
      throw new VersionStoreError(
        "CHECKPOINT_NOT_FOUND",
        "Invalid checkpoint identity.",
      );
    const ref = this.tree.get(
      this.checkpointIndex(sessionId).root,
      orderKey(ordinal),
    );
    if (!ref)
      throw new VersionStoreError(
        "CHECKPOINT_NOT_FOUND",
        "Checkpoint is no longer in the visible history.",
      );
    const cp = this.checkpointRecord(ref, sessionId);
    if (cp.id !== id)
      throw new VersionStoreError(
        "CHECKPOINT_NOT_FOUND",
        "Checkpoint identity does not match.",
      );
    return cp;
  }
  checkpoints(
    sessionId: string,
    options: { after?: string; limit?: number } = {},
  ) {
    return readVersionSnapshot(this.objects.db, () =>
      this.checkpointsSnapshot(sessionId, options),
    );
  }
  private checkpointsSnapshot(
    sessionId: string,
    options: { after?: string; limit?: number } = {},
  ): { items: RuntimeCheckpoint[]; next?: string } {
    const page = this.tree.page(this.checkpointIndex(sessionId).root, options);
    return {
      items: page.entries.map((entry) =>
        this.checkpointRecord(entry.value, sessionId),
      ),
      ...(page.next ? { next: page.next } : {}),
    };
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
  rollback(
    sessionId: string,
    request: { checkpointId: string; revision: number; requestId: string },
  ): HeadState {
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          checkpointId: request.checkpointId,
          revision: request.revision,
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
      const cp = this.checkpoint(sessionId, request.checkpointId),
        index = this.checkpointIndex(sessionId);
      if (this.head(sessionId).revision !== request.revision) stale();
      if (cp.kind !== "reply")
        throw new VersionStoreError(
          "HISTORY_CONFLICT",
          "Reply rollback requires a reply checkpoint boundary.",
        );
      const root = this.tree.prefix(index.root, orderKey(cp.ordinal));
      const result = this.heads.switch({
        ...common,
        targetVersionId: cp.payload.versionId,
      });
      this.updateCheckpoints.run(
        root ? hashBytes(root) : null,
        index.next,
        sessionId,
      );
      return result;
    });
  }
}
