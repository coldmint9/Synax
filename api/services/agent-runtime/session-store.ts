import { retainVersionRecordAssets } from "./checkpoints/version-runtime/assets.js";
import {
  writeVersionEntity,
  readVersionEntity,
  listVersionEntities,
  entityScope,
} from "./checkpoints/version-runtime/entities.js";
import { assertBatchInput } from "./checkpoints/version-runtime/batch-input.js";
import {
  versionRepository,
  versionedSession,
  versionSessionView,
  historySessionFields,
  versionedList,
} from "./checkpoints/version-runtime/bridge.js";
import type { ContextComposition } from "./context-composition.js";
import { bindAssets } from "./media-assets.js";
import { runtimeTransaction } from "./runtime-transaction.js";
import { logger } from "../../lib/logger.js";
import type { WorkRecord } from "./work-store.js";
import {
  projectSessionUsage,
  type SessionUsageProjection,
} from "./usage-projection.js";
import { createHash } from "node:crypto";
import { getRawSqlite } from "../../db/index.js";
import {
  readUsageContextWindowSize,
  readUsageInputTokens,
  readUsageOutputTokens,
} from "./acp-engine/acp-usage.js";
import { nowIso } from "./runtime-ids.js";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";
import { sessionHooks } from "./session-hooks.js";
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
import { AgentNotFoundError, AgentRuntimeError } from "./runtime-errors.js";
import { normalizeAgentSessionStatus } from "./session-projection.js";

type JsonObject = Record<string, unknown>;

interface SessionRow {
  id: string;
  project_id: string;
  parent_session_id: string | null;
  child_session_ids_json: string;
  node_id: string | null;
  profile_id: string;
  status: string;
  title: string | null;
  prompt: string;
  context_snapshot_id: string | null;
  thinking_mode: AgentSession["thinkingMode"];
  reasoning_effort: string | null;
  permission_rules_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  result_summary: string | null;
  blocked_reason: string | null;
  skill_ids_json: string;
  mcp_server_ids_json: string;
  active_run_id: string | null;
  pending_resume_token: string | null;
  session_metadata_json: string | null;
}

interface MessageRow {
  content_parts_json: string | null;
  id: string;
  session_id: string;
  project_id: string;
  sequence: number;
  turn_id: string | null;
  run_id: string | null;
  step_id: string | null;
  role: AgentRuntimeMessage["role"];
  content: string;
  provider_id: string | null;
  model_id: string | null;
  tool_call_id: string | null;
  usage_json: string;
  metadata_json: string;
  created_at: string;
}

interface EventRow {
  id: string;
  session_id: string;
  type: string;
  timestamp: string;
  visibility: RuntimeEvent["visibility"];
  summary: string;
  payload_json: string;
}

interface ToolCallRow {
  content_parts_json: string | null;
  id: string;
  session_id: string;
  run_id: string | null;
  step_id: string | null;
  model_tool_call_id: string | null;
  tool_id: string;
  category: ToolCallRecord["category"];
  mutability: ToolCallRecord["mutability"];
  args_hash: string;
  input_summary: string;
  input_ref_json: string | null;
  output_summary: string | null;
  output_ref_json: string | null;
  status: ToolCallRecord["status"];
  permission_decision_id: string | null;
  started_at: string;
  ended_at: string | null;
  error: string | null;
}

interface PermissionRow {
  id: string;
  session_id: string;
  run_id: string | null;
  step_id: string | null;
  tool_call_id: string | null;
  coarse_category: PermissionDecision["coarseCategory"];
  internal_gate: PermissionDecision["internalGate"];
  action: PermissionDecision["action"];
  reason: string;
  patterns_json: string;
  user_reply: PermissionDecision["userReply"];
  created_at: string;
  resolved_at: string | null;
  resume_token: string | null;
  metadata_json: string;
}

interface ArtifactRow {
  id: string;
  session_id: string;
  kind: EvidenceArtifact["kind"];
  title: string;
  summary: string;
  source_refs_json: string;
  risk: EvidenceArtifact["risk"];
  metadata_json: string;
  created_at: string;
}

interface ContextBundleRow {
  id: string;
  project_id: string;
  session_id: string | null;
  node_id: string | null;
  profile_id: string | null;
  blocks_json: string;
  citations_json: string;
  warnings_json: string;
  created_at: string;
}

interface ThinkingSummaryRow {
  id: string;
  session_id: string;
  mode: ThinkingSummary["mode"];
  framing: string;
  evidence_used_json: string;
  decision: string;
  assumptions_json: string;
  risks_json: string;
  next_steps_json: string;
}

interface RunRow {
  id: string;
  session_id: string;
  status: AgentRun["status"];
  started_at: string;
  completed_at: string | null;
  trigger_message_id: string | null;
  current_step: number;
  stop_reason: string | null;
  model: string | null;
  metadata_json: string;
}

interface RunStepRow {
  id: string;
  run_id: string;
  session_id: string;
  step_index: number;
  status: AgentRunStep["status"];
  model: string | null;
  started_at: string;
  completed_at: string | null;
  finish_reason: string | null;
  metadata_json: string;
}

interface RunPartRow {
  id: string;
  run_id: string;
  step_id: string;
  session_id: string;
  kind: AgentRunPart["kind"];
  sequence: number;
  content: string;
  tool_call_id: string | null;
  metadata_json: string;
  created_at: string;
}

const RUNTIME_TABLES = [
  "conversation_history_access",
  "conversation_history_tracking",
  "conversation_history_journal",
  "conversation_snapshot_leases",
  "conversation_workspace_locks",
  "conversation_history_operations",
  "conversation_history_versions",
  "conversation_checkpoints",
  "conversation_mutations",
  "agent_runtime_processes",
  "agent_runtime_stream_records",
  "agent_runtime_work",
  "agent_runtime_aux_usage",
  "agent_runtime_interactions",
  "agent_runtime_run_parts",
  "agent_runtime_run_steps",
  "agent_runtime_runs",
  "agent_runtime_thinking_summaries",
  "agent_runtime_compaction_summaries",
  "agent_runtime_context_bundles",
  "agent_runtime_artifacts",
  "agent_runtime_permissions",
  "agent_runtime_tool_calls",
  "agent_runtime_events",
  "agent_runtime_messages",
  "agent_runtime_sessions",
] as const;

// Mirrors projectSessionState(): runtimeControl.state overrides the stored status,
// while legacy blocked/paused rows are always materialized as completed.
// json_valid() keeps malformed session metadata from breaking list queries.
const PROJECTED_STATUS_SQL = `CASE
      WHEN json_valid(session_metadata_json) AND json_extract(session_metadata_json, '$.runtimeControl.state') = 'unconfirmed' THEN 'completed'
      WHEN profile_id IN ('synax', 'goal') AND status IN ('waiting_permission', 'waiting_input') THEN status
      WHEN profile_id IN ('synax', 'goal') AND (
        status IN ('running', 'stopping')
        OR (json_valid(session_metadata_json) AND json_extract(session_metadata_json, '$.runtimeControl.state') = 'stopping')
      ) THEN 'running'
      WHEN profile_id IN ('synax', 'goal') AND status = 'queued' THEN 'queued'
      WHEN profile_id IN ('synax', 'goal') THEN 'completed'
      WHEN json_valid(session_metadata_json) AND json_extract(session_metadata_json, '$.runtimeControl.state') = 'stopping' THEN 'stopping'
      WHEN status IN ('blocked', 'paused') THEN 'completed'
      ELSE status
    END`;

// Recursive lineage walk; `?` is the root id. UNION (not UNION ALL) is required
// for cycle safety, and both parent pointer and legacy child_session_ids_json
// edges must be followed to match the previous in-memory traversal.
// Non-array/invalid JSON degrades to an empty list like parseArray().
const SESSION_TREE_CTE = `WITH RECURSIVE session_tree(id, child_ids_json) AS (
    SELECT id, child_session_ids_json FROM agent_runtime_sessions WHERE id = ?
    UNION
    SELECT child.id, child.child_session_ids_json
      FROM agent_runtime_sessions child
      JOIN session_tree parent ON child.parent_session_id = parent.id
    UNION
    SELECT child.id, child.child_session_ids_json
      FROM agent_runtime_sessions child
      JOIN session_tree parent ON child.id IN (
        SELECT value FROM json_each(
          CASE WHEN json_valid(parent.child_ids_json)
               THEN CASE WHEN json_type(parent.child_ids_json) = 'array'
                         THEN parent.child_ids_json ELSE '[]' END
               ELSE '[]' END)
      )
  )`;

function stringify(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseArray<T>(raw: string | null | undefined): T[] {
  const parsed = parseJson<unknown>(raw, []);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function isReasoningEffort(
  value: string | null | undefined,
): value is AgentSession["reasoningEffort"] {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function parseObject(raw: string | null | undefined): JsonObject {
  const parsed = parseJson<unknown>(raw, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonObject)
    : {};
}

function mapSession(row: SessionRow): AgentSession {
  return versionSessionView({
    id: row.id,
    projectId: row.project_id,
    parentSessionId: row.parent_session_id,
    childSessionIds: parseArray<string>(row.child_session_ids_json),
    nodeId: row.node_id,
    profileId: row.profile_id,
    status: normalizeAgentSessionStatus(row.status),
    title: row.title,
    prompt: row.prompt,
    contextSnapshotId: row.context_snapshot_id,
    thinkingMode: row.thinking_mode,
    reasoningEffort: isReasoningEffort(row.reasoning_effort)
      ? row.reasoning_effort
      : null,
    permissionRules: parseArray(row.permission_rules_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    resultSummary: row.result_summary,
    blockedReason: row.blocked_reason,
    skillIds: parseArray<string>(row.skill_ids_json),
    mcpServerIds: parseArray<string>(row.mcp_server_ids_json),
    activeRunId: row.active_run_id,
    pendingResumeToken: row.pending_resume_token,
    sessionMetadata: parseObject(row.session_metadata_json),
  });
}

function mapMessage(row: MessageRow): AgentRuntimeMessage {
  return {
    contentParts: parseJson(row.content_parts_json, undefined),
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    stepId: row.step_id,
    role: row.role,
    content: row.content,
    metadata: parseObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

const DEFAULT_CONTEXT_WINDOW_SIZE = 200_000;

function normalizeContextLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** Provider-configured window recorded on the session's most recent run. */
function readLatestRunContextLimit(
  db: ReturnType<typeof getRawSqlite>,
  sessionId: string,
): number | null {
  const row = db
    .prepare(
      `SELECT metadata_json FROM agent_runtime_runs
       WHERE session_id = ?
       ORDER BY started_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(sessionId) as { metadata_json: string | null } | undefined;
  if (!row?.metadata_json) return null;
  try {
    const metadata = JSON.parse(row.metadata_json) as {
      contextLimit?: unknown;
    };
    return normalizeContextLimit(metadata.contextLimit);
  } catch {
    return null;
  }
}

function mapEvent(row: EventRow): RuntimeEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    type:
      row.type === "session_blocked"
        ? "session_completed"
        : (row.type as RuntimeEvent["type"]),
    timestamp: row.timestamp,
    visibility: row.visibility,
    summary: row.summary,
    payload: parseObject(row.payload_json),
  };
}

function mapToolCall(row: ToolCallRow): ToolCallRecord {
  return {
    contentParts: parseJson(row.content_parts_json, undefined),
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    stepId: row.step_id,
    modelToolCallId: row.model_tool_call_id,
    toolId: row.tool_id,
    category: row.category,
    mutability: row.mutability,
    argsHash: row.args_hash,
    inputSummary: row.input_summary,
    inputRef: parseJson(row.input_ref_json, null),
    outputSummary: row.output_summary,
    outputRef: parseJson(row.output_ref_json, null),
    status: row.status,
    permissionDecisionId: row.permission_decision_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    error: row.error,
  };
}

function mapPermission(row: PermissionRow): PermissionDecision {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    stepId: row.step_id,
    toolCallId: row.tool_call_id,
    coarseCategory: row.coarse_category,
    internalGate: row.internal_gate,
    action: row.action,
    reason: row.reason,
    patterns: parseArray<string>(row.patterns_json),
    userReply: row.user_reply,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resumeToken: row.resume_token,
    metadata: parseObject(row.metadata_json),
  };
}

function mapArtifact(row: ArtifactRow): EvidenceArtifact {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    sourceRefs: parseArray(row.source_refs_json),
    risk: row.risk,
    metadata: parseObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

function mapContextBundle(row: ContextBundleRow): AgentContextBundle {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    nodeId: row.node_id,
    profileId: row.profile_id,
    blocks: parseArray(row.blocks_json),
    citations: parseArray(row.citations_json),
    warnings: parseArray<string>(row.warnings_json),
    createdAt: row.created_at,
  };
}

function mapThinkingSummary(row: ThinkingSummaryRow): ThinkingSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    mode: row.mode,
    framing: row.framing,
    evidenceUsed: parseArray(row.evidence_used_json),
    decision: row.decision,
    assumptions: parseArray<string>(row.assumptions_json),
    risks: parseArray<string>(row.risks_json),
    nextSteps: parseArray<string>(row.next_steps_json),
  };
}

function mapRun(row: RunRow): AgentRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    triggerMessageId: row.trigger_message_id,
    currentStep: row.current_step,
    stopReason: row.stop_reason,
    model: row.model,
    metadata: parseObject(row.metadata_json),
  };
}

function mapRunStep(row: RunStepRow): AgentRunStep {
  return {
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id,
    index: row.step_index,
    status: row.status,
    model: row.model,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    finishReason: row.finish_reason,
    metadata: parseObject(row.metadata_json),
  };
}

function mapRunPart(row: RunPartRow): AgentRunPart {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    sessionId: row.session_id,
    kind: row.kind,
    sequence: row.sequence,
    content: row.content,
    toolCallId: row.tool_call_id,
    metadata: parseObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

export class AgentRuntimeStore {
  createSession(session: AgentSession): AgentSession {
    this.upsertSession(session);
    if (session.parentSessionId) {
      const parent = this.tryGetSession(session.parentSessionId);
      if (parent && !parent.childSessionIds.includes(session.id)) {
        this.updateSession(parent.id, {
          childSessionIds: [...parent.childSessionIds, session.id],
          updatedAt: session.createdAt,
        });
      }
    }
    return session;
  }

  getSession(id: string): AgentSession {
    const row = getRawSqlite()
      .prepare("SELECT * FROM agent_runtime_sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    if (!row) throw new AgentNotFoundError(id);
    return mapSession(row);
  }

  tryGetSession(id: string): AgentSession | undefined {
    const row = getRawSqlite()
      .prepare("SELECT * FROM agent_runtime_sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  updateSession(id: string, patch: Partial<AgentSession>): AgentSession {
    const { current, next } = runtimeTransaction(() => {
      const current = this.getSession(id);
      const next = { ...current, ...patch };
      this.upsertSession(next);
      if (versionedSession(id))
        versionRepository().session(id, historySessionFields(next));
      return { current, next };
    });
    const notify = () => {
      const actual = this.tryGetSession(id);
      if (!actual) return;
      const currentPatch = Object.fromEntries(
        Object.keys(patch).map((key) => [
          key,
          actual[key as keyof AgentSession],
        ]),
      );
      emitRuntimeBusEvent({
        type: "session_changed",
        sessionId: id,
        patch: currentPatch,
      });
      if (
        patch.status &&
        patch.status !== current.status &&
        actual.status === patch.status
      ) {
        void sessionHooks.emit({
          type: "session:status_changed",
          sessionId: id,
          from: current.status,
          to: actual.status,
          patch: currentPatch,
        });
      }
    };
    if (getRawSqlite().inTransaction)
      queueMicrotask(() => {
        try {
          notify();
        } catch (error) {
          logger.debug(
            { id, error },
            "[session-store] deferred notification unavailable",
          );
        }
      });
    else notify();
    return next;
  }

  updateSessionMetadata(
    sessionId: string,
    patch: Record<string, unknown>,
  ): AgentSession {
    return runtimeTransaction(() => {
      const current = this.getSession(sessionId);
      const next = { ...(current.sessionMetadata ?? {}), ...patch };
      return this.updateSession(sessionId, { sessionMetadata: next });
    });
  }

  /** Minimal projection for badge counts: three columns per row, no metadata. */
  listSessionBadges(projectIds: string[]): Array<{
    id: string;
    projectId: string;
    status: AgentSession["status"];
    updatedAt: string;
  }> {
    if (projectIds.length === 0) return [];
    const placeholders = projectIds.map(() => "?").join(",");
    const rows = getRawSqlite()
      .prepare(
        `SELECT id, project_id, status, updated_at FROM agent_runtime_sessions WHERE project_id IN (${placeholders})`,
      )
      .all(...projectIds) as Array<{
      id: string;
      project_id: string;
      status: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      status: normalizeAgentSessionStatus(row.status),
      updatedAt: row.updated_at,
    }));
  }

  // Filters and limit are pushed into SQL; only mapSession() passthrough columns
  // (project_id, node_id, status) may be filtered here, and truthiness must match
  // the previous JS guards. Ordering stays updated_at DESC.
  listSessions(
    filter: {
      projectId?: string;
      nodeId?: string;
      status?: string;
      limit?: number;
    } = {},
  ): AgentSession[] {
    const db = getRawSqlite();
    const conditions: string[] = [];
    const params: string[] = [];
    // Truthiness matches the previous `!filter.x || ...` JS guards, which also
    // skipped empty-string filters.
    if (filter.projectId) {
      conditions.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.nodeId) {
      conditions.push("node_id = ?");
      params.push(filter.nodeId);
    }
    if (filter.status) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    const where =
      conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const baseQuery = `SELECT * FROM agent_runtime_sessions${where} ORDER BY updated_at DESC`;

    const limit = filter.limit ?? 50;
    // Mirror Array#slice(0, limit): NaN/-Infinity clamp to 0, +Infinity means
    // "no bound", and a negative bound keeps all but the last |limit| rows.
    if (Number.isNaN(limit) || limit === Number.NEGATIVE_INFINITY) return [];
    if (!Number.isFinite(limit)) {
      return (db.prepare(baseQuery).all(...params) as SessionRow[]).map(
        mapSession,
      );
    }
    const bounded = Math.trunc(limit);
    if (bounded === 0) return [];
    if (bounded < 0) {
      const rows = db.prepare(baseQuery).all(...params) as SessionRow[];
      return rows.map(mapSession).slice(0, bounded);
    }
    const rows = db
      .prepare(`${baseQuery} LIMIT ?`)
      .all(...params, bounded) as SessionRow[];
    return rows.map(mapSession);
  }

  // status filter/order/paging run in SQL over PROJECTED_STATUS_SQL. `items` stay
  // unprojected so the caller still applies projectSessionState (which also sets
  // blockedReason); countByStatus partitions the filtered set, so totalCount is exact.
  listSessionsPage(
    filter: { projectId?: string; nodeId?: string; status?: string } = {},
    page: { limit: number; offset: number } = { limit: 50, offset: 0 },
  ): {
    items: AgentSession[];
    totalCount: number;
    countByStatus: Record<string, number>;
  } {
    const db = getRawSqlite();
    const conditions: string[] = [];
    const baseParams: string[] = [];
    if (filter.projectId) {
      conditions.push("project_id = ?");
      baseParams.push(filter.projectId);
    }
    if (filter.nodeId) {
      conditions.push("node_id = ?");
      baseParams.push(filter.nodeId);
    }
    const where =
      conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const projected = `SELECT *, ${PROJECTED_STATUS_SQL} AS projected_status FROM agent_runtime_sessions${where}`;
    const statusFilter = filter.status ? " WHERE projected_status = ?" : "";
    const statusParams = filter.status ? [filter.status] : [];

    const countRows = db
      .prepare(
        `SELECT projected_status, COUNT(*) AS count, MAX(updated_at) AS latest_at
           FROM (${projected})${statusFilter}
          GROUP BY projected_status
          ORDER BY latest_at DESC, projected_status`,
      )
      .all(...baseParams, ...statusParams) as Array<{
      projected_status: string;
      count: number;
      latest_at: string;
    }>;
    const countByStatus: Record<string, number> = {};
    let totalCount = 0;
    for (const row of countRows) {
      countByStatus[row.projected_status] = row.count;
      totalCount += row.count;
    }

    // Mirror slice(offset, offset + limit): a non-positive window yields no rows
    // (SQLite treats LIMIT -1 as "unbounded", so guard before it reaches SQL).
    const offset = Number.isFinite(page.offset)
      ? Math.max(0, Math.trunc(page.offset))
      : 0;
    const limit = Number.isFinite(page.limit) ? Math.trunc(page.limit) : 0;
    const items =
      limit > 0
        ? (
            db
              .prepare(
                `SELECT * FROM (${projected})${statusFilter} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
              )
              .all(
                ...baseParams,
                ...statusParams,
                limit,
                offset,
              ) as SessionRow[]
          ).map(mapSession)
        : [];
    return { items, totalCount, countByStatus };
  }

  // Root first, then descendants in the previous walk's pre-order. Descendants come
  // from SESSION_TREE_CTE so unrelated sessions are never read; children are ordered
  // by the same updated_at DESC stream the old full-table query used, then the
  // in-memory visit() replays the exact child ordering.
  listSessionTree(sessionId: string): AgentSession[] {
    const rows = getRawSqlite()
      .prepare(
        `${SESSION_TREE_CTE}
         SELECT s.* FROM session_tree t CROSS JOIN agent_runtime_sessions s
         WHERE s.id = t.id
         ORDER BY s.updated_at DESC`,
      )
      .all(sessionId) as SessionRow[];
    // The anchor row is the root, so an empty result means the root is absent.
    if (rows.length === 0) throw new AgentNotFoundError(sessionId);

    const sessions = rows.map(mapSession);
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const childrenByParent = new Map<string, Set<string>>();
    for (const session of sessions) {
      if (!session.parentSessionId) continue;
      const childIds =
        childrenByParent.get(session.parentSessionId) ?? new Set<string>();
      childIds.add(session.id);
      childrenByParent.set(session.parentSessionId, childIds);
    }

    const root = byId.get(sessionId);
    if (!root) throw new AgentNotFoundError(sessionId);

    const ordered: AgentSession[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      const session = byId.get(id);
      if (!session) return;
      seen.add(id);
      ordered.push(session);
      const childIds = new Set<string>(session.childSessionIds);
      for (const childId of childrenByParent.get(id) ?? [])
        childIds.add(childId);
      for (const childId of childIds) visit(childId);
    };

    visit(root.id);
    return ordered;
  }

  deleteSessionTree(sessionId: string): string[] {
    if (versionedSession(sessionId))
      throw new AgentRuntimeError(
        "Versioned session deletion is not integrated yet.",
        "VERSION_RUNTIME_NOT_READY",
        409,
      );
    const sessionsToDelete = this.listSessionTree(sessionId);
    const deleteIds = sessionsToDelete.map((session) => session.id);
    const deleteSet = new Set(deleteIds);
    const contextBundleIds = new Set(
      sessionsToDelete
        .map((session) => session.contextSnapshotId)
        .filter((id): id is string => Boolean(id)),
    );
    const survivors = this.listSessions({
      limit: Number.MAX_SAFE_INTEGER,
    }).filter((session) => !deleteSet.has(session.id));
    const db = getRawSqlite();
    const tx = db.transaction(() => {
      for (const id of deleteIds) {
        db.prepare(
          "DELETE FROM conversation_history_tracking WHERE session_id=?",
        ).run(id);
        db.prepare(
          "DELETE FROM conversation_history_journal WHERE session_id=?",
        ).run(id);
        db.prepare(
          "DELETE FROM conversation_history_access WHERE session_id=?",
        ).run(id);
        db.prepare(
          "DELETE FROM conversation_mutations WHERE session_id=? OR owner_session_id=?",
        ).run(id, id);
      }
      const deletedAt = nowIso();
      for (const survivor of survivors) {
        const nextParentSessionId =
          survivor.parentSessionId && deleteSet.has(survivor.parentSessionId)
            ? null
            : survivor.parentSessionId;
        const nextChildSessionIds = survivor.childSessionIds.filter(
          (childId) => !deleteSet.has(childId),
        );
        if (
          nextParentSessionId === survivor.parentSessionId &&
          nextChildSessionIds.length === survivor.childSessionIds.length
        ) {
          continue;
        }
        this.upsertSession({
          ...survivor,
          parentSessionId: nextParentSessionId,
          childSessionIds: nextChildSessionIds,
          updatedAt: deletedAt,
        });
      }

      for (const id of deleteIds) {
        db.prepare(
          "DELETE FROM conversation_checkpoints WHERE session_id=?",
        ).run(id);
        db.prepare(
          "DELETE FROM conversation_history_versions WHERE session_id=?",
        ).run(id);
      }
      for (const id of deleteIds)
        db.prepare(
          "UPDATE agent_runtime_processes SET session_id = NULL WHERE session_id = ?",
        ).run(id);
      for (const id of deleteIds)
        db.prepare(
          "DELETE FROM agent_runtime_asset_sessions WHERE session_id=?",
        ).run(id);
      const deleteStream = db.prepare(
        "DELETE FROM agent_runtime_stream_records WHERE session_id = ?",
      );
      for (const id of deleteIds) deleteStream.run(id);
      const deleteWork = db.prepare(
        "DELETE FROM agent_runtime_work WHERE session_id = ?",
      );
      const deleteAuxUsage = db.prepare(
        "DELETE FROM agent_runtime_aux_usage WHERE session_id = ?",
      );
      const deleteInteractions = db.prepare(
        "DELETE FROM agent_runtime_interactions WHERE session_id = ?",
      );
      for (const id of deleteIds) deleteInteractions.run(id);
      const deleteRunPartsBySession = db.prepare(
        "DELETE FROM agent_runtime_run_parts WHERE session_id = ?",
      );
      const deleteRunStepsBySession = db.prepare(
        "DELETE FROM agent_runtime_run_steps WHERE session_id = ?",
      );
      const deleteRunsBySession = db.prepare(
        "DELETE FROM agent_runtime_runs WHERE session_id = ?",
      );
      const deleteThinkingBySession = db.prepare(
        "DELETE FROM agent_runtime_thinking_summaries WHERE session_id = ?",
      );
      const deleteCompactionBySession = db.prepare(
        "DELETE FROM agent_runtime_compaction_summaries WHERE session_id = ?",
      );
      const deleteContextBundlesBySession = db.prepare(
        "DELETE FROM agent_runtime_context_bundles WHERE session_id = ?",
      );
      const deleteArtifactsBySession = db.prepare(
        "DELETE FROM agent_runtime_artifacts WHERE session_id = ?",
      );
      const deletePermissionsBySession = db.prepare(
        "DELETE FROM agent_runtime_permissions WHERE session_id = ?",
      );
      const deleteToolCallsBySession = db.prepare(
        "DELETE FROM agent_runtime_tool_calls WHERE session_id = ?",
      );
      const deleteEventsBySession = db.prepare(
        "DELETE FROM agent_runtime_events WHERE session_id = ?",
      );
      const deleteMessagesBySession = db.prepare(
        "DELETE FROM agent_runtime_messages WHERE session_id = ?",
      );
      const deleteSessionById = db.prepare(
        "DELETE FROM agent_runtime_sessions WHERE id = ?",
      );
      const deleteContextBundleById = db.prepare(
        "DELETE FROM agent_runtime_context_bundles WHERE id = ?",
      );

      for (const id of deleteIds) {
        deleteRunPartsBySession.run(id);
        deleteRunStepsBySession.run(id);
        deleteRunsBySession.run(id);
        deleteThinkingBySession.run(id);
        deleteCompactionBySession.run(id);
        deleteContextBundlesBySession.run(id);
        deleteArtifactsBySession.run(id);
        deletePermissionsBySession.run(id);
        deleteToolCallsBySession.run(id);
        deleteEventsBySession.run(id);
        deleteMessagesBySession.run(id);
        deleteWork.run(id);
        deleteAuxUsage.run(id);
        deleteSessionById.run(id);
      }

      for (const bundleId of contextBundleIds) {
        deleteContextBundleById.run(bundleId);
      }
    });
    tx();
    for (const id of deleteIds) {
      emitRuntimeBusEvent({ type: "session_deleted", sessionId: id });
    }
    void import("./checkpoints/gc.js")
      .then(({ pruneCheckpointBlobs }) => pruneCheckpointBlobs())
      .catch(() => {});
    return deleteIds;
  }

  appendMessage(message: AgentRuntimeMessage): AgentRuntimeMessage {
    if (versionedSession(message.sessionId)) {
      return getRawSqlite().transaction(() => {
        if (message.contentParts)
          bindAssets(message.sessionId, message.contentParts);
        versionRepository().put(
          message.sessionId,
          "messages",
          message.id,
          message as unknown as Record<string, unknown>,
        );
        if (message.contentParts)
          retainVersionRecordAssets(
            message.sessionId,
            "messages",
            message.id,
            message.contentParts,
          );
        return message;
      })();
    }
    const session = this.getSession(message.sessionId);
    const nextSequence = this.nextMessageSequence(message.sessionId);
    if (message.contentParts)
      bindAssets(message.sessionId, message.contentParts);
    getRawSqlite()
      .prepare(
        `INSERT OR REPLACE INTO agent_runtime_messages
         (id, session_id, project_id, sequence, turn_id, run_id, step_id, role, content, provider_id, model_id, tool_call_id, usage_json, metadata_json, created_at, content_parts_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        session.projectId,
        nextSequence,
        null,
        message.runId,
        message.stepId,
        message.role,
        message.content,
        null,
        null,
        null,
        stringify(message.metadata?.usage ?? {}),
        stringify(message.metadata),
        message.createdAt,
        message.contentParts ? stringify(message.contentParts) : null,
      );
    return message;
  }

  getMessage(
    sessionId: string,
    messageId: string,
  ): AgentRuntimeMessage | undefined {
    if (versionedSession(sessionId))
      return versionRepository().get(
        sessionId,
        "messages",
        messageId,
      ) as unknown as AgentRuntimeMessage | undefined;
    const row = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_messages WHERE id = ? AND session_id = ?",
      )
      .get(messageId, sessionId) as MessageRow | undefined;
    return row ? mapMessage(row) : undefined;
  }

  /** Attach an inline reply without REPLACE, sequence changes or stale-message resurrection. */
  attachVisualizationMetadata(
    message: AgentRuntimeMessage,
    additions: Record<string, unknown>,
  ): AgentRuntimeMessage | undefined {
    const sqlite = getRawSqlite();
    return sqlite.transaction(() => {
      const current = this.getMessage(message.sessionId, message.id);
      if (
        !current ||
        current.role !== "assistant" ||
        current.content !== message.content ||
        current.metadata.partial
      )
        return undefined;
      if (current.metadata.source === "inline_visualization") return current;
      const metadata = { ...current.metadata, ...additions };
      sqlite
        .prepare(
          "UPDATE agent_runtime_messages SET metadata_json = ? WHERE id = ? AND session_id = ?",
        )
        .run(stringify(metadata), message.id, message.sessionId);
      return { ...current, metadata };
    })();
  }

  listMessages(sessionId: string): AgentRuntimeMessage[] {
    if (versionedSession(sessionId))
      return versionedList<AgentRuntimeMessage>(sessionId, "messages");
    const rows = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_messages WHERE session_id = ? ORDER BY sequence, created_at, rowid",
      )
      .all(sessionId) as MessageRow[];
    return rows.map(mapMessage);
  }

  /** One durable, bounded burst; never accepts mixed-session writes. */
  appendEvents(events: readonly RuntimeEvent[]): RuntimeEvent[] {
    if (!Array.isArray(events) || events.length > 256)
      throw new AgentRuntimeError(
        "Event batch row limit exceeded.",
        "VERSION_BATCH_LIMIT",
        413,
      );
    assertBatchInput(events);
    if (!events.length) return [];
    const sessionId = events[0].sessionId;
    if (events.some((event) => event.sessionId !== sessionId))
      throw new AgentRuntimeError(
        "Event batch must belong to one session.",
        "VERSION_BATCH_SESSION",
        409,
      );
    return getRawSqlite().transaction(() => {
      this.getSession(sessionId);
      if (versionedSession(sessionId)) {
        versionRepository().putBatch(
          sessionId,
          events.map((event) => ({
            table: "events",
            id: event.id,
            fields: event as unknown as Record<string, unknown>,
          })),
        );
      } else {
        const insert = getRawSqlite().prepare(
          "INSERT OR REPLACE INTO agent_runtime_events(id,session_id,type,timestamp,visibility,summary,payload_json) VALUES(?,?,?,?,?,?,?)",
        );
        for (const event of events)
          insert.run(
            event.id,
            event.sessionId,
            event.type,
            event.timestamp,
            event.visibility,
            event.summary,
            stringify(event.payload),
          );
      }
      return [...events];
    })();
  }

  appendEvent(event: RuntimeEvent): RuntimeEvent {
    if (versionedSession(event.sessionId)) {
      versionRepository().put(
        event.sessionId,
        "events",
        event.id,
        event as unknown as Record<string, unknown>,
      );
      return event;
    }
    getRawSqlite()
      .prepare(
        `INSERT OR REPLACE INTO agent_runtime_events
         (id, session_id, type, timestamp, visibility, summary, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.sessionId,
        event.type,
        event.timestamp,
        event.visibility,
        event.summary,
        stringify(event.payload),
      );
    return event;
  }

  listEvents(sessionId: string, after?: string): RuntimeEvent[] {
    if (versionedSession(sessionId)) {
      const items = versionedList<RuntimeEvent>(sessionId, "events");
      return after
        ? items.slice(
            Math.max(0, items.findIndex((event) => event.id === after) + 1),
          )
        : items;
    }
    const db = getRawSqlite();
    if (after) {
      // Incremental fetch: only read rows after the caller's cursor instead of
      // materializing (and JSON-parsing) the whole event log on every poll.
      const rows = db
        .prepare(
          `SELECT * FROM agent_runtime_events
           WHERE session_id = ?
             AND rowid > COALESCE((SELECT rowid FROM agent_runtime_events WHERE id = ?), 0)
           ORDER BY rowid`,
        )
        .all(sessionId, after) as EventRow[];
      return rows.map(mapEvent);
    }
    const rows = db
      .prepare(
        "SELECT * FROM agent_runtime_events WHERE session_id = ? ORDER BY rowid",
      )
      .all(sessionId) as EventRow[];
    return rows.map(mapEvent);
  }

  /** Latest event of a given type, without loading the whole event log. */
  getLatestEventByType(
    sessionId: string,
    type: RuntimeEvent["type"],
  ): RuntimeEvent | null {
    return this.getLatestEventOfTypes(sessionId, [type]);
  }

  /** Latest event matching any of the given types. */
  getLatestEventOfTypes(
    sessionId: string,
    types: RuntimeEvent["type"][],
  ): RuntimeEvent | null {
    if (types.length === 0) return null;
    if (versionedSession(sessionId))
      return versionRepository().latestEvent(
        sessionId,
        types,
      ) as unknown as RuntimeEvent | null;
    const placeholders = types.map(() => "?").join(", ");
    const row = getRawSqlite()
      .prepare(
        `SELECT * FROM agent_runtime_events
         WHERE session_id = ? AND type IN (${placeholders})
         ORDER BY rowid DESC
         LIMIT 1`,
      )
      .get(sessionId, ...types) as EventRow | undefined;
    return row ? mapEvent(row) : null;
  }

  /** Count events of `type` recorded after `eventId` (rowid ordered). */
  countEventsAfter(
    sessionId: string,
    eventId: string,
    type: RuntimeEvent["type"],
  ): number {
    if (versionedSession(sessionId))
      return versionRepository().countEventsAfter(sessionId, eventId, type);
    const row = getRawSqlite()
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_runtime_events
         WHERE session_id = ? AND type = ?
           AND rowid > COALESCE((SELECT rowid FROM agent_runtime_events WHERE id = ?), 0)`,
      )
      .get(sessionId, type, eventId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  appendRun(run: AgentRun): AgentRun {
    const writeControl = (): AgentRun => {
      getRawSqlite()
        .prepare(
          `INSERT OR REPLACE INTO agent_runtime_runs
         (id, session_id, status, started_at, completed_at, trigger_message_id, current_step, stop_reason, model, metadata_json,version_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT epoch FROM conversation_v3_heads WHERE session_id=?))`,
        )
        .run(
          run.id,
          run.sessionId,
          run.status,
          run.startedAt,
          run.completedAt,
          run.triggerMessageId,
          run.currentStep,
          run.stopReason,
          run.model,
          stringify(run.metadata),
          run.sessionId,
        );
      return run;
    };
    if (run.sessionId && versionedSession(run.sessionId))
      return writeVersionEntity(
        run.sessionId,
        "runs",
        run.id,
        run,
        writeControl,
      );
    return writeControl();
  }

  getRun(runId: string): AgentRun {
    const row = getRawSqlite()
      .prepare("SELECT * FROM agent_runtime_runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    if (!row) throw new AgentNotFoundError(runId);
    return versionedSession(row.session_id)
      ? readVersionEntity<AgentRun>(row.session_id, "runs", runId, mapRun(row))
      : mapRun(row);
  }

  updateRun(runId: string, patch: Partial<AgentRun>): AgentRun {
    const current = this.getRun(runId);
    const next = { ...current, ...patch };
    return this.appendRun(next);
  }

  listRuns(sessionId: string): AgentRun[] {
    if (versionedSession(sessionId))
      return listVersionEntities<AgentRun>(sessionId, "runs").sort(
        (a, b) =>
          b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
      );
    const rows = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC",
      )
      .all(sessionId) as RunRow[];
    return rows.map(mapRun);
  }

  appendRunStep(step: AgentRunStep): AgentRunStep {
    const writeControl = (): AgentRunStep => {
      getRawSqlite()
        .prepare(
          `INSERT INTO agent_runtime_run_steps
         (id, run_id, session_id, step_index, status, model, started_at, completed_at, finish_reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           run_id=excluded.run_id, session_id=excluded.session_id, step_index=excluded.step_index,
           status=excluded.status, model=excluded.model, started_at=excluded.started_at,
           completed_at=excluded.completed_at, finish_reason=excluded.finish_reason, metadata_json=excluded.metadata_json`,
        )
        .run(
          step.id,
          step.runId,
          step.sessionId,
          step.index,
          step.status,
          step.model,
          step.startedAt,
          step.completedAt,
          step.finishReason,
          stringify(step.metadata),
        );
      return step;
    };
    if (step.sessionId && versionedSession(step.sessionId))
      return writeVersionEntity(
        step.sessionId,
        "steps",
        step.id,
        step,
        writeControl,
      );
    return writeControl();
  }

  getRunStep(stepId: string): AgentRunStep {
    const row = getRawSqlite()
      .prepare("SELECT * FROM agent_runtime_run_steps WHERE id = ?")
      .get(stepId) as RunStepRow | undefined;
    if (!row) throw new AgentNotFoundError(stepId);
    return versionedSession(row.session_id)
      ? readVersionEntity<AgentRunStep>(row.session_id, "steps", stepId)
      : mapRunStep(row);
  }

  updateRunStep(stepId: string, patch: Partial<AgentRunStep>): AgentRunStep {
    const current = this.getRunStep(stepId);
    const next = { ...current, ...patch };
    return this.appendRunStep(next);
  }

  listRunSteps(runId: string): AgentRunStep[] {
    const owner = entityScope("runs", runId);
    if (owner) {
      this.getRun(runId);
      return listVersionEntities<AgentRunStep>(owner, "steps", {
        field: "runId",
        value: runId,
      }).sort((a, b) => a.index - b.index);
    }
    const rows = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_run_steps WHERE run_id = ? ORDER BY step_index, rowid",
      )
      .all(runId) as RunStepRow[];
    return rows.map(mapRunStep);
  }

  listSessionSteps(sessionId: string): AgentRunStep[] {
    if (versionedSession(sessionId))
      return listVersionEntities<AgentRunStep>(sessionId, "steps");
    const rows = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_run_steps WHERE session_id = ? ORDER BY rowid",
      )
      .all(sessionId) as RunStepRow[];
    return rows.map(mapRunStep);
  }

  appendRunPart(part: AgentRunPart): AgentRunPart {
    const writeControl = (): AgentRunPart => {
      getRawSqlite()
        .prepare(
          `INSERT OR REPLACE INTO agent_runtime_run_parts
         (id, run_id, step_id, session_id, kind, sequence, content, tool_call_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          part.id,
          part.runId,
          part.stepId,
          part.sessionId,
          part.kind,
          part.sequence,
          part.content,
          part.toolCallId,
          stringify(part.metadata),
          part.createdAt,
        );
      return part;
    };
    if (part.sessionId && versionedSession(part.sessionId))
      return writeVersionEntity(
        part.sessionId,
        "parts",
        part.id,
        part,
        writeControl,
      );
    return writeControl();
  }

  listRunParts(stepId: string): AgentRunPart[] {
    const owner = entityScope("steps", stepId);
    if (owner) {
      this.getRunStep(stepId);
      return listVersionEntities<AgentRunPart>(owner, "parts", {
        field: "stepId",
        value: stepId,
      }).sort((a, b) => a.sequence - b.sequence);
    }
    const rows = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_run_parts WHERE step_id = ? ORDER BY sequence, rowid",
      )
      .all(stepId) as RunPartRow[];
    return rows.map(mapRunPart);
  }

  nextRunPartSequence(stepId: string): number {
    const owner = entityScope("steps", stepId);
    if (owner)
      return (
        this.listRunParts(stepId).reduce(
          (n, part) => Math.max(n, part.sequence),
          0,
        ) + 1
      );
    const row = getRawSqlite()
      .prepare(
        "SELECT MAX(sequence) AS max_sequence FROM agent_runtime_run_parts WHERE step_id = ?",
      )
      .get(stepId) as { max_sequence: number | null } | undefined;
    return (row?.max_sequence ?? 0) + 1;
  }

  appendToolCall(record: ToolCallRecord): ToolCallRecord {
    const writeControl = (): ToolCallRecord => {
      if (record.contentParts)
        bindAssets(record.sessionId, record.contentParts);
      getRawSqlite()
        .prepare(
          `INSERT OR REPLACE INTO agent_runtime_tool_calls
         (id, session_id, run_id, step_id, model_tool_call_id, tool_id, category, mutability, args_hash, input_summary,
          input_ref_json, output_summary, output_ref_json, status, permission_decision_id, started_at, ended_at, error, content_parts_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.sessionId,
          record.runId,
          record.stepId,
          record.modelToolCallId,
          record.toolId,
          record.category,
          record.mutability,
          record.argsHash,
          record.inputSummary,
          record.inputRef === null ? null : stringify(record.inputRef),
          record.outputSummary,
          record.outputRef === null ? null : stringify(record.outputRef),
          record.status,
          record.permissionDecisionId,
          record.startedAt,
          record.endedAt,
          record.error,
          record.contentParts ? stringify(record.contentParts) : null,
        );
      return record;
    };
    if (record.sessionId && versionedSession(record.sessionId))
      return writeVersionEntity(
        record.sessionId,
        "tools",
        record.id,
        record,
        writeControl,
      );
    return writeControl();
  }

  updateToolCall(
    sessionId: string,
    toolCallId: string,
    patch: Partial<ToolCallRecord>,
  ): ToolCallRecord {
    const current = this.getToolCall(sessionId, toolCallId);
    const next = { ...current, ...patch };
    return this.appendToolCall(next);
  }

  getToolCall(sessionId: string, toolCallId: string): ToolCallRecord {
    const row = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_tool_calls WHERE session_id = ? AND id = ? LIMIT 1",
      )
      .get(sessionId, toolCallId) as ToolCallRow | undefined;
    if (!row) throw new AgentNotFoundError(toolCallId);
    return versionedSession(sessionId)
      ? readVersionEntity<ToolCallRecord>(sessionId, "tools", toolCallId)
      : mapToolCall(row);
  }

  listToolCalls(sessionId: string): ToolCallRecord[] {
    if (versionedSession(sessionId))
      return listVersionEntities<ToolCallRecord>(sessionId, "tools");
    const rows = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_tool_calls WHERE session_id = ? ORDER BY rowid",
      )
      .all(sessionId) as ToolCallRow[];
    return rows.map(mapToolCall);
  }

  listRunToolCalls(runId: string): ToolCallRecord[] {
    const owner = entityScope("runs", runId);
    if (owner) {
      this.getRun(runId);
      return listVersionEntities<ToolCallRecord>(owner, "tools", {
        field: "runId",
        value: runId,
      });
    }
    const rows = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_tool_calls WHERE run_id = ? ORDER BY rowid",
      )
      .all(runId) as ToolCallRow[];
    return rows.map(mapToolCall);
  }

  appendPermission(decision: PermissionDecision): PermissionDecision {
    const writeControl = (): PermissionDecision => {
      getRawSqlite()
        .prepare(
          `INSERT OR REPLACE INTO agent_runtime_permissions
         (id, session_id, run_id, step_id, tool_call_id, coarse_category, internal_gate, action, reason,
          patterns_json, user_reply, created_at, resolved_at, resume_token, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decision.id,
          decision.sessionId,
          decision.runId,
          decision.stepId,
          decision.toolCallId,
          decision.coarseCategory,
          decision.internalGate,
          decision.action,
          decision.reason,
          stringify(decision.patterns),
          decision.userReply,
          decision.createdAt,
          decision.resolvedAt,
          decision.resumeToken,
          stringify(decision.metadata),
        );
      return decision;
    };
    if (decision.sessionId && versionedSession(decision.sessionId))
      return writeVersionEntity(
        decision.sessionId,
        "permissions",
        decision.id,
        decision,
        writeControl,
      );
    return writeControl();
  }

  updatePermission(
    sessionId: string,
    permissionId: string,
    patch: Partial<PermissionDecision>,
  ): PermissionDecision {
    const current = this.listPermissions(sessionId).find(
      (item) => item.id === permissionId,
    );
    if (!current) throw new AgentNotFoundError(permissionId);
    const next = { ...current, ...patch };
    return this.appendPermission(next);
  }

  listPermissions(sessionId: string): PermissionDecision[] {
    if (versionedSession(sessionId))
      return listVersionEntities<PermissionDecision>(sessionId, "permissions");
    const rows = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_permissions WHERE session_id = ? ORDER BY rowid",
      )
      .all(sessionId) as PermissionRow[];
    return rows.map(mapPermission);
  }

  findPermissionByResumeToken(
    sessionId: string,
    resumeToken: string,
  ): PermissionDecision | undefined {
    if (versionedSession(sessionId))
      return this.listPermissions(sessionId).find(
        (row) => row.resumeToken === resumeToken,
      );
    const row = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_permissions WHERE session_id = ? AND resume_token = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(sessionId, resumeToken) as PermissionRow | undefined;
    return row ? mapPermission(row) : undefined;
  }

  appendArtifact(artifact: EvidenceArtifact): EvidenceArtifact {
    const writeControl = (): EvidenceArtifact => {
      getRawSqlite()
        .prepare(
          `INSERT OR REPLACE INTO agent_runtime_artifacts
         (id, session_id, kind, title, summary, source_refs_json, risk, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.id,
          artifact.sessionId,
          artifact.kind,
          artifact.title,
          artifact.summary,
          stringify(artifact.sourceRefs),
          artifact.risk,
          stringify(artifact.metadata ?? {}),
          artifact.createdAt,
        );
      return artifact;
    };
    if (artifact.sessionId && versionedSession(artifact.sessionId))
      return writeVersionEntity(
        artifact.sessionId,
        "artifacts",
        artifact.id,
        artifact,
        writeControl,
      );
    return writeControl();
  }

  listArtifacts(sessionId: string): EvidenceArtifact[] {
    if (versionedSession(sessionId))
      return listVersionEntities<EvidenceArtifact>(sessionId, "artifacts");
    const rows = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_artifacts WHERE session_id = ? ORDER BY rowid",
      )
      .all(sessionId) as ArtifactRow[];
    return rows.map(mapArtifact);
  }

  saveContextBundle(bundle: AgentContextBundle): AgentContextBundle {
    const writeControl = (): AgentContextBundle => {
      getRawSqlite()
        .prepare(
          `INSERT OR REPLACE INTO agent_runtime_context_bundles
         (id, project_id, session_id, node_id, profile_id, blocks_json, citations_json, warnings_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bundle.id,
          bundle.projectId,
          bundle.sessionId,
          bundle.nodeId,
          bundle.profileId,
          stringify(bundle.blocks),
          stringify(bundle.citations),
          stringify(bundle.warnings),
          bundle.createdAt,
        );
      return bundle;
    };
    if (bundle.sessionId && versionedSession(bundle.sessionId))
      return writeVersionEntity(
        bundle.sessionId,
        "contexts",
        bundle.id,
        bundle,
        writeControl,
      );
    return writeControl();
  }

  getContextBundle(id: string): AgentContextBundle {
    const row = getRawSqlite()
      .prepare("SELECT * FROM agent_runtime_context_bundles WHERE id = ?")
      .get(id) as ContextBundleRow | undefined;
    if (!row) throw new AgentNotFoundError(id);
    return row.session_id && versionedSession(row.session_id)
      ? readVersionEntity<AgentContextBundle>(row.session_id, "contexts", id)
      : mapContextBundle(row);
  }

  saveThinkingSummary(summary: ThinkingSummary): ThinkingSummary {
    const writeControl = (): ThinkingSummary => {
      getRawSqlite()
        .prepare(
          `INSERT OR REPLACE INTO agent_runtime_thinking_summaries
         (id, session_id, mode, framing, evidence_used_json, decision, assumptions_json, risks_json, next_steps_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          summary.id,
          summary.sessionId,
          summary.mode,
          summary.framing,
          stringify(summary.evidenceUsed),
          summary.decision,
          stringify(summary.assumptions),
          stringify(summary.risks),
          stringify(summary.nextSteps),
        );
      return summary;
    };
    if (summary.sessionId && versionedSession(summary.sessionId))
      return writeVersionEntity(
        summary.sessionId,
        "thinking",
        summary.id,
        summary,
        writeControl,
      );
    return writeControl();
  }

  getThinkingSummary(id: string): ThinkingSummary {
    const row = getRawSqlite()
      .prepare("SELECT * FROM agent_runtime_thinking_summaries WHERE id = ?")
      .get(id) as ThinkingSummaryRow | undefined;
    if (!row) throw new AgentNotFoundError(id);
    return versionedSession(row.session_id)
      ? readVersionEntity<ThinkingSummary>(row.session_id, "thinking", id)
      : mapThinkingSummary(row);
  }

  saveCompactionRecord(record: CompactionRecord): CompactionRecord {
    const writeControl = (): CompactionRecord => {
      getRawSqlite()
        .prepare(
          `INSERT OR REPLACE INTO agent_runtime_compaction_summaries
         (id, session_id, run_id, summary_text, compressed_message_count, original_token_count, compressed_token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.sessionId,
          record.runId,
          record.summaryText,
          record.compressedMessageCount,
          record.originalTokenCount,
          record.compressedTokenCount,
          record.createdAt,
        );
      return record;
    };
    if (record.sessionId && versionedSession(record.sessionId))
      return writeVersionEntity(
        record.sessionId,
        "compactions",
        record.id,
        record,
        writeControl,
      );
    return writeControl();
  }

  getLatestCompactionRecord(sessionId: string): CompactionRecord | null {
    if (versionedSession(sessionId))
      return (
        listVersionEntities<CompactionRecord>(sessionId, "compactions").sort(
          (a, b) => b.createdAt.localeCompare(a.createdAt),
        )[0] ?? null
      );
    const row = getRawSqlite()
      .prepare(
        "SELECT * FROM agent_runtime_compaction_summaries WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(sessionId) as
      | {
          id: string;
          session_id: string;
          run_id: string | null;
          summary_text: string;
          compressed_message_count: number;
          original_token_count: number;
          compressed_token_count: number;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      summaryText: row.summary_text,
      compressedMessageCount: row.compressed_message_count,
      originalTokenCount: row.original_token_count,
      compressedTokenCount: row.compressed_token_count,
      createdAt: row.created_at,
    };
  }

  getSessionStats(
    sessionId: string,
    options: { configuredContextLimit?: number | null } = {},
  ): {
    work: Pick<WorkRecord, "id" | "status" | "remaining" | "reason"> | null;
    roundCount: number;
    contextComposition: ContextComposition | null;
    context: SessionUsageProjection["context"];
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
    const db = getRawSqlite();

    const workRow =
      typeof session.sessionMetadata?.activeWorkId === "string"
        ? (db
            .prepare(
              "SELECT payload_json FROM agent_runtime_work WHERE id = ? AND session_id = ?",
            )
            .get(session.sessionMetadata.activeWorkId, sessionId) as
            | { payload_json: string }
            | undefined)
        : undefined;
    const currentWork = workRow
      ? (JSON.parse(workRow.payload_json) as WorkRecord)
      : null;
    const projected = projectSessionUsage(
      sessionId,
      this.listSessionTree(sessionId).map((s) => s.id),
    );
    const input = projected.context.inputTokens ?? 0;
    const output = projected.usage.self.output;
    const total = input;
    const latestContextWindowSize = projected.reportedWindow;
    const backendId = (
      session.sessionMetadata?.backend as { id?: string } | undefined
    )?.id;
    const cli = backendId === "codex" || backendId === "claude-code";
    // Native API sessions honor configured windows; CLI sessions report their own, independent policy.
    const knownWindow = cli
      ? latestContextWindowSize
      : (normalizeContextLimit(options.configuredContextLimit) ??
        readLatestRunContextLimit(db, sessionId) ??
        latestContextWindowSize);
    const contextLimitKnown = knownWindow !== null;
    const contextLimit = knownWindow ?? DEFAULT_CONTEXT_WINDOW_SIZE;
    const contextUsedPercent =
      contextLimit > 0
        ? Math.min(Math.round((input / contextLimit) * 100), 100)
        : 0;

    const roundCount = (
      db
        .prepare(
          "SELECT COUNT(*) as count FROM agent_runtime_run_steps WHERE session_id = ?",
        )
        .get(sessionId) as { count: number }
    ).count;
    const contextComposition = projected.contextComposition;

    const toolCountRow = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM agent_runtime_tool_calls WHERE session_id = ?",
      )
      .get(sessionId) as { cnt: number };
    const toolCallCount = toolCountRow?.cnt ?? 0;

    const runningDuration = projected.durationMs;

    let activeSubAgentCount = 0;
    if (session.childSessionIds.length > 0) {
      // One indexed status lookup instead of a full session read per child.
      // Missing ids are simply absent from the result, matching the previous
      // try/catch on getSession(); duplicates in childSessionIds still count
      // once per entry because we iterate the original list below.
      const childIds = [...new Set(session.childSessionIds)];
      const placeholders = childIds.map(() => "?").join(", ");
      const running = new Set(
        (
          db
            .prepare(
              `SELECT id FROM agent_runtime_sessions
               WHERE status = 'running' AND id IN (${placeholders})`,
            )
            .all(...childIds) as Array<{ id: string }>
        ).map((row) => row.id),
      );
      for (const childId of session.childSessionIds) {
        if (running.has(childId)) activeSubAgentCount++;
      }
    }

    return {
      work: currentWork
        ? {
            id: currentWork.id,
            status: currentWork.status,
            remaining: currentWork.remaining,
            reason: currentWork.reason,
          }
        : null,
      roundCount,
      contextComposition,
      context: projected.context,
      cache: projected.cache,
      usage: projected.usage,
      coverage: projected.coverage,
      tokenUsage: { input, output, total },
      contextLimit,
      contextLimitKnown,
      contextUsedPercent,
      toolCallCount,
      runningDuration,
      status: session.status,
      activeSubAgentCount,
    };
  }

  recoverOrphanedSessions(): number {
    const db = getRawSqlite();
    const now = nowIso();
    const reason = "Server restarted.";
    db.prepare(
      `UPDATE agent_runtime_run_steps
       SET status = 'interrupted', completed_at = ?, finish_reason = 'server_restarted'
       WHERE status = 'running'`,
    ).run(now);
    db.prepare(
      `UPDATE agent_runtime_runs
       SET status = 'interrupted', completed_at = ?, stop_reason = ?
       WHERE status IN ('queued', 'running', 'waiting_permission')`,
    ).run(now, reason);
    const result = db
      .prepare(
        `UPDATE agent_runtime_sessions
         SET status = 'interrupted', updated_at = ?, active_run_id = NULL, blocked_reason = ?
         WHERE status IN ('running', 'queued', 'waiting_permission')`,
      )
      .run(now, reason);
    return Number(result.changes ?? 0);
  }

  reset(): void {
    const db = getRawSqlite();
    const tx = db.transaction(() => {
      for (const table of RUNTIME_TABLES) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
    });
    tx();
  }

  hashArgs(args: unknown): string {
    return createHash("sha256").update(stringify(args)).digest("hex");
  }

  private upsertSession(session: AgentSession): void {
    getRawSqlite()
      .prepare(
        `INSERT OR REPLACE INTO agent_runtime_sessions
         (id, project_id, parent_session_id, child_session_ids_json, node_id, profile_id, status,
          title, prompt, context_snapshot_id, thinking_mode, reasoning_effort, permission_rules_json, created_at, updated_at,
          completed_at, result_summary, blocked_reason, skill_ids_json, mcp_server_ids_json, active_run_id, pending_resume_token, session_metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.projectId,
        session.parentSessionId,
        stringify(session.childSessionIds),
        session.nodeId,
        session.profileId,
        normalizeAgentSessionStatus(session.status),
        session.title,
        session.prompt,
        session.contextSnapshotId,
        session.thinkingMode,
        session.reasoningEffort ?? null,
        stringify(session.permissionRules),
        session.createdAt,
        session.updatedAt,
        session.completedAt,
        session.resultSummary,
        session.blockedReason,
        stringify(session.skillIds),
        stringify(session.mcpServerIds ?? []),
        session.activeRunId,
        session.pendingResumeToken,
        stringify(session.sessionMetadata),
      );
  }

  private nextMessageSequence(sessionId: string): number {
    const row = getRawSqlite()
      .prepare(
        "SELECT MAX(sequence) AS max_sequence FROM agent_runtime_messages WHERE session_id = ?",
      )
      .get(sessionId) as { max_sequence: number | null } | undefined;
    return (row?.max_sequence ?? 0) + 1;
  }
}

export const agentRuntimeStore = new AgentRuntimeStore();
