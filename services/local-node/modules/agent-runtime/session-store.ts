import { createHash } from "node:crypto";
import type { ContextCompactionState } from "./context-compaction-state.js";
import type { ContextComposition } from "./context-composition.js";
import type {
  AgentContextBundle,
  AgentRun,
  AgentRunPart,
  AgentRunStep,
  AgentRuntimeMessage,
  AgentSession,
  CompactionRecord,
  EvidenceArtifact,
  PermissionDecision,
  RuntimeEvent,
  ThinkingSummary,
  ToolCallRecord,
} from "./contracts.js";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";
import { AgentNotFoundError } from "./runtime-errors.js";
import { nowIso } from "./runtime-ids.js";
import { sessionLiveBus } from "./session-live-bus.js";
import { hydrateHistoryValues, readHistoryList, sessionPages } from './sidecar/history-pages.js';
import { projectSessionState } from "./session-projection.js";
import {
  decode,
  patchRuntime,
  persistEntity,
  runtimeClient,
  seedSession,
} from "./sidecar/runtime-repository.js";
import {
  projectSessionUsage,
  type SessionUsageProjection,
} from "./usage-projection.js";
import {
  readSessionAnalytics,
  withCompletedRunAnalytics,
  withStepAnalytics,
  withToolCallAnalytics,
  type SessionAnalytics,
} from "./analytics-projection.js";
import type { WorkRecord } from "./work-store.js";

type Entity = { id: string; sessionId?: string | null };
export interface SessionArchiveBatch {
  archiveBatchId: string;
  rootSessionId: string;
  title: string | null;
  prompt: string;
  projectId: string;
  archivedAt: string;
  sessionCount: number;
}
export interface SessionArchiveResult {
  archiveBatchId: string;
  archivedAt: string;
  archivedSessionIds: string[];
}
const collections = {
  message: "list_messages",
  run: "list_runs",
  step: "list_steps",
  part: "list_parts",
  tool_call: "list_tool_calls",
  event: "list_events",
  artifact: "list_artifacts",
  context: "list_contexts",
  work: "list_work",
  plan: "list_plans",
  aux_usage: "list_aux_usage",
  thinking: "list_thinking",
  compaction: "list_compactions",
  permission: "list_permissions",
  interaction: "list_interactions",
} as const;
const copy = <T,>(value: T): T => structuredClone(value);

/**
 * Upper bound for sessions whose full execution working set stays resident in
 * this process. Opening many long conversations used to keep every transcript
 * in Node for the lifetime of the app; history reads go through the
 * authoritative Rust index, so an idle terminal session can be dropped and
 * re-hydrated on its next send. Active or writing sessions are never evicted.
 */
const WORKING_SET_LIMIT = Math.max(
  1,
  Number(process.env.SYNAX_RUNTIME_WORKING_SET ?? 12),
);
const EVICTABLE_SESSION_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** A failed page must not release the session's loading slot while sibling
 * reads are still opening files or publishing caches. */
async function readAll<T extends readonly unknown[]>(reads: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(reads);
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** Execution working set. Rust is the sole durable repository. Callers load before
 * executing and await flush before acknowledging commands or yielding worker IPC. */
export class AgentRuntimeStore {
  private sessions = new Map<string, AgentSession>();
  private entities = new Map<string, Map<string, Entity>>();
  private tails = new Map<string, Promise<void>>();
  private failures = new Map<string, unknown>();
  private loaded = new Set<string>();
  private historyCursors = new Map<string, { revision: number; generation: number }>();
  private executionBoundaries = new Map<string, number>();
  private messageSequences = new Map<string, number>();
  /** Least-recently-hydrated first; drives working-set eviction. */
  private loadedAt = new Map<string, number>();
  private loading = new Map<string, Promise<void>>();
  private listing?: Promise<void>;
  private staged?: { writes: Array<() => void>; undo: Array<() => void> };
  /**
   * One session panel open fans out into ~10 read requests, and each of them
   * used to re-read the same authoritative summary. A short lease collapses the
   * burst into one snapshot; mutations invalidate it immediately.
   */
  private readonly summaryLeases = new Map<
    string,
    { at: number; task: Promise<void> }
  >();
  private static readonly SUMMARY_LEASE_MS = 250;
  transaction<T>(action: () => T): T {
    const outer = !this.staged;
    const batch = (this.staged ??= { writes: [], undo: [] });
    const writes = batch.writes.length,
      undo = batch.undo.length;
    try {
      const result = action();
      if (outer) {
        this.staged = undefined;
        for (const commit of batch.writes) commit();
      }
      return result;
    } catch (error) {
      for (const revert of batch.undo.splice(undo).reverse()) revert();
      batch.writes.length = writes;
      if (outer) this.staged = undefined;
      throw error;
    }
  }
  private set<K, V>(map: Map<K, V>, key: K, value: V): void {
    const existed = map.has(key),
      before = map.get(key);
    this.staged?.undo.push(() => {
      if (existed) map.set(key, before!);
      else map.delete(key);
    });
    map.set(key, value);
  }

  private queue(sessionId: string, action: () => Promise<void>): void {
    // The summary is about to change; the next reader must not reuse the lease.
    this.summaryLeases.delete(sessionId);
    if (this.staged) {
      this.staged.writes.push(() => this.queue(sessionId, action));
      return;
    }
    const write = (this.tails.get(sessionId) ?? Promise.resolve()).then(
      async () => {
        await action();
      },
    );
    const settled = write.catch((error) => {
      this.failures.set(sessionId, error);
    });
    this.tails.set(sessionId, settled);
  }
  async flushSession(sessionId: string): Promise<void> {
    let tail: Promise<void> | undefined;
    do {
      tail = this.tails.get(sessionId);
      await tail;
    } while (tail !== this.tails.get(sessionId));
    const failure = this.failures.get(sessionId);
    this.tails.delete(sessionId);
    if (failure) {
      this.failures.delete(sessionId);
      throw failure;
    }
  }
  async flush(): Promise<void> {
    await Promise.all(
      [...this.tails.keys()].map((id) => this.flushSession(id)),
    );
  }
  enqueueAssetBinding(sessionId: string, assetId: string): void {
    this.queue(sessionId, async () => {
      await runtimeClient().historyCommandGlobal({ sessionId: "assets", requestId: `asset-bind:${sessionId}:${assetId}`,
        operation: "asset_bind", payload: { sessionId, assetId } });
    });
  }
  enqueueControl(sessionId: string, requestId: string, operation: string, payload: unknown): void {
    const input = copy(payload);
    this.queue(sessionId, async () => {
      const result = await patchRuntime(sessionId, operation, input, requestId);
      if (result.entity) {
        const kind = operation.startsWith('permission_') ? 'permission' : 'interaction';
        const record = result.entity as Entity;
        this.collection(kind).set(record.id, copy(record));
        await runtimeClient().historyCommand({ sessionId, requestId: `control-history:${createHash('sha256').update(requestId).digest('hex')}`,
          operation: 'reconcile_stream', payload: {} });
      }
    });
  }
  async hydrateSessions(signal?: AbortSignal): Promise<void> {
    if (this.listing) return this.listing;
    const previous = new Map(this.sessions);
    this.listing = (async () => {
      for await (const items of sessionPages<AgentSession>(runtimeClient(), signal)) {
        for (const session of items) {
          if (!session || typeof session.id !== 'string') continue;
          // Background list pages must not overwrite a newly admitted run or
          // local edits made while the index was still replaying old sessions.
          if (this.sessions.get(session.id) === previous.get(session.id)) this.sessions.set(session.id, copy(session));
        }
      }
    })().finally(() => { this.listing = undefined; });
    return this.listing;
  }
  async hydrateSession(
    sessionId: string,
    refresh = false,
    options: { include?: readonly (keyof typeof collections)[]; execution?: boolean } = {},
  ): Promise<void> {
    this.summaryLeases.delete(sessionId);
    const kinds = options.include?.length
      ? [...new Set(options.include)].filter(kind => kind in collections)
      : null;
    // A full working set already covers any subset request; only an explicit
    // refresh reads the collections again.
    if (this.loaded.has(sessionId) && !refresh && (options.execution || !this.executionBoundaries.has(sessionId))) {
      await this.flushSession(sessionId);
      return;
    }
    const existing = this.loading.get(sessionId);
    if (existing) return existing;
    const load = (async () => {
      await this.flushSession(sessionId);
      const head = decode<{ revision: number; generation: number; messageSequence?: number; checkpoint?: { throughRevision: number } }>(await runtimeClient().historyCommandGlobal({
        sessionId, requestId: `working-head:${sessionId}:${Date.now()}`, operation: "context_current", payload: {},
      }));
      const boundary = options.execution ? head.checkpoint?.throughRevision : undefined;
      const previousCursor = this.historyCursors.get(sessionId);
      if (!kinds && this.loaded.has(sessionId) && this.executionBoundaries.get(sessionId) === boundary && previousCursor?.generation === head.generation && previousCursor.revision <= head.revision) {
        await this.refreshSessionChanges(sessionId, previousCursor.revision, head);
        this.touchLoaded(sessionId);
        return;
      }
      await runtimeClient().historyCommand({ sessionId, requestId: `hydrate-history:${sessionId}:${Date.now()}`,
        operation: 'reconcile_stream', payload: {} });
      const previousSession = this.sessions.get(sessionId);
      const loadingKinds = kinds ?? (Object.keys(collections) as (keyof typeof collections)[]);
      const previous = new Map(loadingKinds.map(kind => [kind,
        new Map([...this.collection(kind)].filter(([, record]) => record.sessionId === sessionId)),
      ]));
      const [snapshotBytes, entries, control] = await readAll([
        runtimeClient().uiSnapshot(sessionId),
        readAll(loadingKinds.map(async kind => [kind, boundary === undefined
          ? await readHistoryList<Entity>(runtimeClient(), sessionId, collections[kind])
          : await this.readExecutionEntities(sessionId, kind, boundary, head)] as const)),
        patchRuntime(sessionId, "read", {}),
      ]);
      const snapshot = decode<{ session: AgentSession; run: AgentRun | null }>(snapshotBytes);
      const incoming = new Map(entries.map(([kind, records]) => [kind, new Map(records.map(record => [record.id, record]))]));
      if (boundary !== undefined) {
        const refs: Array<{ kind: string; id: string }> = [];
        if (snapshot.session.contextSnapshotId) refs.push({ kind: "context", id: snapshot.session.contextSnapshotId });
        const activeWorkId = snapshot.session.sessionMetadata?.activeWorkId;
        if (typeof activeWorkId === "string") refs.push({ kind: "work", id: activeWorkId });
        const plan = snapshot.session.sessionMetadata?.plan as { id?: string } | undefined;
        if (plan?.id) refs.push({ kind: "plan", id: plan.id });
        await this.readExecutionRefs(sessionId, refs, incoming, true);
        const work = typeof activeWorkId === "string" ? incoming.get("work")?.get(activeWorkId) as WorkRecord | undefined : undefined;
        const evidence = new Map<string, { kind: string; id: string }>();
        for (const entry of work?.evidence ?? []) {
          for (const id of entry.toolCallIds ?? []) evidence.set(`tool:${id}`, { kind: "tool", id });
          for (const id of entry.artifactIds ?? []) evidence.set(`artifact:${id}`, { kind: "artifact", id });
        }
        for (const record of work?.verifications ?? []) evidence.set(`tool:${record.toolCallId}`, { kind: "tool", id: record.toolCallId });
        const all = [...evidence.values()];
        for (let offset = 0; offset < all.length; offset += 128) await this.readExecutionRefs(sessionId, all.slice(offset, offset + 128), incoming);
      }
      if (snapshot.run) incoming.get("run")?.set(snapshot.run.id, snapshot.run);
      for (const permission of control.permissions as PermissionDecision[]) incoming.get("permission")?.set(permission.id, permission);
      for (const interaction of control.interactions as Entity[]) incoming.get("interaction")?.set(interaction.id, interaction);
      await (await import("./media-assets.js")).hydrateSessionAssets(sessionId);
      // Publish after every read succeeds. Readers must never see an empty
      // collection between deletion and an awaited history page. A local
      // update made during the read keeps its identity and pending WAL write.
      if (this.sessions.get(sessionId) === previousSession) this.sessions.set(sessionId, snapshot.session);
      for (const [kind, records] of incoming) {
        const map = this.collection(kind);
        const before = previous.get(kind)!;
        for (const [id, old] of before) {
          if (!map.has(id)) records.delete(id);
          else if (map.get(id) !== old) records.set(id, map.get(id)!);
        }
        for (const [id, value] of map) {
          if (value.sessionId === sessionId && !before.has(id)) records.set(id, value);
        }
        for (const [id, value] of map) if (value.sessionId === sessionId) map.delete(id);
        for (const [id, value] of records) map.set(id, value);
        if (kind === "message") {
          let sequence = head.messageSequence ?? 0;
          for (const value of records.values()) sequence = Math.max(sequence, Number((value as { sequence?: number }).sequence) || 0);
          this.messageSequences.set(sessionId, sequence);
        }
      }
      if (!kinds) {
        this.historyCursors.set(sessionId, head);
        if (boundary === undefined) this.executionBoundaries.delete(sessionId); else this.executionBoundaries.set(sessionId, boundary);
        this.loaded.add(sessionId);
        this.touchLoaded(sessionId);
        this.evictWorkingSet(sessionId);
      }
    })();
    this.loading.set(sessionId, load);
    try {
      await load;
    } finally {
      this.loading.delete(sessionId);
    }
  }
  private touchLoaded(sessionId: string): void {
    this.loadedAt.delete(sessionId);
    this.loadedAt.set(sessionId, Date.now());
  }
  async hydrateExecutionSession(sessionId: string, refresh = false): Promise<void> {
    return this.hydrateSession(sessionId, refresh, { execution: true });
  }
  private async readExecutionEntities(sessionId: string, kind: string, fromRevision: number, head: { revision: number; generation: number }): Promise<Entity[]> {
    const collection = kind === "tool_call" ? "tool" : kind === "aux_usage" ? "aux" : kind;
    let cursor: unknown = null;
    const items: Entity[] = [];
    do {
      const page = decode<{ items: Entity[]; cursor: unknown }>(await runtimeClient().historyCommandGlobal({
        sessionId, requestId: `working-tail:${sessionId}:${kind}:${Date.now()}`, operation: "execution_entities",
        payload: { collection, fromRevision, throughRevision: head.revision, generation: head.generation, cursor },
      }));
      items.push(...await hydrateHistoryValues(runtimeClient(), sessionId, page.items, true));
      if (page.cursor && JSON.stringify(page.cursor) === JSON.stringify(cursor)) throw new Error("Execution cursor did not advance.");
      cursor = page.cursor;
    } while (cursor);
    return items;
  }
  private async readExecutionRefs(sessionId: string, refs: Array<{ kind: string; id: string }>, incoming: Map<string, Map<string, Entity>>, includeHints = false): Promise<void> {
    const page = decode<{ items: Array<{ kind: string; value: Entity }> }>(await runtimeClient().historyCommandGlobal({
      sessionId, requestId: `working-refs:${sessionId}:${Date.now()}`, operation: "execution_refs", payload: { refs, includeHints },
    }));
    const values = await hydrateHistoryValues(runtimeClient(), sessionId, page.items.map(item => item.value), true);
    page.items.forEach((item, index) => {
      const kind = item.kind === "tool" ? "tool_call" : item.kind;
      incoming.get(kind)?.set(values[index].id, values[index]);
    });
  }
  private async refreshSessionChanges(sessionId: string, afterRevision: number, head: { revision: number; generation: number }): Promise<void> {
    let cursor: unknown = null;
    const updates = new Map<string, { kind: string; id: string; deleted: boolean; value: Entity; before?: Entity }>();
    do {
      const page = decode<{ items: Array<{ kind: string; id: string; deleted: boolean; value: Entity }>; cursor: unknown }>(
        await runtimeClient().historyCommandGlobal({ sessionId, requestId: `working-delta:${sessionId}:${Date.now()}`, operation: "history_updates",
          payload: { afterRevision, throughRevision: head.revision, generation: head.generation, cursor } }));
      const before = page.items.map(item => {
        const kind = item.kind === "tool" ? "tool_call" : item.kind === "aux" ? "aux_usage" : item.kind;
        return this.collection(kind).get(item.id);
      });
      const values = await hydrateHistoryValues(runtimeClient(), sessionId, page.items.map(item => item.value), true);
      page.items.forEach((item, index) => {
        const kind = item.kind === "tool" ? "tool_call" : item.kind === "aux" ? "aux_usage" : item.kind;
        const key = `${kind}\0${item.id}`;
        updates.set(key, { ...item, kind, value: values[index], before: updates.get(key)?.before ?? before[index] });
      });
      if (page.cursor && JSON.stringify(page.cursor) === JSON.stringify(cursor)) throw new Error("History updates cursor did not advance.");
      cursor = page.cursor;
    } while (cursor);
    const previousSession = this.sessions.get(sessionId);
    const [snapshotBytes, control] = await readAll([runtimeClient().uiSnapshot(sessionId), patchRuntime(sessionId, "read", {})]);
    const snapshot = decode<{ session: AgentSession; run: AgentRun | null }>(snapshotBytes);
    for (const item of updates.values()) {
      const collection = this.collection(item.kind);
      if (collection.get(item.id) !== item.before) continue;
      if (item.deleted) collection.delete(item.id); else {
        collection.set(item.id, item.value);
        if (item.kind === "message") this.messageSequences.set(sessionId,
          Math.max(this.messageSequences.get(sessionId) ?? 0, Number((item.value as { sequence?: number }).sequence) || 0));
      }
    }
    if (this.sessions.get(sessionId) === previousSession) this.sessions.set(sessionId, snapshot.session);
    if (snapshot.run) this.collection("run").set(snapshot.run.id, snapshot.run);
    for (const permission of control.permissions as PermissionDecision[]) this.collection("permission").set(permission.id, permission);
    for (const interaction of control.interactions as Entity[]) this.collection("interaction").set(interaction.id, interaction);
    this.historyCursors.set(sessionId, head);
  }
  /**
   * Drop the least recently hydrated idle session once the working set exceeds
   * its budget. Every execution path hydrates before reading, so a dropped
   * session is reloaded on its next send; history reads never use this cache.
   */
  private evictWorkingSet(keep: string): void {
    while (this.loaded.size > WORKING_SET_LIMIT) {
      const candidate = [...this.loaded]
        .filter(id => id !== keep)
        .filter(id => !this.loading.has(id) && !this.tails.has(id) && !this.failures.has(id))
        .filter(id => {
          const status = this.sessions.get(id)?.status;
          return !!status && EVICTABLE_SESSION_STATUSES.has(status);
        })
        .sort((a, b) => (this.loadedAt.get(a) ?? 0) - (this.loadedAt.get(b) ?? 0))[0];
      if (!candidate) return;
      this.dropWorkingSet(candidate);
    }
  }
  private dropWorkingSet(sessionId: string): void {
    for (const records of this.entities.values())
      for (const [recordId, record] of records)
        if (record.sessionId === sessionId) records.delete(recordId);
    this.loaded.delete(sessionId);
    this.historyCursors.delete(sessionId);
    this.executionBoundaries.delete(sessionId);
    this.messageSequences.delete(sessionId);
    this.loadedAt.delete(sessionId);
    this.summaryLeases.delete(sessionId);
  }
  /** Refresh the small projection at request boundaries without loading history. */
  async hydrateSessionSummary(sessionId: string, force = false): Promise<void> {
    const lease = this.summaryLeases.get(sessionId);
    if (!force && lease && Date.now() - lease.at < AgentRuntimeStore.SUMMARY_LEASE_MS)
      return lease.task;
    const task = this.readSessionSummary(sessionId);
    this.summaryLeases.set(sessionId, { at: Date.now(), task });
    if (this.summaryLeases.size > 128)
      this.summaryLeases.delete(this.summaryLeases.keys().next().value!);
    try {
      await task;
    } catch (error) {
      if (this.summaryLeases.get(sessionId)?.task === task)
        this.summaryLeases.delete(sessionId);
      throw error;
    }
  }
  private async readSessionSummary(sessionId: string): Promise<void> {
    await this.flushSession(sessionId);
    const previous = this.sessions.get(sessionId);
    const snapshot = decode<{ session: AgentSession }>(await runtimeClient().uiSnapshot(sessionId));
    if (this.sessions.get(sessionId) === previous) this.sessions.set(sessionId, snapshot.session);
  }
  private collection(kind: string): Map<string, Entity> {
    let map = this.entities.get(kind);
    if (!map) {
      map = new Map();
      this.entities.set(kind, map);
    }
    return map;
  }
  getRecord<T extends Entity>(kind: string, id: string): T | undefined {
    const value = this.collection(kind).get(id);
    return value ? copy(value as T) : undefined;
  }
  private requireRecord<T extends Entity>(kind: string, id: string): T {
    const record = this.getRecord<T>(kind, id);
    if (!record) throw new AgentNotFoundError(id);
    return record;
  }
  listRecords<T extends Entity>(kind: string, sessionId: string): T[] {
    return [...this.collection(kind).values()]
      .filter((value) => value.sessionId === sessionId)
      .map((value) => copy(value as T));
  }
  saveRecord<T extends Entity>(kind: string, value: T): T {
    const snapshot = copy(value);
    this.set(this.collection(kind), value.id, snapshot);
    const scope = value.sessionId ?? `context:${value.id}`;
    this.summaryLeases.delete(scope);
    this.queue(scope, () =>
      persistEntity(scope, `runtime.${kind}`, {
        ...snapshot,
        sessionId: scope,
      }),
    );
    return copy(value);
  }
  createSession(session: AgentSession): AgentSession {
    this.set(this.sessions, session.id, copy(session));
    const alreadyLoaded = this.loaded.has(session.id);
    this.staged?.undo.push(() => {
      if (!alreadyLoaded) this.loaded.delete(session.id);
    });
    this.loaded.add(session.id);
    this.touchLoaded(session.id);
    const snapshot = copy(session);
    this.queue(session.id, () => seedSession(snapshot));
    if (session.parentSessionId) {
      const parent = this.getSession(session.parentSessionId);
      this.updateSession(parent.id, {
        childSessionIds: [...new Set([...parent.childSessionIds, session.id])],
        updatedAt: session.createdAt,
      });
    }
    return copy(session);
  }
  getSession(id: string): AgentSession {
    const session = this.tryGetSession(id);
    if (!session) throw new AgentNotFoundError(id);
    return session;
  }
  tryGetSession(id: string): AgentSession | undefined {
    const value = this.sessions.get(id);
    return value &&
      !value.sessionMetadata?.archivedAt &&
      !value.sessionMetadata?.deletedAt
      ? copy(value)
      : undefined;
  }
  updateSession(id: string, patch: Partial<AgentSession>): AgentSession {
    const current = this.sessions.get(id);
    if (!current) throw new AgentNotFoundError(id);
    const next = { ...current, ...copy(patch) };
    this.set(this.sessions, id, next);
    const storedPatch = copy(patch);
    this.queue(id, async () => {
      await patchRuntime(id, "session_patch", { patch: storedPatch });
    });
    const notify = () =>
      emitRuntimeBusEvent({ type: "session_changed", sessionId: id, patch });
    if (this.staged) this.staged.writes.push(notify);
    else notify();
    return copy(next);
  }
  updateSessionMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): AgentSession {
    const current = this.getSession(id);
    const next = { ...current, sessionMetadata: { ...current.sessionMetadata, ...copy(patch) } };
    this.set(this.sessions, id, next);
    const storedPatch = copy(patch);
    // Rust merges metadata keys. Sending a full cached metadata object from a
    // worker could overwrite a concurrent control/mailbox update from the API.
    this.queue(id, () => patchRuntime(id, "session_patch", { patch: { sessionMetadata: storedPatch } }).then(() => undefined));
    const notify = () => emitRuntimeBusEvent({ type: "session_changed", sessionId: id,
      patch: { sessionMetadata: storedPatch } });
    if (this.staged) this.staged.writes.push(notify); else notify();
    return copy(next);
  }
  /** Incremental runtime stats persisted on the session projection.
   * Step/run/tool hooks fold one record at a time; readers never rescan. */
  private sessionAnalytics(sessionId: string): SessionAnalytics | null {
    const session = this.sessions.get(sessionId);
    return session
      ? readSessionAnalytics(session.sessionMetadata?.runtimeAnalytics)
      : null;
  }
  private writeSessionAnalytics(
    sessionId: string,
    next: SessionAnalytics | null,
  ): void {
    if (!next) return;
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.sessionMetadata?.archivedAt ||
      session.sessionMetadata?.deletedAt
    )
      return;
    const current = readSessionAnalytics(
      session.sessionMetadata?.runtimeAnalytics,
    );
    if (current && JSON.stringify(current) === JSON.stringify(next)) return;
    this.updateSessionMetadata(sessionId, { runtimeAnalytics: next });
  }
  private recordStepAnalytics(step: AgentRunStep): void {
    const next = withStepAnalytics(
      this.sessionAnalytics(step.sessionId),
      step,
    );
    if (next) this.writeSessionAnalytics(step.sessionId, next);
  }
  private recordRunAnalytics(run: AgentRun): void {
    const next = withCompletedRunAnalytics(
      this.sessionAnalytics(run.sessionId),
      run,
      this.listRunSteps(run.id).length,
    );
    if (next) this.writeSessionAnalytics(run.sessionId, next);
  }
  private recordToolCallAnalytics(call: ToolCallRecord): void {
    const current = this.sessionAnalytics(call.sessionId);
    if (!current && !this.sessions.has(call.sessionId)) return;
    this.writeSessionAnalytics(
      call.sessionId,
      withToolCallAnalytics(current, call.toolId),
    );
  }
  listSessionBadges(projectIds: string[]) {
    return this.listSessions({ limit: Infinity })
      .filter((s) => projectIds.includes(s.projectId))
      .map(({ id, projectId, status, updatedAt }) => ({
        id,
        projectId,
        status,
        updatedAt,
      }));
  }
  listSessions(
    filter: {
      projectId?: string;
      nodeId?: string;
      status?: string;
      limit?: number;
      includePreparing?: boolean;
    } = {},
  ): AgentSession[] {
    return [...this.sessions.values()]
      .filter(
        (s) => !s.sessionMetadata?.archivedAt && !s.sessionMetadata?.deletedAt && (filter.includePreparing || !s.sessionMetadata?.forkPreparing),
      )
      .filter(
        (s) =>
          (!filter.projectId || s.projectId === filter.projectId) &&
          (!filter.nodeId || s.nodeId === filter.nodeId) &&
          (!filter.status || s.status === filter.status),
      )
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
      )
      .slice(0, filter.limit ?? 50)
      .map(copy);
  }
  listSessionsPage(
    filter: { projectId?: string; nodeId?: string; status?: string } = {},
    page = { limit: 50, offset: 0 },
  ) {
    const all = this.listSessions({
      ...filter,
      status: undefined,
      limit: Infinity,
    })
      .map(projectSessionState)
      .filter((s) => !filter.status || s.status === filter.status)
      .sort(
        (a, b) =>
          Number(Boolean(b.sessionMetadata?.pinned)) -
            Number(Boolean(a.sessionMetadata?.pinned)) ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          b.id.localeCompare(a.id),
      );
    const countByStatus: Record<string, number> = {};
    for (const s of all)
      countByStatus[s.status] = (countByStatus[s.status] ?? 0) + 1;
    return {
      items: all.slice(page.offset, page.offset + Math.max(0, page.limit)),
      totalCount: all.length,
      countByStatus,
    };
  }
  listSessionTree(id: string): AgentSession[] {
    const root = this.getSession(id),
      result: AgentSession[] = [],
      seen = new Set<string>();
    const visit = (session: AgentSession) => {
      if (seen.has(session.id)) return;
      seen.add(session.id);
      result.push(session);
      for (const s of this.listSessions({ limit: Infinity }))
        if (
          s.parentSessionId === session.id ||
          session.childSessionIds.includes(s.id)
        )
          visit(s);
    };
    visit(root);
    return result;
  }
  archiveSessionTree(id: string): SessionArchiveResult {
    const items = this.listSessionTree(id),
      archivedAt = nowIso();
    const archivedIds = new Set(items.map((session) => session.id));
    // Keep parent projections usable immediately after archiving a subtree.
    // Archived descendants remain addressable through their archive batch, but
    // they must no longer appear as active children of a live parent.
    for (const session of this.listSessions({ limit: Infinity })) {
      if (archivedIds.has(session.id)) continue;
      const childSessionIds = session.childSessionIds.filter(
        (childId) => !archivedIds.has(childId),
      );
      if (childSessionIds.length !== session.childSessionIds.length)
        this.updateSession(session.id, { childSessionIds });
    }
    for (const s of items)
      this.updateSessionMetadata(s.id, { archivedAt, archiveBatchId: id });
    for (const s of items)
      emitRuntimeBusEvent({ type: "session_archived", sessionId: s.id });
    return {
      archiveBatchId: id,
      archivedAt,
      archivedSessionIds: items.map((s) => s.id),
    };
  }
  listArchivedBatches(
    filter: { projectId?: string; query?: string } = {},
    page = { limit: 50, offset: 0 },
  ): { items: SessionArchiveBatch[]; totalCount: number } {
    const all = [...this.sessions.values()]
      .filter(
        (s) =>
          s.sessionMetadata?.archiveBatchId === s.id &&
          s.sessionMetadata.archivedAt &&
          !s.sessionMetadata.deletedAt,
      )
      .filter(
        (s) =>
          (!filter.projectId || s.projectId === filter.projectId) &&
          (!filter.query ||
            `${s.title} ${s.prompt}`
              .toLowerCase()
              .includes(filter.query.toLowerCase())),
      )
      .map((s) => ({
        archiveBatchId: s.id,
        rootSessionId: s.id,
        title: s.title,
        prompt: s.prompt,
        projectId: s.projectId,
        archivedAt: String(s.sessionMetadata!.archivedAt),
        sessionCount: [...this.sessions.values()].filter(
          (x) => x.sessionMetadata?.archiveBatchId === s.id,
        ).length,
      }))
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
    return {
      items: all.slice(page.offset, page.offset + page.limit),
      totalCount: all.length,
    };
  }
  restoreArchivedBatch(id: string): string[] {
    const restored = [...this.sessions.values()].filter(
      (s) =>
        s.sessionMetadata?.archiveBatchId === id &&
        !s.sessionMetadata?.deletedAt,
    );
    if (!restored.some((s) => s.id === id)) throw new AgentNotFoundError(id);
    for (const s of restored)
      this.updateSession(s.id, {
        sessionMetadata: {
          ...s.sessionMetadata,
          archivedAt: null,
          archiveBatchId: null,
        },
      });
    return restored.map((s) => s.id);
  }
  listExpiredArchiveBatchIds(cutoff: string) {
    return this.listArchivedBatches({}, { limit: Infinity, offset: 0 })
      .items.filter((s) => s.archivedAt < cutoff)
      .map((s) => s.archiveBatchId);
  }
  deleteArchivedBatch(id: string) {
    return this.deleteSessionTree(id, id);
  }
  deleteSessionTree(id: string, archivedBatchId?: string): string[] {
    const items = archivedBatchId
      ? [...this.sessions.values()].filter(
          (s) => s.sessionMetadata?.archiveBatchId === archivedBatchId,
        )
      : this.listSessionTree(id);
    const deletedIds = new Set(items.map((session) => session.id));
    for (const session of this.listSessions({ limit: Infinity })) {
      if (deletedIds.has(session.id)) continue;
      const childSessionIds = session.childSessionIds.filter(
        (childId) => !deletedIds.has(childId),
      );
      if (childSessionIds.length !== session.childSessionIds.length)
        this.updateSession(session.id, { childSessionIds });
    }
    for (const s of items) {
      this.updateSession(s.id, {
        sessionMetadata: { ...s.sessionMetadata, deletedAt: nowIso() },
      });
      sessionLiveBus.cleanup(s.id);
      emitRuntimeBusEvent({ type: "session_deleted", sessionId: s.id });
    }
    // DELETE is a physical in-process removal. Rust keeps the tombstoned
    // projection for durable not-found semantics, while this cache must stop
    // returning the deleted session's messages, runs and artifacts.
    for (const records of this.entities.values())
      for (const [recordId, record] of records)
        if (record.sessionId && deletedIds.has(record.sessionId))
          records.delete(recordId);
    for (const sessionId of deletedIds) {
      this.sessions.delete(sessionId);
      this.loaded.delete(sessionId);
      this.historyCursors.delete(sessionId);
      this.executionBoundaries.delete(sessionId);
      this.messageSequences.delete(sessionId);
      this.loadedAt.delete(sessionId);
      this.tails.delete(sessionId);
      this.failures.delete(sessionId);
    }
    return items.map((s) => s.id);
  }
  /** Accept an already-committed message returned by a scoped Rust command. */
  acceptMessageProjection(message: AgentRuntimeMessage & { sequence?: number }): void {
    const prior = this.getRecord<AgentRuntimeMessage>("message", message.id);
    if (message.metadata.source === "subagent_summary" &&
        Number(prior?.metadata.eventSeq ?? 0) > Number(message.metadata.eventSeq ?? 0)) return;
    this.collection("message").set(message.id, copy(message));
    this.messageSequences.set(message.sessionId, Math.max(this.messageSequences.get(message.sessionId) ?? 0, message.sequence ?? 0));
  }
  appendMessage(message: AgentRuntimeMessage): AgentRuntimeMessage {
    const prior = this.getRecord<AgentRuntimeMessage & { sequence?: number }>(
      "message",
      message.id,
    );
    const sequence = prior?.sequence ?? (this.messageSequences.get(message.sessionId) ?? 0) + 1;
    this.messageSequences.set(message.sessionId, Math.max(sequence, this.messageSequences.get(message.sessionId) ?? 0));
    return this.saveRecord("message", { ...message, sequence });
  }
  getMessage(sessionId: string, id: string): AgentRuntimeMessage | undefined {
    const m = this.getRecord<AgentRuntimeMessage>("message", id);
    return m?.sessionId === sessionId ? m : undefined;
  }
  attachVisualizationMetadata(
    message: AgentRuntimeMessage,
    additions: Record<string, unknown>,
  ) {
    const current = this.getMessage(message.sessionId, message.id);
    if (
      !current ||
      current.role !== "assistant" ||
      current.content !== message.content ||
      current.metadata.partial
    )
      return;
    return this.appendMessage({
      ...current,
      metadata: { ...current.metadata, ...additions },
    });
  }
  listMessages(id: string) {
    return this.listRecords<AgentRuntimeMessage & { sequence?: number }>(
      "message",
      id,
    ).sort(
      (a, b) =>
        (a.sequence ?? 0) - (b.sequence ?? 0) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  }
  appendEvents(events: readonly RuntimeEvent[]) {
    return events.map((e) => this.appendEvent(e));
  }
  appendEvent(event: RuntimeEvent) {
    return this.saveRecord("event", event);
  }
  listEvents(id: string, after?: string): RuntimeEvent[] {
    const all = this.listRecords<RuntimeEvent>("event", id).sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );
    return after ? all.slice(all.findIndex((e) => e.id === after) + 1) : all;
  }
  getLatestEventByType(
    id: string,
    type: RuntimeEvent["type"],
  ): RuntimeEvent | null {
    return this.getLatestEventOfTypes(id, [type]);
  }
  getLatestEventOfTypes(
    id: string,
    types: RuntimeEvent["type"][],
  ): RuntimeEvent | null {
    return (
      this.listEvents(id)
        .filter((e) => types.includes(e.type))
        .at(-1) ?? null
    );
  }
  countEventsAfter(id: string, after: string, type: RuntimeEvent["type"]) {
    return this.listEvents(id, after).filter((e) => e.type === type).length;
  }
  appendRun(run: AgentRun): AgentRun {
    const saved = this.saveRecord("run", run),
      snapshot = copy(saved);
    this.queue(run.sessionId, async () => {
      const current = decode<{ run: AgentRun | null }>(
        await runtimeClient().uiSnapshot(run.sessionId),
      );
      if (current.run?.id === run.id) {
        const {
          id: _id,
          sessionId: _sessionId,
          startedAt: _startedAt,
          ...patch
        } = snapshot;
        await patchRuntime(run.sessionId, "run_patch", {
          runId: run.id,
          patch,
        });
      }
    });
    return saved;
  }
  acceptRunProjection(run: AgentRun): void {
    this.collection("run").set(run.id, copy(run));
  }
  getRun(id: string) {
    return this.requireRecord<AgentRun>("run", id);
  }
  updateRun(id: string, patch: Partial<AgentRun>): AgentRun {
    const current = this.getRun(id);
    const next = this.appendRun({
      ...current,
      ...patch,
      metadata: { ...current.metadata, ...patch.metadata },
    });
    this.recordRunAnalytics(next);
    return next;
  }
  listRuns(id: string) {
    return this.listRecords<AgentRun>("run", id).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
  }
  appendRunStep(step: AgentRunStep) {
    const saved = this.saveRecord("step", step);
    this.recordStepAnalytics(saved);
    return saved;
  }
  getRunStep(id: string) {
    return this.requireRecord<AgentRunStep>("step", id);
  }
  updateRunStep(id: string, patch: Partial<AgentRunStep>) {
    return this.appendRunStep({ ...this.getRunStep(id), ...patch });
  }
  listRunSteps(id: string) {
    return [...this.collection("step").values()]
      .filter((s) => (s as AgentRunStep).runId === id)
      .map((v) => copy(v as AgentRunStep))
      .sort((a, b) => a.index - b.index);
  }
  listSessionSteps(id: string) {
    return this.listRecords<AgentRunStep>("step", id).sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt) || a.index - b.index,
    );
  }
  appendRunPart(part: AgentRunPart) {
    return this.saveRecord("part", part);
  }
  listRunParts(id: string) {
    return [...this.collection("part").values()]
      .filter((p) => (p as AgentRunPart).stepId === id)
      .map((v) => copy(v as AgentRunPart))
      .sort((a, b) => a.sequence - b.sequence);
  }
  /** Whole-session snapshot for callers that would otherwise scan per step. */
  listSessionParts(sessionId: string) {
    return this.listRecords<AgentRunPart>("part", sessionId).sort(
      (a, b) => a.sequence - b.sequence,
    );
  }
  nextRunPartSequence(id: string) {
    return Math.max(0, ...this.listRunParts(id).map((p) => p.sequence)) + 1;
  }
  appendToolCall(call: ToolCallRecord) {
    const existed = this.collection("tool_call").has(call.id);
    const saved = this.saveRecord("tool_call", call);
    if (!existed) this.recordToolCallAnalytics(saved);
    return saved;
  }
  updateToolCall(
    sessionId: string,
    id: string,
    patch: Partial<ToolCallRecord>,
  ) {
    return this.appendToolCall({
      ...this.getToolCall(sessionId, id),
      ...patch,
    });
  }
  getToolCall(sessionId: string, id: string) {
    const call = this.requireRecord<ToolCallRecord>("tool_call", id);
    if (call.sessionId !== sessionId) throw new AgentNotFoundError(id);
    return call;
  }
  listToolInvocationRows(
    id: string,
  ): Array<
    Pick<ToolCallRecord, "toolId" | "category" | "startedAt" | "inputRef">
  > {
    return this.listToolCalls(id).map(
      ({ toolId, category, startedAt, inputRef }) => ({
        toolId,
        category,
        startedAt,
        inputRef: toolId === "skill.load" ? inputRef : null,
      }),
    );
  }
  listToolCalls(id: string) {
    return this.listRecords<ToolCallRecord>("tool_call", id).sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    );
  }
  listRunToolCalls(id: string) {
    return [...this.collection("tool_call").values()]
      .map((v) => copy(v as ToolCallRecord))
      .filter((c) => c.runId === id)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  appendPermission(decision: PermissionDecision) {
    const record = this.saveRecord("permission", decision);
    this.enqueueControl(decision.sessionId, `permission-request:${decision.id}`, 'permission_request', record);
    return record;
  }
  updatePermission(
    sessionId: string,
    id: string,
    patch: Partial<PermissionDecision>,
  ) {
    const current = this.requireRecord<PermissionDecision>("permission", id);
    if (current.sessionId !== sessionId) throw new AgentNotFoundError(id);
    return this.saveRecord('permission', { ...current, ...patch });
  }
  listPermissions(id: string) {
    return this.listRecords<PermissionDecision>("permission", id);
  }
  findPermissionByResumeToken(id: string, token: string) {
    return this.listPermissions(id).find((p) => p.resumeToken === token);
  }
  appendArtifact(artifact: EvidenceArtifact) {
    return this.saveRecord("artifact", artifact);
  }
  listArtifacts(id: string) {
    return this.listRecords<EvidenceArtifact>("artifact", id);
  }
  saveContextBundle(bundle: AgentContextBundle) {
    return this.saveRecord("context", bundle);
  }
  getContextBundle(id: string) {
    return this.requireRecord<AgentContextBundle>("context", id);
  }
  saveThinkingSummary(summary: ThinkingSummary) {
    return this.saveRecord("thinking", summary);
  }
  getThinkingSummary(id: string) {
    return this.requireRecord<ThinkingSummary>("thinking", id);
  }
  saveCompactionRecord(record: CompactionRecord) {
    return this.saveRecord("compaction", record);
  }
  getLatestCompactionRecord(id: string): CompactionRecord | null {
    return (
      this.listRecords<CompactionRecord>("compaction", id).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      )[0] ?? null
    );
  }
  getSessionStats(
    sessionId: string,
    options: { configuredContextLimit?: number | null } = {},
  ): {
    work: Pick<WorkRecord, "id" | "status" | "remaining" | "reason"> | null;
    roundCount: number;
    averageStepsPerCompletedRun: number | null;
    contextComposition: ContextComposition | null;
    context: SessionUsageProjection["context"] & { compactedTokens?: number };
    contextCompaction?: ContextCompactionState;
    cache: SessionUsageProjection["cache"];
    usage: SessionUsageProjection["usage"];
    coverage: SessionUsageProjection["coverage"];
    tokenUsage: { input: number; output: number; total: number };
    contextLimit: number;
    contextLimitKnown: boolean;
    contextUsedPercent: number;
    toolCallCount: number;
    runningDuration: number;
    status: string;
    activeSubAgentCount: number;
  } {
    const session = this.getSession(sessionId);
    const projected = projectSessionUsage(
      sessionId,
      this.listSessionTree(sessionId).map((s) => s.id),
    );
    const contextCompaction = session.sessionMetadata?.contextCompaction as
      | ContextCompactionState
      | undefined;
    const compactedTokens =
      contextCompaction?.status === "completed" &&
      contextCompaction.requestId === projected.context.requestId
        ? contextCompaction.compressedTokens
        : undefined;
    const input = compactedTokens ?? projected.context.inputTokens ?? 0;
    const recordedLimit = this.listRuns(sessionId)
      .map((r) => r.metadata.contextLimit)
      .find((v) => typeof v === "number" && v > 0) as number | undefined;
    const known = projected.reportedWindow ?? options.configuredContextLimit ?? recordedLimit;
    const limit = known ?? 200_000;
    const activeWorkId = session.sessionMetadata?.activeWorkId;
    const work =
      typeof activeWorkId === "string"
        ? this.getRecord<WorkRecord>("work", activeWorkId)
        : undefined;
    const runs = this.listRuns(sessionId).filter(
      (r) => r.status === "completed",
    );
    return {
      work: work
        ? {
            id: work.id,
            status: work.status,
            remaining: work.remaining,
            reason: work.reason,
          }
        : null,
      roundCount: this.listSessionSteps(sessionId).length,
      averageStepsPerCompletedRun: runs.length
        ? runs.reduce((n, r) => n + this.listRunSteps(r.id).length, 0) /
          runs.length
        : null,
      contextComposition: projected.contextComposition,
      context: {
        ...projected.context,
        ...(compactedTokens === undefined ? {} : { compactedTokens }),
      },
      contextCompaction,
      cache: projected.cache,
      usage: projected.usage,
      coverage: projected.coverage,
      tokenUsage: { input, output: projected.usage.self.output, total: input },
      contextLimit: limit,
      contextLimitKnown: known != null,
      contextUsedPercent: Math.min(100, Math.round((input / limit) * 100)),
      toolCallCount: this.listToolCalls(sessionId).length,
      runningDuration: projected.durationMs,
      status: session.status,
      activeSubAgentCount: session.childSessionIds.filter(
        (id) => this.tryGetSession(id)?.status === "running",
      ).length,
    };
  }
  recoverOrphanedSessions(): number {
    const sessions = this.listSessions({ limit: Infinity }).filter((s) =>
      ["running", "queued", "waiting_permission"].includes(s.status),
    );
    for (const s of sessions)
      this.updateSession(s.id, {
        status: "interrupted",
        activeRunId: null,
        updatedAt: nowIso(),
        blockedReason: "Server restarted.",
      });
    return sessions.length;
  }
  reset(): void {
    this.sessions.clear();
    this.entities.clear();
    this.loaded.clear();
    this.historyCursors.clear();
    this.executionBoundaries.clear();
    this.messageSequences.clear();
    this.loadedAt.clear();
    this.failures.clear();
    this.tails.clear();
  }
  hashArgs(args: unknown): string {
    return createHash("sha256")
      .update(JSON.stringify(args ?? null))
      .digest("hex");
  }
}
export const agentRuntimeStore = new AgentRuntimeStore();
