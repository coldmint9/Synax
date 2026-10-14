import { JsonlVersionPayloads } from "../../../../infrastructure/storage/jsonl-version-payloads.js";
import path from "node:path";
import { DATA_ROOT, TRANSCRIPT_STORAGE } from "../../../../infrastructure/runtime/env.js";
import { ImmutablePayloads } from "../../../../infrastructure/storage/immutable-payloads.js";
import { admitVersionGrowth } from "../resource-admission.js";
import type Database from "libsql";
import { getRawSqlite } from "../../../../infrastructure/database/index.js";
import { VersionObjects } from "../version-store/objects.js";
import { RuntimeVersionRepository } from "./repository.js";
import { AgentRuntimeError } from "../../runtime-errors.js";
import type {
  AgentSession,
  RuntimeEvent,
  AgentContextBundle,
} from "../../contracts.js";
import { atomicVersionWrite } from "../version-store/transaction.js";

const repositories = new WeakMap<Database.Database, RuntimeVersionRepository>();
const headQueries = new WeakMap<
  Database.Database,
  Database.Statement<[string]>
>();
const LIVE_METADATA = [
  "permissionTier",
  "permissionOverrides",
  "runtimeControl",
  "manualStop",
  "inputQueue",
  "inputForceInjectId",
  "pendingResume",
  "turnReferences",
  "historyRevision",
  "latestSystemPrompt",
];
export function versionRepository(): RuntimeVersionRepository {
  const db = getRawSqlite();
  let repo = repositories.get(db);
  if (!repo) {
    const supportsExternal = (db.prepare("PRAGMA table_info(conversation_v3_objects)").all() as { name: string }[]).some(column => column.name === "payload_ref");
    const supportsJsonl = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jsonl_payload_records'").get());
    const payloads = supportsJsonl
      ? new JsonlVersionPayloads(db, path.join(path.resolve(DATA_ROOT), "version-jsonl"), path.join(path.resolve(DATA_ROOT), "version-payloads"))
      : supportsExternal ? new ImmutablePayloads(path.join(path.resolve(DATA_ROOT), "version-payloads")) : undefined;
    repo = new RuntimeVersionRepository(
      new VersionObjects(db, {
        maxBytes: 1024 * 1024 * 1024,
        maxObjects: 2000000,
      }, bytes => admitVersionGrowth(db, bytes), payloads, Boolean(process.env.SYNAX_STORAGE_OWNER_ENDPOINT) || TRANSCRIPT_STORAGE === "jsonl"),
    );
    repositories.set(db, repo);
  }
  return repo;
}
export function versionedSession(id: string): boolean {
  const db = getRawSqlite();
  let query = headQueries.get(db);
  if (!query) {
    query = db.prepare<[string]>(
      "SELECT 1 AS present FROM conversation_v3_heads WHERE session_id=?",
    );
    headQueries.set(db, query);
  }
  return Boolean(query.get(id));
}
export function appendOnlySession(sessionId: string): boolean {
  return (getRawSqlite().prepare("SELECT rollback_enabled FROM conversation_v3_heads WHERE session_id=?").get(sessionId) as { rollback_enabled: number } | undefined)?.rollback_enabled === 0;
}
export function boundaryOnlySession(sessionId: string): boolean {
  return Boolean((getRawSqlite().prepare("SELECT boundary_only FROM conversation_v3_heads WHERE session_id=?").get(sessionId) as { boundary_only: number } | undefined)?.boundary_only);
}
export function versionRuntimeMode(
  sessionId: string,
): "transcript" | "native" | undefined {
  return (
    getRawSqlite()
      .prepare(
        "SELECT runtime_mode FROM conversation_v3_heads WHERE session_id=?",
      )
      .get(sessionId) as { runtime_mode: "transcript" | "native" } | undefined
  )?.runtime_mode;
}
/** Only called inside the fresh-session creation transaction, before any
 * event, context, run or user input can be published. Existing rows never opt in. */
export function initializeFreshVersionNative(session: AgentSession): void {
  const db = getRawSqlite();
  if (!db.inTransaction || session.parentSessionId || session.activeRunId || session.contextSnapshotId)
    throw new AgentRuntimeError("Fresh root initialization requires its creation transaction.", "HISTORY_SESSION_BUSY", 409);
  versionRepository().create(session.id, historySessionFields(session));
  db.prepare("UPDATE conversation_v3_heads SET runtime_mode='native',boundary_only=1 WHERE session_id=?").run(session.id);
}

/** JSONL is the physical history backend for every new session. Capability
 * restrictions remain separate: only supported native roots expose rollback. */
export function initializeFreshJsonlHistory(session: AgentSession): void {
  const db = getRawSqlite();
  if (!db.inTransaction || session.activeRunId || session.contextSnapshotId)
    throw new AgentRuntimeError("JSONL history requires the session creation transaction.", "HISTORY_SESSION_BUSY", 409);
  versionRepository().create(session.id, historySessionFields(session));
  const backend = (session.sessionMetadata?.backend as { id?: string } | undefined)?.id ?? "native";
  db.prepare("UPDATE conversation_v3_heads SET runtime_mode='native',boundary_only=1,full_history=1,rollback_enabled=? WHERE session_id=?")
    .run(!session.parentSessionId && backend === "native" && session.sessionMetadata?.historyRollbackEnabled !== false ? 1 : 0, session.id);
  db.prepare("INSERT INTO session_history_storage(session_id,backend,migrated_at,source_backend) VALUES(?,'jsonl-v3',?,'new')")
    .run(session.id, new Date().toISOString());
}

export function initializeVersionNative(
  session: AgentSession,
  events: readonly RuntimeEvent[] = [],
  context?: AgentContextBundle,
): void {
  atomicVersionWrite(getRawSqlite(), () => {
    if (
      session.contextSnapshotId &&
      (!context ||
        context.id !== session.contextSnapshotId ||
        context.sessionId !== session.id)
    )
      throw new AgentRuntimeError(
        "Initial context seed is required for Native versioning.",
        "HISTORY_MIGRATION_REQUIRED",
        409,
      );
    initializeVersionTranscript(session, events);
    if (context)
      versionRepository().put(
        session.id,
        "contexts",
        context.id,
        context as unknown as Record<string, unknown>,
      );
    getRawSqlite()
      .prepare(
        "UPDATE conversation_v3_heads SET runtime_mode='native' WHERE session_id=?",
      )
      .run(session.id);
  });
}
export function historySessionFields(
  session: AgentSession,
): Record<string, unknown> {
  const metadata = { ...session.sessionMetadata };
  for (const key of LIVE_METADATA) delete metadata[key];
  return {
    id: session.id,
    prompt: session.prompt,
    resultSummary: session.resultSummary,
    contextSnapshotId: session.contextSnapshotId,
    sessionMetadata: metadata,
  };
}
export function versionSessionView(current: AgentSession): AgentSession {
  if (!versionedSession(current.id)) return current;
  const history = versionRepository().readSession(current.id),
    metadata = { ...(history.sessionMetadata as Record<string, unknown>) };
  for (const key of LIVE_METADATA)
    if (current.sessionMetadata?.[key] !== undefined)
      metadata[key] = current.sessionMetadata[key];
  return {
    ...current,
    prompt: history.prompt as string,
    resultSummary: history.resultSummary as string | null,
    contextSnapshotId: history.contextSnapshotId as string | null,
    sessionMetadata: { ...metadata, historyStorage: 3, historyPayloadStorage: versionRepository().objects.jsonl ? "jsonl" : "sqlite", historyRollbackEnabled: !appendOnlySession(current.id) },
  };
}
export function assertVersionTranscriptOperation(
  sessionId: string,
  includeFiles: boolean,
  action = "rollback",
): void {
  if (appendOnlySession(sessionId)) throw new AgentRuntimeError("Forked conversations are append-only; rollback and editing previous messages are disabled.", "HISTORY_APPEND_ONLY", 409);
  if (
    (includeFiles && versionRuntimeMode(sessionId) !== "native") ||
    (action !== "rollback" &&
      !(action === "edit" && versionRuntimeMode(sessionId) === "native"))
  )
    throw new AgentRuntimeError(
      "Version transcript rollout does not yet support execution/edit/fork/file restoration.",
      "VERSION_RUNTIME_NOT_READY",
      409,
    );
  if (!versionedSession(sessionId))
    throw new AgentRuntimeError(
      "Versioned session not found.",
      "NOT_FOUND",
      404,
    );
}

/** Explicit internal initializer, never called by ordinary create/open routes.
 * Only an inactive fresh transcript is admitted. Real v2 history needs migration. */
export function initializeVersionTranscript(
  session: AgentSession,
  initialEvents: readonly RuntimeEvent[] = [],
): void {
  const db = getRawSqlite();
  atomicVersionWrite(db, () => {
    if (versionedSession(session.id))
      throw new AgentRuntimeError(
        "Session is already versioned.",
        "HISTORY_CONFLICT",
        409,
      );
    const current = db
      .prepare(
        "SELECT status,parent_session_id,active_run_id,pending_resume_token FROM agent_runtime_sessions WHERE id=?",
      )
      .get(session.id) as
      | {
          status: string;
          parent_session_id: string | null;
          active_run_id: string | null;
          pending_resume_token: string | null;
        }
      | undefined;
    if (
      !current ||
      current.status !== "completed" ||
      current.parent_session_id ||
      current.active_run_id ||
      current.pending_resume_token
    )
      throw new AgentRuntimeError(
        "The current session is not an inactive native root.",
        "HISTORY_SESSION_BUSY",
        409,
      );
    if (
      session.parentSessionId ||
      session.childSessionIds.length ||
      session.status !== "completed" ||
      session.activeRunId ||
      session.pendingResumeToken
    )
      throw new AgentRuntimeError(
        "Initialize only an inactive native root session.",
        "HISTORY_SESSION_BUSY",
        409,
      );
    const backend = session.sessionMetadata?.backend as
      | { id?: string }
      | undefined;
    if (backend?.id && backend.id !== "native")
      throw new AgentRuntimeError(
        "Native session required.",
        "HISTORY_UNSUPPORTED",
        409,
      );
    const tables = [
      "agent_runtime_messages",
      "agent_runtime_runs",
      "agent_runtime_run_steps",
      "agent_runtime_run_parts",
      "agent_runtime_tool_calls",
      "agent_runtime_permissions",
      "agent_runtime_artifacts",
      "agent_runtime_interactions",
      "agent_runtime_work",
      "conversation_checkpoints",
      "conversation_mutations",
      "agent_runtime_processes",
    ];
    for (const table of tables)
      if (
        db
          .prepare(`SELECT 1 FROM ${table} WHERE session_id=? LIMIT 1`)
          .get(session.id)
      )
        throw new AgentRuntimeError(
          "Existing runtime history requires an explicit version migration.",
          "HISTORY_MIGRATION_REQUIRED",
          409,
        );
    const eventRows = db
      .prepare("SELECT id FROM agent_runtime_events WHERE session_id=? LIMIT 3")
      .all(session.id) as { id: string }[];
    if (
      eventRows.length > 2 ||
      initialEvents.length !== eventRows.length ||
      initialEvents.some(
        (event) =>
          event.sessionId !== session.id ||
          !eventRows.some((row) => row.id === event.id),
      )
    )
      throw new AgentRuntimeError(
        "Initial event seed does not match the bounded fresh transcript.",
        "HISTORY_MIGRATION_REQUIRED",
        409,
      );
    const repo = versionRepository();
    repo.create(session.id, historySessionFields(session));
    for (const event of initialEvents)
      repo.put(
        session.id,
        "events",
        event.id,
        event as unknown as Record<string, unknown>,
      );
  });
}

export function versionedList<T>(sessionId: string, table: string): T[] {
  return versionRepository().list(sessionId, table) as T[];
}
