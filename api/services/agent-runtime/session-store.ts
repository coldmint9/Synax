import { createHash } from 'node:crypto';
import { getRawSqlite } from '../../db/index.js';
import { nowIso } from './runtime-ids.js';
import { runtimeBus } from './runtime-bus.js';
import { sessionHooks } from './session-hooks.js';
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
} from './contracts.js';
import { AgentNotFoundError } from './runtime-errors.js';

type JsonObject = Record<string, unknown>;

interface SessionRow {
  id: string;
  project_id: string;
  parent_session_id: string | null;
  child_session_ids_json: string;
  node_id: string | null;
  profile_id: string;
  status: AgentSession['status'];
  title: string | null;
  prompt: string;
  context_snapshot_id: string | null;
  thinking_mode: AgentSession['thinkingMode'];
  permission_rules_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  result_summary: string | null;
  blocked_reason: string | null;
  skill_ids_json: string;
  active_run_id: string | null;
  pending_resume_token: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  project_id: string;
  sequence: number;
  turn_id: string | null;
  run_id: string | null;
  step_id: string | null;
  role: AgentRuntimeMessage['role'];
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
  type: RuntimeEvent['type'];
  timestamp: string;
  visibility: RuntimeEvent['visibility'];
  summary: string;
  payload_json: string;
}

interface ToolCallRow {
  id: string;
  session_id: string;
  run_id: string | null;
  step_id: string | null;
  model_tool_call_id: string | null;
  tool_id: string;
  category: ToolCallRecord['category'];
  mutability: ToolCallRecord['mutability'];
  args_hash: string;
  input_summary: string;
  input_ref_json: string | null;
  output_summary: string | null;
  output_ref_json: string | null;
  status: ToolCallRecord['status'];
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
  coarse_category: PermissionDecision['coarseCategory'];
  internal_gate: PermissionDecision['internalGate'];
  action: PermissionDecision['action'];
  reason: string;
  patterns_json: string;
  user_reply: PermissionDecision['userReply'];
  created_at: string;
  resolved_at: string | null;
  resume_token: string | null;
  metadata_json: string;
}

interface ArtifactRow {
  id: string;
  session_id: string;
  kind: EvidenceArtifact['kind'];
  title: string;
  summary: string;
  source_refs_json: string;
  risk: EvidenceArtifact['risk'];
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
  mode: ThinkingSummary['mode'];
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
  status: AgentRun['status'];
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
  status: AgentRunStep['status'];
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
  kind: AgentRunPart['kind'];
  sequence: number;
  content: string;
  tool_call_id: string | null;
  metadata_json: string;
  created_at: string;
}

const RUNTIME_TABLES = [
  'agent_runtime_run_parts',
  'agent_runtime_run_steps',
  'agent_runtime_runs',
  'agent_runtime_thinking_summaries',
  'agent_runtime_compaction_summaries',
  'agent_runtime_context_bundles',
  'agent_runtime_artifacts',
  'agent_runtime_permissions',
  'agent_runtime_tool_calls',
  'agent_runtime_events',
  'agent_runtime_messages',
  'agent_runtime_sessions',
] as const;

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

function parseObject(raw: string | null | undefined): JsonObject {
  const parsed = parseJson<unknown>(raw, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
}

function mapSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    projectId: row.project_id,
    parentSessionId: row.parent_session_id,
    childSessionIds: parseArray<string>(row.child_session_ids_json),
    nodeId: row.node_id,
    profileId: row.profile_id,
    status: row.status,
    title: row.title,
    prompt: row.prompt,
    contextSnapshotId: row.context_snapshot_id,
    thinkingMode: row.thinking_mode,
    permissionRules: parseArray(row.permission_rules_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    resultSummary: row.result_summary,
    blockedReason: row.blocked_reason,
    skillIds: parseArray<string>(row.skill_ids_json),
    activeRunId: row.active_run_id,
    pendingResumeToken: row.pending_resume_token,
  };
}

function mapMessage(row: MessageRow): AgentRuntimeMessage {
  return {
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

function mapEvent(row: EventRow): RuntimeEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    timestamp: row.timestamp,
    visibility: row.visibility,
    summary: row.summary,
    payload: parseObject(row.payload_json),
  };
}

function mapToolCall(row: ToolCallRow): ToolCallRecord {
  return {
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
      .prepare('SELECT * FROM agent_runtime_sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    if (!row) throw new AgentNotFoundError(id);
    return mapSession(row);
  }

  tryGetSession(id: string): AgentSession | undefined {
    const row = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  updateSession(id: string, patch: Partial<AgentSession>): AgentSession {
    const current = this.getSession(id);
    const next = { ...current, ...patch };
    this.upsertSession(next);
    runtimeBus.emit({ type: 'session_changed', sessionId: id, patch: patch as Record<string, unknown> });
    if (patch.status && patch.status !== current.status) {
      void sessionHooks.emit({ type: 'session:status_changed', sessionId: id, from: current.status, to: patch.status, patch: patch as Record<string, unknown> });
    }
    return next;
  }

  listSessions(filter: { projectId?: string; nodeId?: string; status?: string; limit?: number } = {}): AgentSession[] {
    const rows = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_sessions ORDER BY updated_at DESC')
      .all() as SessionRow[];
    return rows
      .map(mapSession)
      .filter((session) => !filter.projectId || session.projectId === filter.projectId)
      .filter((session) => !filter.nodeId || session.nodeId === filter.nodeId)
      .filter((session) => !filter.status || session.status === filter.status)
      .slice(0, filter.limit ?? 50);
  }

  listSessionTree(sessionId: string): AgentSession[] {
    const sessions = this.listSessions({ limit: Number.MAX_SAFE_INTEGER });
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const childrenByParent = new Map<string, Set<string>>();
    for (const session of sessions) {
      if (!session.parentSessionId) continue;
      const childIds = childrenByParent.get(session.parentSessionId) ?? new Set<string>();
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
      for (const childId of childrenByParent.get(id) ?? []) childIds.add(childId);
      for (const childId of childIds) visit(childId);
    };

    visit(root.id);
    return ordered;
  }

  deleteSessionTree(sessionId: string): string[] {
    const sessionsToDelete = this.listSessionTree(sessionId);
    const deleteIds = sessionsToDelete.map((session) => session.id);
    const deleteSet = new Set(deleteIds);
    const contextBundleIds = new Set(
      sessionsToDelete
        .map((session) => session.contextSnapshotId)
        .filter((id): id is string => Boolean(id)),
    );
    const survivors = this.listSessions({ limit: Number.MAX_SAFE_INTEGER }).filter(
      (session) => !deleteSet.has(session.id),
    );
    const db = getRawSqlite();
    const tx = db.transaction(() => {
      const deletedAt = nowIso();
      for (const survivor of survivors) {
        const nextParentSessionId =
          survivor.parentSessionId && deleteSet.has(survivor.parentSessionId)
            ? null
            : survivor.parentSessionId;
        const nextChildSessionIds = survivor.childSessionIds.filter((childId) => !deleteSet.has(childId));
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

      const deleteRunPartsBySession = db.prepare('DELETE FROM agent_runtime_run_parts WHERE session_id = ?');
      const deleteRunStepsBySession = db.prepare('DELETE FROM agent_runtime_run_steps WHERE session_id = ?');
      const deleteRunsBySession = db.prepare('DELETE FROM agent_runtime_runs WHERE session_id = ?');
      const deleteThinkingBySession = db.prepare('DELETE FROM agent_runtime_thinking_summaries WHERE session_id = ?');
      const deleteCompactionBySession = db.prepare('DELETE FROM agent_runtime_compaction_summaries WHERE session_id = ?');
      const deleteContextBundlesBySession = db.prepare('DELETE FROM agent_runtime_context_bundles WHERE session_id = ?');
      const deleteArtifactsBySession = db.prepare('DELETE FROM agent_runtime_artifacts WHERE session_id = ?');
      const deletePermissionsBySession = db.prepare('DELETE FROM agent_runtime_permissions WHERE session_id = ?');
      const deleteToolCallsBySession = db.prepare('DELETE FROM agent_runtime_tool_calls WHERE session_id = ?');
      const deleteEventsBySession = db.prepare('DELETE FROM agent_runtime_events WHERE session_id = ?');
      const deleteMessagesBySession = db.prepare('DELETE FROM agent_runtime_messages WHERE session_id = ?');
      const deleteSessionById = db.prepare('DELETE FROM agent_runtime_sessions WHERE id = ?');
      const deleteContextBundleById = db.prepare('DELETE FROM agent_runtime_context_bundles WHERE id = ?');

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
        deleteSessionById.run(id);
      }

      for (const bundleId of contextBundleIds) {
        deleteContextBundleById.run(bundleId);
      }
    });
    tx();
    for (const id of deleteIds) {
      runtimeBus.emit({ type: 'session_deleted', sessionId: id });
    }
    return deleteIds;
  }

  appendMessage(message: AgentRuntimeMessage): AgentRuntimeMessage {
    const session = this.getSession(message.sessionId);
    const nextSequence = this.nextMessageSequence(message.sessionId);
    getRawSqlite()
      .prepare(
        `INSERT OR REPLACE INTO agent_runtime_messages
         (id, session_id, project_id, sequence, turn_id, run_id, step_id, role, content, provider_id, model_id, tool_call_id, usage_json, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    return message;
  }

  listMessages(sessionId: string): AgentRuntimeMessage[] {
    const rows = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_messages WHERE session_id = ? ORDER BY sequence, created_at, rowid')
      .all(sessionId) as MessageRow[];
    return rows.map(mapMessage);
  }

  appendEvent(event: RuntimeEvent): RuntimeEvent {
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
    const rows = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_events WHERE session_id = ? ORDER BY rowid')
      .all(sessionId) as EventRow[];
    const events = rows.map(mapEvent);
    if (!after) return events;
    const index = events.findIndex((event) => event.id === after);
    return index >= 0 ? events.slice(index + 1) : events;
  }

  appendRun(run: AgentRun): AgentRun {
    getRawSqlite()
      .prepare(
        `INSERT OR REPLACE INTO agent_runtime_runs
         (id, session_id, status, started_at, completed_at, trigger_message_id, current_step, stop_reason, model, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    return run;
  }

  getRun(runId: string): AgentRun {
    const row = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_runs WHERE id = ?')
      .get(runId) as RunRow | undefined;
    if (!row) throw new AgentNotFoundError(runId);
    return mapRun(row);
  }

  updateRun(runId: string, patch: Partial<AgentRun>): AgentRun {
    const current = this.getRun(runId);
    const next = { ...current, ...patch };
    return this.appendRun(next);
  }

  listRuns(sessionId: string): AgentRun[] {
    const rows = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC')
      .all(sessionId) as RunRow[];
    return rows.map(mapRun);
  }

  appendRunStep(step: AgentRunStep): AgentRunStep {
    getRawSqlite()
      .prepare(
        `INSERT OR REPLACE INTO agent_runtime_run_steps
         (id, run_id, session_id, step_index, status, model, started_at, completed_at, finish_reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  }

  getRunStep(stepId: string): AgentRunStep {
    const row = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_run_steps WHERE id = ?')
      .get(stepId) as RunStepRow | undefined;
    if (!row) throw new AgentNotFoundError(stepId);
    return mapRunStep(row);
  }

  updateRunStep(stepId: string, patch: Partial<AgentRunStep>): AgentRunStep {
    const current = this.getRunStep(stepId);
    const next = { ...current, ...patch };
    return this.appendRunStep(next);
  }

  listRunSteps(runId: string): AgentRunStep[] {
    const rows = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_run_steps WHERE run_id = ? ORDER BY step_index, rowid')
      .all(runId) as RunStepRow[];
    return rows.map(mapRunStep);
  }

  appendRunPart(part: AgentRunPart): AgentRunPart {
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
  }

  listRunParts(stepId: string): AgentRunPart[] {
    const rows = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_run_parts WHERE step_id = ? ORDER BY sequence, rowid')
      .all(stepId) as RunPartRow[];
    return rows.map(mapRunPart);
  }

  nextRunPartSequence(stepId: string): number {
    const row = getRawSqlite()
      .prepare('SELECT MAX(sequence) AS max_sequence FROM agent_runtime_run_parts WHERE step_id = ?')
      .get(stepId) as { max_sequence: number | null } | undefined;
    return (row?.max_sequence ?? 0) + 1;
  }

  appendToolCall(record: ToolCallRecord): ToolCallRecord {
    getRawSqlite()
      .prepare(
        `INSERT OR REPLACE INTO agent_runtime_tool_calls
         (id, session_id, run_id, step_id, model_tool_call_id, tool_id, category, mutability, args_hash, input_summary,
          input_ref_json, output_summary, output_ref_json, status, permission_decision_id, started_at, ended_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    return record;
  }

  updateToolCall(sessionId: string, toolCallId: string, patch: Partial<ToolCallRecord>): ToolCallRecord {
    const current = this.getToolCall(sessionId, toolCallId);
    const next = { ...current, ...patch };
    return this.appendToolCall(next);
  }

  getToolCall(sessionId: string, toolCallId: string): ToolCallRecord {
    const row = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_tool_calls WHERE session_id = ? AND id = ? LIMIT 1')
      .get(sessionId, toolCallId) as ToolCallRow | undefined;
    if (!row) throw new AgentNotFoundError(toolCallId);
    return mapToolCall(row);
  }

  listToolCalls(sessionId: string): ToolCallRecord[] {
    const rows = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_tool_calls WHERE session_id = ? ORDER BY rowid')
      .all(sessionId) as ToolCallRow[];
    return rows.map(mapToolCall);
  }

  listRunToolCalls(runId: string): ToolCallRecord[] {
    const rows = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_tool_calls WHERE run_id = ? ORDER BY rowid')
      .all(runId) as ToolCallRow[];
    return rows.map(mapToolCall);
  }

  appendPermission(decision: PermissionDecision): PermissionDecision {
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
  }

  updatePermission(sessionId: string, permissionId: string, patch: Partial<PermissionDecision>): PermissionDecision {
    const current = this.listPermissions(sessionId).find((item) => item.id === permissionId);
    if (!current) throw new AgentNotFoundError(permissionId);
    const next = { ...current, ...patch };
    return this.appendPermission(next);
  }

  listPermissions(sessionId: string): PermissionDecision[] {
    const rows = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_permissions WHERE session_id = ? ORDER BY rowid')
      .all(sessionId) as PermissionRow[];
    return rows.map(mapPermission);
  }

  findPermissionByResumeToken(sessionId: string, resumeToken: string): PermissionDecision | undefined {
    const row = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_permissions WHERE session_id = ? AND resume_token = ? ORDER BY rowid DESC LIMIT 1')
      .get(sessionId, resumeToken) as PermissionRow | undefined;
    return row ? mapPermission(row) : undefined;
  }

  appendArtifact(artifact: EvidenceArtifact): EvidenceArtifact {
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
  }

  listArtifacts(sessionId: string): EvidenceArtifact[] {
    const rows = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_artifacts WHERE session_id = ? ORDER BY rowid')
      .all(sessionId) as ArtifactRow[];
    return rows.map(mapArtifact);
  }

  saveContextBundle(bundle: AgentContextBundle): AgentContextBundle {
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
  }

  getContextBundle(id: string): AgentContextBundle {
    const row = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_context_bundles WHERE id = ?')
      .get(id) as ContextBundleRow | undefined;
    if (!row) throw new AgentNotFoundError(id);
    return mapContextBundle(row);
  }

  saveThinkingSummary(summary: ThinkingSummary): ThinkingSummary {
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
  }

  getThinkingSummary(id: string): ThinkingSummary {
    const row = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_thinking_summaries WHERE id = ?')
      .get(id) as ThinkingSummaryRow | undefined;
    if (!row) throw new AgentNotFoundError(id);
    return mapThinkingSummary(row);
  }

  saveCompactionRecord(record: CompactionRecord): CompactionRecord {
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
  }

  getLatestCompactionRecord(sessionId: string): CompactionRecord | null {
    const row = getRawSqlite()
      .prepare('SELECT * FROM agent_runtime_compaction_summaries WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as {
        id: string;
        session_id: string;
        run_id: string | null;
        summary_text: string;
        compressed_message_count: number;
        original_token_count: number;
        compressed_token_count: number;
        created_at: string;
      } | undefined;
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

  getSessionStats(sessionId: string): {
    tokenUsage: { input: number; output: number; total: number };
    contextLimit: number;
    contextUsedPercent: number;
    toolCallCount: number;
    runningDuration: number;
    status: string;
    activeSubAgentCount: number;
  } {
    const session = this.getSession(sessionId);
    const db = getRawSqlite();

    const usageRows = db
      .prepare("SELECT usage_json FROM agent_runtime_messages WHERE session_id = ? AND role = 'assistant'")
      .all(sessionId) as Array<{ usage_json: string }>;

    let input = 0;
    let output = 0;
    for (const row of usageRows) {
      try {
        const u = JSON.parse(row.usage_json || '{}');
        input += (u.promptTokens ?? u.input_tokens ?? 0);
        output += (u.completionTokens ?? u.output_tokens ?? 0);
      } catch { /* skip */ }
    }
    const total = input + output;

    const contextLimit = 128_000;
    const compaction = this.getLatestCompactionRecord(sessionId);
    const contextUsed = compaction ? compaction.originalTokenCount : total;
    const contextUsedPercent = Math.min(Math.round((contextUsed / contextLimit) * 100), 100);

    const toolCountRow = db
      .prepare('SELECT COUNT(*) as cnt FROM agent_runtime_tool_calls WHERE session_id = ?')
      .get(sessionId) as { cnt: number };
    const toolCallCount = toolCountRow?.cnt ?? 0;

    const runningDuration = Date.now() - new Date(session.createdAt).getTime();

    let activeSubAgentCount = 0;
    if (session.childSessionIds.length > 0) {
      for (const childId of session.childSessionIds) {
        try {
          const child = this.getSession(childId);
          if (child.status === 'running') activeSubAgentCount++;
        } catch { /* deleted or missing */ }
      }
    }

    return {
      tokenUsage: { input, output, total },
      contextLimit,
      contextUsedPercent,
      toolCallCount,
      runningDuration,
      status: session.status,
      activeSubAgentCount,
    };
  }

  recoverOrphanedSessions(): number {
    const db = getRawSqlite();
    const result = db
      .prepare(
        `UPDATE agent_runtime_sessions
         SET status = 'interrupted', updated_at = ?, active_run_id = NULL, blocked_reason = 'Server restarted.'
         WHERE status IN ('running', 'queued')`,
      )
      .run(nowIso());
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
    return createHash('sha256').update(stringify(args)).digest('hex');
  }

  private upsertSession(session: AgentSession): void {
    getRawSqlite()
      .prepare(
        `INSERT OR REPLACE INTO agent_runtime_sessions
         (id, project_id, parent_session_id, child_session_ids_json, node_id, profile_id, status,
          title, prompt, context_snapshot_id, thinking_mode, permission_rules_json, created_at, updated_at,
          completed_at, result_summary, blocked_reason, skill_ids_json, active_run_id, pending_resume_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.projectId,
        session.parentSessionId,
        stringify(session.childSessionIds),
        session.nodeId,
        session.profileId,
        session.status,
        session.title,
        session.prompt,
        session.contextSnapshotId,
        session.thinkingMode,
        stringify(session.permissionRules),
        session.createdAt,
        session.updatedAt,
        session.completedAt,
        session.resultSummary,
        session.blockedReason,
        stringify(session.skillIds),
        session.activeRunId,
        session.pendingResumeToken,
      );
  }

  private nextMessageSequence(sessionId: string): number {
    const row = getRawSqlite()
      .prepare('SELECT MAX(sequence) AS max_sequence FROM agent_runtime_messages WHERE session_id = ?')
      .get(sessionId) as { max_sequence: number | null } | undefined;
    return (row?.max_sequence ?? 0) + 1;
  }
}

export const agentRuntimeStore = new AgentRuntimeStore();
