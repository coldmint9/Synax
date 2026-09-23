import { randomUUID } from "node:crypto";
import { VersionObjects } from "../version-store/objects.js";
import { VersionTree } from "../version-store/tree.js";
import { hashBytes } from "../version-store/hash-codec.js";
import { VersionStoreError, assertObjectId } from "../version-store/limits.js";
import { orderKey } from "./batch-write.js";

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
    lookupBefore?: string | null;
    boundary: {
      cursor: number;
      sessionIds: string[];
      messageCount: number;
      omitRunId?: string;
    };
  };
}
interface CheckpointState {
  floor: number | null;
  root: string | null;
  lookup: string | null;
  next: number;
}
function identity(value: string): void {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value) > 256 ||
    !value.isWellFormed()
  )
    throw new VersionStoreError(
      "VERSION_CHECKPOINT_ID",
      "Invalid checkpoint anchor identity.",
    );
}
function anchor(kind: "input" | "reply", messageId: string): string {
  if (kind !== "input" && kind !== "reply")
    throw new VersionStoreError(
      "VERSION_CHECKPOINT_KIND",
      "Invalid checkpoint kind.",
    );
  identity(messageId);
  return JSON.stringify([kind, messageId]);
}
function corrupt(): never {
  throw new VersionStoreError(
    "VERSION_CHECKPOINT_CORRUPT",
    "Checkpoint identity/reference integrity check failed.",
  );
}

/** Caller keeps each read in a short snapshot and every mutation in the same
 * write transaction as head publication. No mutable locator row or full scan. */
export class RuntimeCheckpointIndex {
  private readonly tree: VersionTree;
  private readonly stateQuery;
  private readonly update;
  constructor(private readonly objects: VersionObjects) {
    this.tree = new VersionTree(objects);
    this.stateQuery = objects.db.prepare<[string]>(
      "SELECT CASE WHEN checkpoint_root IS NULL THEN NULL ELSE lower(hex(checkpoint_root)) END AS root,CASE WHEN checkpoint_identity_root IS NULL THEN NULL ELSE lower(hex(checkpoint_identity_root)) END AS lookup,next_checkpoint AS next,file_retention_floor AS floor FROM conversation_v3_heads WHERE session_id=?",
    );
    this.update = objects.db.prepare<
      [Uint8Array | null, Uint8Array | null, number, number | null, string]
    >(
      "UPDATE conversation_v3_heads SET checkpoint_root=?,checkpoint_identity_root=?,next_checkpoint=?,file_retention_floor=? WHERE session_id=?",
    );
  }
  private state(sessionId: string): CheckpointState {
    const state = this.stateQuery.get(sessionId) as CheckpointState | undefined;
    if (!state)
      throw new VersionStoreError(
        "VERSION_SESSION_MISSING",
        "Versioned session is missing.",
      );
    return state;
  }
  private read(ref: string, sessionId: string): RuntimeCheckpoint {
    const stored = this.objects.get(ref, "record");
    try {
      const cp = JSON.parse(stored.bytes.toString()) as RuntimeCheckpoint;
      if (
        cp.sessionId !== sessionId ||
        cp.payload?.version !== 3 ||
        !Number.isSafeInteger(cp.ordinal) ||
        cp.ordinal < 1 ||
        !cp.id.startsWith(`vcp_${cp.ordinal}_`)
      )
        corrupt();
      anchor(cp.kind, cp.messageId);
      assertObjectId(cp.payload.versionId);
      const lookup = cp.payload.lookupBefore;
      if (lookup !== undefined && lookup !== null) assertObjectId(lookup);
      const refs = [
        ...new Set([cp.payload.versionId, ...(lookup ? [lookup] : [])]),
      ].sort();
      if (
        refs.length !== stored.references.length ||
        refs.some((id, i) => id !== stored.references[i])
      )
        corrupt();
      if (
        !Number.isSafeInteger(cp.payload.boundary?.messageCount) ||
        cp.payload.boundary.messageCount < 0
      )
        corrupt();
      return cp;
    } catch {
      corrupt();
    }
  }
  get(sessionId: string, id: string): RuntimeCheckpoint {
    if (typeof id !== "string" || id.length > 160)
      throw new VersionStoreError(
        "CHECKPOINT_NOT_FOUND",
        "Invalid checkpoint identity.",
      );
    const match = /^vcp_(\d+)_([0-9a-f-]{36})$/.exec(id),
      ordinal = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(ordinal) || ordinal < 1)
      throw new VersionStoreError(
        "CHECKPOINT_NOT_FOUND",
        "Invalid checkpoint identity.",
      );
    const ref = this.tree.get(this.state(sessionId).root, orderKey(ordinal));
    if (!ref)
      throw new VersionStoreError(
        "CHECKPOINT_NOT_FOUND",
        "Checkpoint is no longer in the visible history.",
      );
    const cp = this.read(ref, sessionId);
    if (cp.id !== id)
      throw new VersionStoreError(
        "CHECKPOINT_NOT_FOUND",
        "Checkpoint identity does not match.",
      );
    return cp;
  }
  private existing(
    sessionId: string,
    state: CheckpointState,
    kind: "input" | "reply",
    messageId: string,
  ): RuntimeCheckpoint | undefined {
    const ref = this.tree.get(state.lookup, anchor(kind, messageId));
    if (!ref) return undefined;
    const stored = this.objects.get(ref, "record");
    const locator = JSON.parse(stored.bytes.toString()) as {
      kind: string;
      id: string;
    };
    if (locator.kind !== "checkpoint-locator" || stored.references.length)
      corrupt();
    const cp = this.get(sessionId, locator.id);
    if (cp.kind !== kind || cp.messageId !== messageId) corrupt();
    return cp;
  }
  private locator(cp: RuntimeCheckpoint): string {
    return this.objects.put(
      "record",
      Buffer.from(JSON.stringify({ kind: "checkpoint-locator", id: cp.id })),
    );
  }
  capture(input: {
    sessionId: string;
    kind: "input" | "reply";
    messageId: string;
    stepId: string | null;
    mutationCursor: number;
    versionId: string;
    messageCount: number;
    omitRunId?: string;
  }): RuntimeCheckpoint {
    const state = this.state(input.sessionId),
      previous = this.existing(
        input.sessionId,
        state,
        input.kind,
        input.messageId,
      );
    if (previous) return previous;
    if (input.stepId !== null) identity(input.stepId);
    if (input.omitRunId !== undefined) identity(input.omitRunId);
    if (
      !Number.isSafeInteger(input.mutationCursor) ||
      input.mutationCursor < 0 ||
      !Number.isSafeInteger(input.messageCount) ||
      input.messageCount < 0 ||
      !Number.isSafeInteger(state.next + 1)
    )
      throw new VersionStoreError(
        "VERSION_CHECKPOINT_LIMIT",
        "Invalid checkpoint counter.",
      );
    const cp: RuntimeCheckpoint = {
      id: `vcp_${state.next}_${randomUUID()}`,
      sessionId: input.sessionId,
      ordinal: state.next,
      kind: input.kind,
      messageId: input.messageId,
      stepId: input.stepId,
      mutationCursor: input.mutationCursor,
      createdAt: new Date().toISOString(),
      payload: {
        version: 3,
        versionId: input.versionId,
        lookupBefore: state.lookup,
        boundary: {
          cursor: 0,
          sessionIds: [input.sessionId],
          messageCount: input.messageCount,
          ...(input.omitRunId ? { omitRunId: input.omitRunId } : {}),
        },
      },
    };
    const ref = this.objects.put("record", Buffer.from(JSON.stringify(cp)), [
      input.versionId,
      ...(state.lookup ? [state.lookup] : []),
    ]);
    const root = this.tree.update(state.root, [
      { key: orderKey(cp.ordinal), value: ref },
    ]);
    const lookup = this.tree.update(state.lookup, [
      { key: anchor(cp.kind, cp.messageId), value: this.locator(cp) },
    ]);
    this.update.run(
      root ? hashBytes(root) : null,
      lookup ? hashBytes(lookup) : null,
      state.next + 1,
      Math.min(state.floor ?? input.mutationCursor, input.mutationCursor),
      input.sessionId,
    );
    return cp;
  }
  truncate(
    sessionId: string,
    cp: RuntimeCheckpoint,
    includeBoundary = true,
  ): void {
    if (this.get(sessionId, cp.id).payload.versionId !== cp.payload.versionId)
      corrupt();
    const state = this.state(sessionId),
      root = this.tree.prefix(
        state.root,
        orderKey(cp.ordinal - (includeBoundary ? 0 : 1)),
      );
    // Draft pre-lookup checkpoints remain readable. No historical identity tree
    // is fabricated for them; the retained boundary itself is still deduplicated.
    const lookup = includeBoundary
      ? this.tree.update(cp.payload.lookupBefore ?? null, [
          { key: anchor(cp.kind, cp.messageId), value: this.locator(cp) },
        ])
      : (cp.payload.lookupBefore ?? null);
    this.update.run(
      root ? hashBytes(root) : null,
      lookup ? hashBytes(lookup) : null,
      state.next,
      root ? (state.floor ?? 0) : null,
      sessionId,
    );
  }
  page(
    sessionId: string,
    options: { after?: string; limit?: number } = {},
  ): { items: RuntimeCheckpoint[]; next?: string } {
    const page = this.tree.page(this.state(sessionId).root, options);
    return {
      items: page.entries.map((entry) => this.read(entry.value, sessionId)),
      ...(page.next ? { next: page.next } : {}),
    };
  }
}
