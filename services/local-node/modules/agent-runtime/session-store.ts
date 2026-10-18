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
import { historyPages, sessionPages } from './sidecar/history-pages.js';
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

/** Execution working set. Rust is the sole durable repository. Callers load before
 * executing and await flush before acknowledging commands or yielding worker IPC. */
export class AgentRuntimeStore {
  private sessions = new Map<string, AgentSession>();
  private entities = new Map<string, Map<string, Entity>>();
  private tails = new Map<string, Promise<void>>();
  private failures = new Map<string, unknown>();
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private staged?: { writes: Array<() => void>; undo: Array<() => void> };
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
  async hydrateSessions(): Promise<void> {
    await this.flush();
    for await (const items of sessionPages<AgentSession>(runtimeClient())) {
      for (const session of items) this.sessions.set(session.id, copy(session));
    }
  }
  async hydrateSession(sessionId: string, refresh = false): Promise<void> {
    if (this.loaded.has(sessionId) && !refresh) {
      await this.flushSession(sessionId);
      return;
    }
    const existing = this.loading.get(sessionId);
    if (existing) return existing;
    const load = (async () => {
      await this.flushSession(sessionId);
      await runtimeClient().historyCommand({ sessionId, requestId: `hydrate-history:${sessionId}:${Date.now()}`,
        operation: 'reconcile_stream', payload: {} });
      const snapshot = decode<{ session: AgentSession; run: AgentRun | null }>(
        await runtimeClient().uiSnapshot(sessionId),
      );
      this.sessions.set(sessionId, snapshot.session);
      for (const [kind, operation] of Object.entries(collections)) {
        const map = this.collection(kind);
        for (const [id, record] of map)
          if (record.sessionId === sessionId) map.delete(id);
        for await (const page of historyPages<Entity>(runtimeClient(), sessionId, operation)) {
          for (const record of page) map.set(record.id, record);
        }
      }
      if (snapshot.run)
        this.collection("run").set(snapshot.run.id, snapshot.run);
      const control = await patchRuntime(sessionId, "read", {});
      const permissions = this.collection("permission");
      for (const permission of control.permissions as PermissionDecision[])
        permissions.set(permission.id, permission);
      const interactions = this.collection("interaction");
      for (const interaction of control.interactions as Entity[])
        interactions.set(interaction.id, interaction);
      await (await import("./media-assets.js")).hydrateSessionAssets(sessionId);
      this.loaded.add(sessionId);
    })();
    this.loading.set(sessionId, load);
    try {
      await load;
    } finally {
      this.loading.delete(sessionId);
    }
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
    return this.updateSession(id, {
      sessionMetadata: { ...current.sessionMetadata, ...patch },
    });
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
    } = {},
  ): AgentSession[] {
    return [...this.sessions.values()]
      .filter(
        (s) => !s.sessionMetadata?.archivedAt && !s.sessionMetadata?.deletedAt,
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
    for (const s of items) {
      this.updateSession(s.id, {
        sessionMetadata: { ...s.sessionMetadata, deletedAt: nowIso() },
      });
      sessionLiveBus.cleanup(s.id);
      emitRuntimeBusEvent({ type: "session_deleted", sessionId: s.id });
    }
    return items.map((s) => s.id);
  }
  appendMessage(message: AgentRuntimeMessage): AgentRuntimeMessage {
    const prior = this.getRecord<AgentRuntimeMessage & { sequence?: number }>(
      "message",
      message.id,
    );
    const sequence =
      prior?.sequence ??
      Math.max(
        0,
        ...this.listRecords<AgentRuntimeMessage & { sequence?: number }>(
          "message",
          message.sessionId,
        ).map((m) => m.sequence ?? 0),
      ) + 1;
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
    return this.appendRun({
      ...current,
      ...patch,
      metadata: { ...current.metadata, ...patch.metadata },
    });
  }
  listRuns(id: string) {
    return this.listRecords<AgentRun>("run", id).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
  }
  appendRunStep(step: AgentRunStep) {
    return this.saveRecord("step", step);
  }
  getRunStep(id: string) {
    return this.requireRecord<AgentRunStep>("step", id);
  }
  updateRunStep(id: string, patch: Partial<AgentRunStep>) {
    return this.appendRunStep({ ...this.getRunStep(id), ...patch });
  }
  listRunSteps(id: string) {
    return [...this.collection("step").values()]
      .map((v) => copy(v as AgentRunStep))
      .filter((s) => s.runId === id)
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
      .map((v) => copy(v as AgentRunPart))
      .filter((p) => p.stepId === id)
      .sort((a, b) => a.sequence - b.sequence);
  }
  nextRunPartSequence(id: string) {
    return Math.max(0, ...this.listRunParts(id).map((p) => p.sequence)) + 1;
  }
  appendToolCall(call: ToolCallRecord) {
    return this.saveRecord("tool_call", call);
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
    const known =
      options.configuredContextLimit ??
      recordedLimit ??
      projected.reportedWindow;
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
