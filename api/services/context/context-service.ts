// ---------------------------------------------------------------------------
// api/services/context/context-service.ts
//
// ---------------------------------------------------------------------------

import { nanoid } from 'nanoid';
import { getRawSqlite } from '../../db/index.js';
import { syncBus } from './sync-bus.js';
import { SyncEventType } from '../contracts/context.js';
import type {
  ContextBinding,
  ContextBlock,
  ContextBundle,
  ContextEntry,
  ContextLink,
  ContextRunSnapshot,
  ContextSession,
  ContextSnapshot,
  CoordEventLogEntry,
  CoordinatesContextIndex,
  FrozenContextItem,
  AgentConversationTurn,
  AgentLoopRecord,
  AgentLoopStep,
  AgentLoopTranscript,
  CreateSessionOpts,
  ContextDisclosureSuggestion,
  CoordEventType,
  EntryRole,
  ExportPayload,
  ImportResult,
  ImportStrategy,
  MemoryFilter,
  ContextSignal,
  NewContextBinding,
  NewContextBlock,
  NewContextDisclosureSuggestion,
  NewCoordEvent,
  NewAgentLoopRecord,
  NewContextSignal,
  NewEntry,
  NewLink,
  NewMemory,
  Paginated,
  PaginationOpts,
  ProjectMemory,
  SessionFilter,
  SnapshotOpts,
  SynaxNodeContext,
  SyncEvent,
} from '../contracts/context.js';
import type { CoordForest } from '../contracts/forest.js';

// ============================== 工具函数 ==============================

const now = () => new Date().toISOString();
const nid = (prefix: string) => `${prefix}_${nanoid(12)}`;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function estimateTokens(content: string): number {
  // 粗略估算：平均 4 字符 ≈ 1 token（够用于阈值预警）
  return Math.max(1, Math.ceil(content.length / 4));
}

function publish(event: SyncEvent) {
  try {
    syncBus.emit(event);
  } catch {
    /* 事件总线异常不阻塞主路径 */
  }
}

// ============================== Row ↔ Domain 映射 ==============================

type SessionRowLike = {
  id: string;
  project_id: string;
  user_id: string;
  status: string;
  title: string | null;
  summary: string | null;
  token_count: number;
  entry_count: number;
  source_agent: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  archived_at: string | null;
};

function mapSession(r: SessionRowLike): ContextSession {
  return {
    id: r.id,
    projectId: r.project_id,
    userId: r.user_id,
    status: r.status as ContextSession['status'],
    title: r.title,
    summary: r.summary,
    tokenCount: r.token_count,
    entryCount: r.entry_count,
    sourceAgent: r.source_agent,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
    archivedAt: r.archived_at,
  };
}

type EntryRowLike = {
  id: string;
  session_id: string;
  project_id: string;
  sequence: number;
  role: string;
  content: string;
  content_type: string;
  token_estimate: number;
  metadata: string;
  parent_entry_id: string | null;
  created_at: string;
};

function mapEntry(r: EntryRowLike): ContextEntry {
  return {
    id: r.id,
    sessionId: r.session_id,
    projectId: r.project_id,
    sequence: r.sequence,
    role: r.role as EntryRole,
    content: r.content,
    contentType: r.content_type as ContextEntry['contentType'],
    tokenEstimate: r.token_estimate,
    metadata: parseJson<Record<string, unknown>>(r.metadata, {}),
    parentEntryId: r.parent_entry_id,
    createdAt: r.created_at,
  };
}

type SnapshotRowLike = {
  id: string;
  session_id: string;
  project_id: string;
  label: string | null;
  from_sequence: number;
  to_sequence: number;
  entry_count: number;
  compressed_content: string | null;
  diff_base_id: string | null;
  created_at: string;
  created_by: string | null;
};

function mapSnapshot(r: SnapshotRowLike): ContextSnapshot {
  return {
    id: r.id,
    sessionId: r.session_id,
    projectId: r.project_id,
    label: r.label,
    fromSequence: r.from_sequence,
    toSequence: r.to_sequence,
    entryCount: r.entry_count,
    compressedContent: r.compressed_content,
    diffBaseId: r.diff_base_id,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

type MemoryRowLike = {
  id: string;
  project_id: string;
  memory_type: string;
  title: string;
  content: string;
  source_session_id: string | null;
  source_entry_id: string | null;
  tags: string;
  confidence: number;
  access_count: number;
  references_json: string;
  status: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
};

function mapMemory(r: MemoryRowLike): ProjectMemory {
  return {
    id: r.id,
    projectId: r.project_id,
    memoryType: r.memory_type as ProjectMemory['memoryType'],
    title: r.title,
    content: r.content,
    sourceSessionId: r.source_session_id,
    sourceEntryId: r.source_entry_id,
    tags: parseJson<string[]>(r.tags, []),
    confidence: r.confidence,
    accessCount: r.access_count,
    references: parseJson<ProjectMemory['references']>(r.references_json, {}),
    status: r.status as ProjectMemory['status'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
  };
}

type LinkRowLike = {
  id: string;
  entry_id: string;
  node_id: string;
  project_id: string;
  link_type: string;
  confidence: number;
  created_at: string;
};

function mapLink(r: LinkRowLike): ContextLink {
  return {
    id: r.id,
    entryId: r.entry_id,
    nodeId: r.node_id,
    projectId: r.project_id,
    linkType: r.link_type as ContextLink['linkType'],
    confidence: r.confidence,
    createdAt: r.created_at,
  };
}

type CoordinatesStateRowLike = {
  project_id: string;
  snapshot_json: string;
  revision: number;
  updated_at: string;
  updated_by: string | null;
};

type ContextBlockRowLike = {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  content: string;
  status: string;
  source_type: string | null;
  source_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
};

function mapContextBlock(r: ContextBlockRowLike): ContextBlock {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind as ContextBlock['kind'],
    title: r.title,
    content: r.content,
    status: r.status as ContextBlock['status'],
    sourceType: r.source_type,
    sourceId: r.source_id,
    metadata: parseJson<Record<string, unknown>>(r.metadata_json, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
  };
}

type ContextBindingRowLike = {
  id: string;
  project_id: string;
  block_id: string;
  target_kind: string;
  target_id: string;
  relation: string;
  confidence: number;
  metadata_json: string;
  created_at: string;
  created_by: string | null;
};

function mapContextBinding(r: ContextBindingRowLike): ContextBinding {
  return {
    id: r.id,
    projectId: r.project_id,
    blockId: r.block_id,
    targetKind: r.target_kind as ContextBinding['targetKind'],
    targetId: r.target_id,
    relation: r.relation as ContextBinding['relation'],
    confidence: r.confidence,
    metadata: parseJson<Record<string, unknown>>(r.metadata_json, {}),
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

type ContextBundleRowLike = {
  id: string;
  project_id: string;
  title: string;
  block_ids_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
};

function mapContextBundle(r: ContextBundleRowLike): ContextBundle {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    blockIds: parseJson<string[]>(r.block_ids_json, []),
    metadata: parseJson<Record<string, unknown>>(r.metadata_json, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    createdBy: r.created_by,
  };
}

type ContextRunSnapshotRowLike = {
  id: string;
  project_id: string;
  node_id: string;
  run_id: string;
  bundle_id: string | null;
  input_block_ids_json: string;
  prompt: string;
  frozen_context_json: string;
  created_at: string;
  created_by: string | null;
};

function mapContextRunSnapshot(r: ContextRunSnapshotRowLike): ContextRunSnapshot {
  return {
    id: r.id,
    projectId: r.project_id,
    nodeId: r.node_id,
    runId: r.run_id,
    bundleId: r.bundle_id,
    inputBlockIds: parseJson<string[]>(r.input_block_ids_json, []),
    prompt: r.prompt,
    frozenContext: parseJson<FrozenContextItem[]>(r.frozen_context_json, []),
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

type CoordEventRowLike = {
  id: string;
  project_id: string;
  revision: number;
  type: string;
  node_id: string | null;
  run_id: string | null;
  context_block_ids_json: string;
  caused_by_event_ids_json: string;
  payload_json: string;
  actor_id: string | null;
  created_at: string;
};

function mapCoordEvent(r: CoordEventRowLike): CoordEventLogEntry {
  return {
    id: r.id,
    projectId: r.project_id,
    revision: r.revision,
    type: r.type,
    nodeId: r.node_id,
    runId: r.run_id,
    contextBlockIds: parseJson<string[]>(r.context_block_ids_json, []),
    causedByEventIds: parseJson<string[]>(r.caused_by_event_ids_json, []),
    payload: parseJson<Record<string, unknown>>(r.payload_json, {}),
    actorId: r.actor_id,
    createdAt: r.created_at,
  };
}

type AgentConversationTurnRowLike = {
  id: string;
  project_id: string;
  node_id: string | null;
  run_id: string;
  user_id: string | null;
  raw_input: string;
  context_snapshot_id: string | null;
  status: string;
  metadata_json: string;
  created_at: string;
  completed_at: string | null;
};

function mapAgentConversationTurn(r: AgentConversationTurnRowLike): AgentConversationTurn {
  return {
    id: r.id,
    projectId: r.project_id,
    nodeId: r.node_id,
    runId: r.run_id,
    userId: r.user_id,
    rawInput: r.raw_input,
    contextSnapshotId: r.context_snapshot_id,
    status: r.status as AgentConversationTurn['status'],
    metadata: parseJson<Record<string, unknown>>(r.metadata_json, {}),
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

type AgentLoopRecordRowLike = {
  id: string;
  project_id: string;
  turn_id: string;
  node_id: string | null;
  run_id: string;
  provider: string;
  status: string;
  summary: string | null;
  final_output: string | null;
  context_snapshot_id: string | null;
  transcript_json: string;
  file_changes_json: string;
  metadata_json: string;
  started_at: string;
  completed_at: string | null;
};

function mapAgentLoopRecord(r: AgentLoopRecordRowLike, steps?: AgentLoopStep[]): AgentLoopRecord {
  return {
    id: r.id,
    projectId: r.project_id,
    turnId: r.turn_id,
    nodeId: r.node_id,
    runId: r.run_id,
    provider: r.provider,
    status: r.status as AgentLoopRecord['status'],
    summary: r.summary,
    finalOutput: r.final_output,
    contextSnapshotId: r.context_snapshot_id,
    transcript: parseJson<AgentLoopTranscript>(r.transcript_json, {
      userInput: '',
      contextSnapshotId: r.context_snapshot_id,
      steps: [],
    }),
    fileChanges: parseJson<unknown[]>(r.file_changes_json, []),
    metadata: parseJson<Record<string, unknown>>(r.metadata_json, {}),
    startedAt: r.started_at,
    completedAt: r.completed_at,
    ...(steps ? { steps } : {}),
  };
}

type AgentLoopStepRowLike = {
  id: string;
  loop_id: string;
  project_id: string;
  run_id: string;
  sequence: number;
  kind: string;
  title: string;
  content: string;
  payload_json: string;
  metadata_json: string;
  created_at: string;
};

function mapAgentLoopStep(r: AgentLoopStepRowLike): AgentLoopStep {
  return {
    id: r.id,
    loopId: r.loop_id,
    projectId: r.project_id,
    runId: r.run_id,
    sequence: r.sequence,
    kind: r.kind as AgentLoopStep['kind'],
    title: r.title,
    content: r.content,
    payload: parseJson<Record<string, unknown>>(r.payload_json, {}),
    metadata: parseJson<Record<string, unknown>>(r.metadata_json, {}),
    createdAt: r.created_at,
  };
}

type ContextSignalRowLike = {
  id: string;
  project_id: string;
  block_id: string;
  source_type: string;
  source_id: string;
  source_node_id: string | null;
  source_run_id: string | null;
  kind: string;
  title: string;
  summary: string;
  content: string;
  confidence: number;
  tags_json: string;
  source_links_json: string;
  metadata_json: string;
  created_at: string;
  created_by: string | null;
};

function mapContextSignal(r: ContextSignalRowLike): ContextSignal {
  return {
    id: r.id,
    projectId: r.project_id,
    blockId: r.block_id,
    sourceType: r.source_type as ContextSignal['sourceType'],
    sourceId: r.source_id,
    sourceNodeId: r.source_node_id,
    sourceRunId: r.source_run_id,
    kind: r.kind as ContextSignal['kind'],
    title: r.title,
    summary: r.summary,
    content: r.content,
    confidence: r.confidence,
    tags: parseJson<string[]>(r.tags_json, []),
    sourceLinks: parseJson<string[]>(r.source_links_json, []),
    metadata: parseJson<Record<string, unknown>>(r.metadata_json, {}),
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

type ContextDisclosureSuggestionRowLike = {
  id: string;
  project_id: string;
  signal_id: string;
  source_node_id: string | null;
  target_node_id: string;
  relation: string;
  confidence: number;
  reason: string;
  status: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  decided_by: string | null;
  decided_at: string | null;
};

function mapDisclosureSuggestion(r: ContextDisclosureSuggestionRowLike): ContextDisclosureSuggestion {
  return {
    id: r.id,
    projectId: r.project_id,
    signalId: r.signal_id,
    sourceNodeId: r.source_node_id,
    targetNodeId: r.target_node_id,
    relation: r.relation as ContextDisclosureSuggestion['relation'],
    confidence: r.confidence,
    reason: r.reason,
    status: r.status as ContextDisclosureSuggestion['status'],
    metadata: parseJson<Record<string, unknown>>(r.metadata_json, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
  };
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.7;
  return Math.max(0, Math.min(1, value));
}

function compactText(text: string, max = 800): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1).trim()}…` : normalized;
}

function isMechanicalRunNoise(text: string): boolean {
  const normalized = compactText(text, 260).toLowerCase();
  if (!normalized) return true;
  if (/^tool\s+tool_[a-z0-9-]+:\s*(completed|started|failed)?\.?$/i.test(normalized)) return true;
  if (/^tool\s+(call|result)\s+tool_[a-z0-9-]+/i.test(normalized)) return true;
  if (/^run completed(?:\s*\([^)]*\))?\.?$/i.test(normalized)) return true;
  if (/^touched files:\s*/i.test(normalized)) return true;
  if (/^context snapshot\s+/i.test(normalized)) return true;
  if (/^[a-z_]+:\s*(completed|started|end_turn)\.?$/i.test(normalized)) return true;
  return false;
}

// ============================== 服务实现 ==============================

export class ContextService {
  private db = getRawSqlite();

  // ---------- Session ----------

  createSession(
    projectId: string,
    userId: string,
    opts: CreateSessionOpts = {},
  ): ContextSession {
    const ts = now();
    const expiresAt = opts.ttlHours
      ? new Date(Date.now() + opts.ttlHours * 3600_000).toISOString()
      : null;
    const row: SessionRowLike = {
      id: nid('cs'),
      project_id: projectId,
      user_id: userId,
      status: 'active',
      title: opts.title ?? null,
      summary: null,
      token_count: 0,
      entry_count: 0,
      source_agent: opts.sourceAgent ?? null,
      created_at: ts,
      updated_at: ts,
      expires_at: expiresAt,
      archived_at: null,
    };
    this.db
      .prepare(
        `INSERT INTO context_sessions
         (id, project_id, user_id, status, title, summary, token_count, entry_count,
          source_agent, created_at, updated_at, expires_at, archived_at)
         VALUES (@id, @project_id, @user_id, @status, @title, @summary, @token_count, @entry_count,
                 @source_agent, @created_at, @updated_at, @expires_at, @archived_at)`,
      )
      .run(row);
    const session = mapSession(row);
    publish({
      type: SyncEventType.SessionCreated,
      projectId,
      sessionId: session.id,
      payload: session,
      timestamp: Date.now(),
    });
    return session;
  }

  getSession(sessionId: string): ContextSession | null {
    const row = this.db
      .prepare(`SELECT * FROM context_sessions WHERE id = ?`)
      .get(sessionId) as SessionRowLike | undefined;
    return row ? mapSession(row) : null;
  }

  listSessions(projectId: string, filter: SessionFilter = {}): Paginated<ContextSession> {
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 200);
    const offset = Math.max(filter.offset ?? 0, 0);
    const orderCol = filter.orderBy === 'createdAt' ? 'created_at' : 'updated_at';
    const orderDir = filter.order === 'asc' ? 'ASC' : 'DESC';

    const where: string[] = ['project_id = ?'];
    const params: unknown[] = [projectId];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.userId) {
      where.push('user_id = ?');
      params.push(filter.userId);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = (this.db
      .prepare(`SELECT COUNT(*) AS c FROM context_sessions ${whereSql}`)
      .get(...params) as { c: number }).c;

    const rows = this.db
      .prepare(
        `SELECT * FROM context_sessions ${whereSql}
         ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as SessionRowLike[];

    return { items: rows.map(mapSession), total, offset, limit };
  }

  updateSession(
    sessionId: string,
    updates: Partial<Pick<ContextSession, 'title' | 'summary' | 'status' | 'tokenCount'>>,
  ): ContextSession {
    const existing = this.getSession(sessionId);
    if (!existing) throw new Error(`Session ${sessionId} not found`);
    const fields: string[] = [];
    const params: unknown[] = [];
    if (updates.title !== undefined) {
      fields.push('title = ?');
      params.push(updates.title);
    }
    if (updates.summary !== undefined) {
      fields.push('summary = ?');
      params.push(updates.summary);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      params.push(updates.status);
    }
    if (updates.tokenCount !== undefined) {
      fields.push('token_count = ?');
      params.push(updates.tokenCount);
    }
    fields.push('updated_at = ?');
    params.push(now());
    params.push(sessionId);
    this.db
      .prepare(`UPDATE context_sessions SET ${fields.join(', ')} WHERE id = ?`)
      .run(...params);
    const updated = this.getSession(sessionId)!;
    publish({
      type: SyncEventType.SessionUpdated,
      projectId: updated.projectId,
      sessionId: updated.id,
      payload: updated,
      timestamp: Date.now(),
    });
    return updated;
  }

  archiveSession(sessionId: string): ContextSession {
    const ts = now();
    this.db
      .prepare(
        `UPDATE context_sessions SET status='archived', archived_at=?, updated_at=? WHERE id=?`,
      )
      .run(ts, ts, sessionId);
    const updated = this.getSession(sessionId);
    if (!updated) throw new Error(`Session ${sessionId} not found`);
    publish({
      type: SyncEventType.SessionArchived,
      projectId: updated.projectId,
      sessionId,
      payload: updated,
      timestamp: Date.now(),
    });
    return updated;
  }

  deleteSession(sessionId: string): void {
    const existing = this.getSession(sessionId);
    if (!existing) return;
    this.db.prepare(`DELETE FROM context_sessions WHERE id = ?`).run(sessionId);
    publish({
      type: SyncEventType.SessionDeleted,
      projectId: existing.projectId,
      sessionId,
      payload: { id: sessionId },
      timestamp: Date.now(),
    });
  }

  // ---------- Entry ----------

  appendEntry(sessionId: string, entry: NewEntry): ContextEntry {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const tx = this.db.transaction((e: NewEntry): ContextEntry => {
      const seqRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), -1) + 1 AS next_seq
           FROM context_entries WHERE session_id = ?`,
        )
        .get(sessionId) as { next_seq: number };
      const row: EntryRowLike = {
        id: nid('ce'),
        session_id: sessionId,
        project_id: session.projectId,
        sequence: seqRow.next_seq,
        role: e.role,
        content: e.content,
        content_type: e.contentType ?? 'text',
        token_estimate: e.tokenEstimate ?? estimateTokens(e.content),
        metadata: JSON.stringify(e.metadata ?? {}),
        parent_entry_id: e.parentEntryId ?? null,
        created_at: now(),
      };
      this.db
        .prepare(
          `INSERT INTO context_entries
           (id, session_id, project_id, sequence, role, content, content_type,
            token_estimate, metadata, parent_entry_id, created_at)
           VALUES (@id, @session_id, @project_id, @sequence, @role, @content, @content_type,
                   @token_estimate, @metadata, @parent_entry_id, @created_at)`,
        )
        .run(row);

      this.db
        .prepare(
          `UPDATE context_sessions
           SET entry_count = entry_count + 1,
               token_count = token_count + ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(row.token_estimate, row.created_at, sessionId);
      return mapEntry(row);
    });

    const entryDomain = tx(entry);
    publish({
      type: SyncEventType.EntryCreated,
      projectId: entryDomain.projectId,
      sessionId,
      payload: entryDomain,
      timestamp: Date.now(),
    });
    return entryDomain;
  }

  getEntries(sessionId: string, opts: PaginationOpts = {}): Paginated<ContextEntry> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM context_entries WHERE session_id = ?`)
      .get(sessionId) as { c: number };

    let rows: EntryRowLike[];
    if (opts.afterSequence !== undefined) {
      rows = this.db
        .prepare(
          `SELECT * FROM context_entries
           WHERE session_id = ? AND sequence > ?
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(sessionId, opts.afterSequence, limit) as EntryRowLike[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM context_entries WHERE session_id = ?
           ORDER BY sequence ASC LIMIT ? OFFSET ?`,
        )
        .all(sessionId, limit, offset) as EntryRowLike[];
    }
    return { items: rows.map(mapEntry), total: totalRow.c, offset, limit };
  }

  getEntry(entryId: string): ContextEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM context_entries WHERE id = ?`)
      .get(entryId) as EntryRowLike | undefined;
    return row ? mapEntry(row) : null;
  }

  updateEntry(entryId: string, updates: Partial<Pick<ContextEntry, 'content' | 'metadata'>>): ContextEntry {
    const fields: string[] = [];
    const params: unknown[] = [];
    if (updates.content !== undefined) {
      fields.push('content = ?');
      params.push(updates.content);
    }
    if (updates.metadata !== undefined) {
      fields.push('metadata = ?');
      params.push(JSON.stringify(updates.metadata));
    }
    if (fields.length === 0) {
      const existing = this.getEntry(entryId);
      if (!existing) throw new Error(`Entry ${entryId} not found`);
      return existing;
    }
    params.push(entryId);
    this.db
      .prepare(`UPDATE context_entries SET ${fields.join(', ')} WHERE id = ?`)
      .run(...params);
    const updated = this.getEntry(entryId);
    if (!updated) throw new Error(`Entry ${entryId} not found`);
    publish({
      type: SyncEventType.EntryUpdated,
      projectId: updated.projectId,
      sessionId: updated.sessionId,
      payload: updated,
      timestamp: Date.now(),
    });
    return updated;
  }

  deleteEntry(entryId: string): void {
    const existing = this.getEntry(entryId);
    if (!existing) return;
    this.db.prepare(`DELETE FROM context_entries WHERE id = ?`).run(entryId);
    this.db
      .prepare(
        `UPDATE context_sessions
         SET entry_count = MAX(entry_count - 1, 0),
             token_count = MAX(token_count - ?, 0),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(existing.tokenEstimate, now(), existing.sessionId);
    publish({
      type: SyncEventType.EntryDeleted,
      projectId: existing.projectId,
      sessionId: existing.sessionId,
      payload: { id: entryId },
      timestamp: Date.now(),
    });
  }

  // ---------- Snapshot ----------

  createSnapshot(sessionId: string, opts: SnapshotOpts = {}): ContextSnapshot {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const range = this.db
      .prepare(
        `SELECT COALESCE(MIN(sequence), 0) AS min_seq,
                COALESCE(MAX(sequence), 0) AS max_seq,
                COUNT(*) AS cnt
         FROM context_entries WHERE session_id = ?`,
      )
      .get(sessionId) as { min_seq: number; max_seq: number; cnt: number };

    const row: SnapshotRowLike = {
      id: nid('cn'),
      session_id: sessionId,
      project_id: session.projectId,
      label: opts.label ?? null,
      from_sequence: opts.fromSequence ?? range.min_seq,
      to_sequence: opts.toSequence ?? range.max_seq,
      entry_count: range.cnt,
      compressed_content: opts.compressedContent ?? null,
      diff_base_id: opts.diffBaseId ?? null,
      created_at: now(),
      created_by: opts.createdBy ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO context_snapshots
         (id, session_id, project_id, label, from_sequence, to_sequence, entry_count,
          compressed_content, diff_base_id, created_at, created_by)
         VALUES (@id, @session_id, @project_id, @label, @from_sequence, @to_sequence, @entry_count,
                 @compressed_content, @diff_base_id, @created_at, @created_by)`,
      )
      .run(row);
    const snap = mapSnapshot(row);
    publish({
      type: SyncEventType.SnapshotCreated,
      projectId: snap.projectId,
      sessionId,
      payload: snap,
      timestamp: Date.now(),
    });
    return snap;
  }

  getSnapshots(sessionId: string): ContextSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM context_snapshots WHERE session_id = ? ORDER BY created_at DESC`,
      )
      .all(sessionId) as SnapshotRowLike[];
    return rows.map(mapSnapshot);
  }

  getSnapshot(snapshotId: string): ContextSnapshot | null {
    const row = this.db
      .prepare(`SELECT * FROM context_snapshots WHERE id = ?`)
      .get(snapshotId) as SnapshotRowLike | undefined;
    return row ? mapSnapshot(row) : null;
  }

  // ---------- Memory ----------

  createMemory(projectId: string, memory: NewMemory): ProjectMemory {
    const ts = now();
    const row: MemoryRowLike = {
      id: nid('pm'),
      project_id: projectId,
      memory_type: memory.memoryType,
      title: memory.title,
      content: memory.content,
      source_session_id: memory.sourceSessionId ?? null,
      source_entry_id: memory.sourceEntryId ?? null,
      tags: JSON.stringify(memory.tags ?? []),
      confidence: memory.confidence ?? 1.0,
      access_count: 0,
      references_json: JSON.stringify(memory.references ?? {}),
      status: 'active',
      created_at: ts,
      updated_at: ts,
      expires_at: memory.expiresAt ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO project_memories
         (id, project_id, memory_type, title, content, source_session_id, source_entry_id,
          tags, confidence, access_count, references_json, status, created_at, updated_at, expires_at)
         VALUES (@id, @project_id, @memory_type, @title, @content, @source_session_id, @source_entry_id,
                 @tags, @confidence, @access_count, @references_json, @status, @created_at, @updated_at, @expires_at)`,
      )
      .run(row);
    const mem = mapMemory(row);
    publish({
      type: SyncEventType.MemoryCreated,
      projectId,
      payload: mem,
      timestamp: Date.now(),
    });
    return mem;
  }

  getMemory(memoryId: string): ProjectMemory | null {
    const row = this.db
      .prepare(`SELECT * FROM project_memories WHERE id = ?`)
      .get(memoryId) as MemoryRowLike | undefined;
    return row ? mapMemory(row) : null;
  }

  listMemories(projectId: string, filter: MemoryFilter = {}): Paginated<ProjectMemory> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);
    const where: string[] = ['project_id = ?'];
    const params: unknown[] = [projectId];
    if (filter.memoryType) {
      where.push('memory_type = ?');
      params.push(filter.memoryType);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.tag) {
      where.push("tags LIKE ?");
      params.push(`%${JSON.stringify(filter.tag).slice(1, -1)}%`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (this.db
      .prepare(`SELECT COUNT(*) AS c FROM project_memories ${whereSql}`)
      .get(...params) as { c: number }).c;
    const rows = this.db
      .prepare(
        `SELECT * FROM project_memories ${whereSql}
         ORDER BY access_count DESC, updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as MemoryRowLike[];
    return { items: rows.map(mapMemory), total, offset, limit };
  }

  updateMemory(
    memoryId: string,
    updates: Partial<
      Pick<
        ProjectMemory,
        'title' | 'content' | 'tags' | 'confidence' | 'status' | 'references' | 'memoryType'
      >
    >,
  ): ProjectMemory {
    const fields: string[] = [];
    const params: unknown[] = [];
    if (updates.title !== undefined) {
      fields.push('title = ?');
      params.push(updates.title);
    }
    if (updates.content !== undefined) {
      fields.push('content = ?');
      params.push(updates.content);
    }
    if (updates.tags !== undefined) {
      fields.push('tags = ?');
      params.push(JSON.stringify(updates.tags));
    }
    if (updates.confidence !== undefined) {
      fields.push('confidence = ?');
      params.push(updates.confidence);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      params.push(updates.status);
    }
    if (updates.references !== undefined) {
      fields.push('references_json = ?');
      params.push(JSON.stringify(updates.references));
    }
    if (updates.memoryType !== undefined) {
      fields.push('memory_type = ?');
      params.push(updates.memoryType);
    }
    fields.push('updated_at = ?');
    params.push(now());
    params.push(memoryId);
    this.db
      .prepare(`UPDATE project_memories SET ${fields.join(', ')} WHERE id = ?`)
      .run(...params);
    const updated = this.getMemory(memoryId);
    if (!updated) throw new Error(`Memory ${memoryId} not found`);
    publish({
      type: SyncEventType.MemoryUpdated,
      projectId: updated.projectId,
      payload: updated,
      timestamp: Date.now(),
    });
    return updated;
  }

  deleteMemory(memoryId: string): void {
    const existing = this.getMemory(memoryId);
    if (!existing) return;
    this.db.prepare(`DELETE FROM project_memories WHERE id = ?`).run(memoryId);
    publish({
      type: SyncEventType.MemoryDeleted,
      projectId: existing.projectId,
      payload: { id: memoryId },
      timestamp: Date.now(),
    });
  }

  /** 记忆访问次数自增（用于检索命中时的打分）。 */
  touchMemory(memoryId: string): void {
    this.db
      .prepare(
        `UPDATE project_memories SET access_count = access_count + 1, updated_at = ? WHERE id = ?`,
      )
      .run(now(), memoryId);
  }

  // ---------- Coordinates-native Context ----------

  getCoordinatesState(projectId: string): {
    forest: CoordForest;
    revision: number;
    updatedAt: string;
    updatedBy: string | null;
  } | null {
    const row = this.db
      .prepare(`SELECT * FROM coordinates_state WHERE project_id = ?`)
      .get(projectId) as CoordinatesStateRowLike | undefined;
    if (!row) return null;
    return {
      forest: parseJson<CoordForest>(row.snapshot_json, null as unknown as CoordForest),
      revision: row.revision,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  saveCoordinatesState(
    projectId: string,
    forest: CoordForest,
    actorId: string | null = null,
  ): { forest: CoordForest; revision: number; updatedAt: string; event: CoordEventLogEntry } {
    const event = this.appendCoordEvent({
      projectId,
      type: SyncEventType.CoordinatesStateSaved,
      payload: {
        nodeCount: Object.keys(forest.nodes ?? {}).length,
        edgeCount: forest.edges?.length ?? 0,
        previousRevision: forest.revision ?? 0,
      },
      actorId,
    });
    const ts = now();
    const nextForest: CoordForest = {
      ...forest,
      projectId,
      revision: event.revision,
      meta: {
        ...forest.meta,
        updatedAt: Date.now(),
      },
    };
    this.db
      .prepare(
        `INSERT INTO coordinates_state
         (project_id, snapshot_json, revision, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           snapshot_json = excluded.snapshot_json,
           revision = excluded.revision,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .run(projectId, JSON.stringify(nextForest), event.revision, ts, actorId);
    publish({
      type: SyncEventType.CoordinatesStateSaved,
      projectId,
      payload: { forest: nextForest, revision: event.revision, updatedAt: ts },
      timestamp: Date.now(),
    });
    return { forest: nextForest, revision: event.revision, updatedAt: ts, event };
  }

  getCoordEvents(projectId: string, afterRevision = 0, limit = 200): CoordEventLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM coord_event_log
         WHERE project_id = ? AND revision > ?
         ORDER BY revision ASC
         LIMIT ?`,
      )
      .all(projectId, Math.max(0, afterRevision), Math.min(Math.max(limit, 1), 1000)) as CoordEventRowLike[];
    return rows.map(mapCoordEvent);
  }

  getHeadRevision(projectId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(revision), 0) AS revision FROM coord_event_log WHERE project_id = ?`)
      .get(projectId) as { revision: number } | undefined;
    return row?.revision ?? 0;
  }

  appendCoordEvent(input: NewCoordEvent): CoordEventLogEntry {
    const projectId = input.projectId;
    if (!projectId) {
      throw new Error(
        `appendCoordEvent: projectId is required but got ${JSON.stringify(projectId)} (type=${input.type})`,
      );
    }
    const revision = this.getHeadRevision(projectId) + 1;
    const id = nid('ce');
    const type = input.type;
    const nodeId = input.nodeId ?? null;
    const runId = input.runId ?? null;
    const contextBlockIdsJson = JSON.stringify(input.contextBlockIds ?? []);
    const causedByEventIdsJson = JSON.stringify(input.causedByEventIds ?? []);
    const payloadJson = stringifyJson(input.payload ?? {});
    const actorId = input.actorId ?? null;
    const createdAt = now();
    this.db
      .prepare(
        `INSERT INTO coord_event_log
         (id, project_id, revision, type, node_id, run_id, context_block_ids_json,
          caused_by_event_ids_json, payload_json, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, revision, type, nodeId, runId,
           contextBlockIdsJson, causedByEventIdsJson,
           payloadJson, actorId, createdAt);
    const row: CoordEventRowLike = {
      id,
      project_id: projectId,
      revision,
      type,
      node_id: nodeId,
      run_id: runId,
      context_block_ids_json: contextBlockIdsJson,
      caused_by_event_ids_json: causedByEventIdsJson,
      payload_json: payloadJson,
      actor_id: actorId,
      created_at: createdAt,
    };
    const event = mapCoordEvent(row);
    publish({
      type: SyncEventType.CoordEventCreated,
      projectId,
      payload: event,
      timestamp: Date.now(),
    });
    return event;
  }

  createContextBlock(input: NewContextBlock): ContextBlock {
    if (input.sourceType && input.sourceId) {
      const existing = this.findContextBlockBySource(
        input.projectId,
        input.sourceType,
        input.sourceId,
      );
      if (existing) return existing;
    }
    const ts = now();
    const row: ContextBlockRowLike = {
      id: nid('cb'),
      project_id: input.projectId,
      kind: input.kind,
      title: input.title.slice(0, 240) || input.kind,
      content: input.content,
      status: input.status ?? 'active',
      source_type: input.sourceType ?? null,
      source_id: input.sourceId ?? null,
      metadata_json: stringifyJson(input.metadata ?? {}),
      created_at: ts,
      updated_at: ts,
      created_by: input.createdBy ?? null,
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO context_blocks
         (id, project_id, kind, title, content, status, source_type, source_id,
          metadata_json, created_at, updated_at, created_by)
         VALUES (@id, @project_id, @kind, @title, @content, @status, @source_type,
                 @source_id, @metadata_json, @created_at, @updated_at, @created_by)`,
      )
      .run(row);
    const block =
      input.sourceType && input.sourceId
        ? this.findContextBlockBySource(input.projectId, input.sourceType, input.sourceId)
        : this.getContextBlock(row.id);
    const domain = block ?? mapContextBlock(row);
    publish({
      type: SyncEventType.ContextBlockCreated,
      projectId: input.projectId,
      payload: domain,
      timestamp: Date.now(),
    });
    this.appendCoordEvent({
      projectId: input.projectId,
      type: SyncEventType.ContextBlockCreated,
      contextBlockIds: [domain.id],
      payload: { kind: domain.kind, sourceType: domain.sourceType, sourceId: domain.sourceId },
      actorId: input.createdBy ?? null,
    });
    return domain;
  }

  getContextBlock(blockId: string): ContextBlock | null {
    const row = this.db
      .prepare(`SELECT * FROM context_blocks WHERE id = ?`)
      .get(blockId) as ContextBlockRowLike | undefined;
    return row ? mapContextBlock(row) : null;
  }

  findContextBlockBySource(
    projectId: string,
    sourceType: string,
    sourceId: string,
  ): ContextBlock | null {
    const row = this.db
      .prepare(
        `SELECT * FROM context_blocks
         WHERE project_id = ? AND source_type = ? AND source_id = ?`,
      )
      .get(projectId, sourceType, sourceId) as ContextBlockRowLike | undefined;
    return row ? mapContextBlock(row) : null;
  }

  listContextBlocks(projectId: string, limit = 200): ContextBlock[] {
    this.materializeLegacyContext(projectId);
    const rows = this.db
      .prepare(
        `SELECT * FROM context_blocks
         WHERE project_id = ? AND status = 'active'
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(projectId, Math.min(Math.max(limit, 1), 1000)) as ContextBlockRowLike[];
    return rows.map(mapContextBlock);
  }

  createContextBinding(input: NewContextBinding): ContextBinding {
    const existing = this.findContextBinding(input);
    if (existing) return existing;
    const row: ContextBindingRowLike = {
      id: nid('cbn'),
      project_id: input.projectId,
      block_id: input.blockId,
      target_kind: input.targetKind,
      target_id: input.targetId,
      relation: input.relation,
      confidence: input.confidence ?? 1.0,
      metadata_json: stringifyJson(input.metadata ?? {}),
      created_at: now(),
      created_by: input.createdBy ?? null,
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO context_bindings
         (id, project_id, block_id, target_kind, target_id, relation, confidence,
          metadata_json, created_at, created_by)
         VALUES (@id, @project_id, @block_id, @target_kind, @target_id, @relation,
                 @confidence, @metadata_json, @created_at, @created_by)`,
      )
      .run(row);
    const binding = this.findContextBinding(input) ?? mapContextBinding(row);
    publish({
      type: SyncEventType.ContextBindingCreated,
      projectId: input.projectId,
      payload: binding,
      timestamp: Date.now(),
    });
    this.appendCoordEvent({
      projectId: input.projectId,
      type: SyncEventType.ContextBindingCreated,
      nodeId: input.targetKind === 'node' ? input.targetId : null,
      runId: input.targetKind === 'run' ? input.targetId : null,
      contextBlockIds: [input.blockId],
      payload: {
        bindingId: binding.id,
        targetKind: input.targetKind,
        targetId: input.targetId,
        relation: input.relation,
      },
      actorId: input.createdBy ?? null,
    });
    return binding;
  }

  findContextBinding(input: NewContextBinding): ContextBinding | null {
    const row = this.db
      .prepare(
        `SELECT * FROM context_bindings
         WHERE project_id = ? AND block_id = ? AND target_kind = ? AND target_id = ?
           AND relation = ?`,
      )
      .get(input.projectId, input.blockId, input.targetKind, input.targetId, input.relation) as
      | ContextBindingRowLike
      | undefined;
    return row ? mapContextBinding(row) : null;
  }

  deleteContextBinding(bindingId: string): void {
    const row = this.db
      .prepare(`SELECT * FROM context_bindings WHERE id = ?`)
      .get(bindingId) as ContextBindingRowLike | undefined;
    if (!row) return;
    this.db.prepare(`DELETE FROM context_bindings WHERE id = ?`).run(bindingId);
    publish({
      type: SyncEventType.ContextBindingDeleted,
      projectId: row.project_id,
      payload: { id: bindingId },
      timestamp: Date.now(),
    });
    this.appendCoordEvent({
      projectId: row.project_id,
      type: SyncEventType.ContextBindingDeleted,
      nodeId: row.target_kind === 'node' ? row.target_id : null,
      runId: row.target_kind === 'run' ? row.target_id : null,
      contextBlockIds: [row.block_id],
      payload: { bindingId },
    });
  }

  getContextBindingsForTarget(
    projectId: string,
    targetKind: ContextBinding['targetKind'],
    targetId: string,
  ): ContextBinding[] {
    this.materializeLegacyContext(projectId);
    const rows = this.db
      .prepare(
        `SELECT * FROM context_bindings
         WHERE project_id = ? AND target_kind = ? AND target_id = ?
         ORDER BY created_at DESC`,
      )
      .all(projectId, targetKind, targetId) as ContextBindingRowLike[];
    return rows.map(mapContextBinding);
  }

  getNodeContext(
    projectId: string,
    nodeId: string,
  ): { blocks: ContextBlock[]; bindings: ContextBinding[] } {
    const bindings = this.getContextBindingsForTarget(projectId, 'node', nodeId);
    const blocks = bindings
      .map((b) => this.getContextBlock(b.blockId))
      .filter((b): b is ContextBlock => Boolean(b));
    return { blocks, bindings };
  }

  getContextSignal(signalId: string): ContextSignal | null {
    const row = this.db
      .prepare(`SELECT * FROM context_signals WHERE id = ?`)
      .get(signalId) as ContextSignalRowLike | undefined;
    return row ? mapContextSignal(row) : null;
  }

  getContextSignalByBlock(projectId: string, blockId: string): ContextSignal | null {
    const row = this.db
      .prepare(`SELECT * FROM context_signals WHERE project_id = ? AND block_id = ?`)
      .get(projectId, blockId) as ContextSignalRowLike | undefined;
    return row ? mapContextSignal(row) : null;
  }

  findContextSignalBySource(
    projectId: string,
    sourceType: ContextSignal['sourceType'],
    sourceId: string,
    kind: ContextSignal['kind'],
    title: string,
  ): ContextSignal | null {
    const row = this.db
      .prepare(
        `SELECT * FROM context_signals
         WHERE project_id = ? AND source_type = ? AND source_id = ? AND kind = ? AND title = ?`,
      )
      .get(projectId, sourceType, sourceId, kind, title.slice(0, 240)) as ContextSignalRowLike | undefined;
    return row ? mapContextSignal(row) : null;
  }

  createContextSignal(input: NewContextSignal & { id?: string }): ContextSignal {
    const existing = this.findContextSignalBySource(
      input.projectId,
      input.sourceType,
      input.sourceId,
      input.kind,
      input.title,
    );
    if (existing) return existing;
    const ts = now();
    const row: ContextSignalRowLike = {
      id: input.id ?? nid('sig'),
      project_id: input.projectId,
      block_id: input.blockId,
      source_type: input.sourceType,
      source_id: input.sourceId,
      source_node_id: input.sourceNodeId ?? null,
      source_run_id: input.sourceRunId ?? null,
      kind: input.kind,
      title: input.title.slice(0, 240) || input.kind,
      summary: compactText(input.summary, 360),
      content: input.content,
      confidence: clamp01(input.confidence ?? 0.7),
      tags_json: stringifyJson(input.tags ?? []),
      source_links_json: stringifyJson(input.sourceLinks ?? []),
      metadata_json: stringifyJson(input.metadata ?? {}),
      created_at: ts,
      created_by: input.createdBy ?? null,
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO context_signals
         (id, project_id, block_id, source_type, source_id, source_node_id, source_run_id,
          kind, title, summary, content, confidence, tags_json, source_links_json,
          metadata_json, created_at, created_by)
         VALUES (@id, @project_id, @block_id, @source_type, @source_id, @source_node_id,
                 @source_run_id, @kind, @title, @summary, @content, @confidence,
                 @tags_json, @source_links_json, @metadata_json, @created_at, @created_by)`,
      )
      .run(row);
    const signal =
      this.findContextSignalBySource(input.projectId, input.sourceType, input.sourceId, input.kind, input.title) ??
      mapContextSignal(row);
    publish({
      type: SyncEventType.ContextSignalCreated,
      projectId: input.projectId,
      payload: signal,
      timestamp: Date.now(),
    });
    this.appendCoordEvent({
      projectId: input.projectId,
      type: SyncEventType.ContextSignalCreated,
      nodeId: signal.sourceNodeId,
      runId: signal.sourceRunId,
      contextBlockIds: [signal.blockId],
      payload: { signalId: signal.id, kind: signal.kind, confidence: signal.confidence },
      actorId: input.createdBy ?? 'agent',
    });
    return signal;
  }

  createDisclosureSuggestion(input: NewContextDisclosureSuggestion): ContextDisclosureSuggestion {
    const existing = this.db
      .prepare(
        `SELECT * FROM context_disclosure_suggestions
         WHERE project_id = ? AND signal_id = ? AND target_node_id = ? AND relation = ?`,
      )
      .get(input.projectId, input.signalId, input.targetNodeId, input.relation) as
      | ContextDisclosureSuggestionRowLike
      | undefined;
    if (existing) return mapDisclosureSuggestion(existing);
    const ts = now();
    const row: ContextDisclosureSuggestionRowLike = {
      id: nid('cds'),
      project_id: input.projectId,
      signal_id: input.signalId,
      source_node_id: input.sourceNodeId ?? null,
      target_node_id: input.targetNodeId,
      relation: input.relation,
      confidence: clamp01(input.confidence ?? 0.7),
      reason: compactText(input.reason, 360) || 'Related context signal',
      status: input.status ?? 'pending',
      metadata_json: stringifyJson(input.metadata ?? {}),
      created_at: ts,
      updated_at: ts,
      decided_by: input.status === 'auto_applied' ? input.createdBy ?? 'agent' : null,
      decided_at: input.status === 'auto_applied' ? ts : null,
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO context_disclosure_suggestions
         (id, project_id, signal_id, source_node_id, target_node_id, relation,
          confidence, reason, status, metadata_json, created_at, updated_at,
          decided_by, decided_at)
         VALUES (@id, @project_id, @signal_id, @source_node_id, @target_node_id,
                 @relation, @confidence, @reason, @status, @metadata_json,
                 @created_at, @updated_at, @decided_by, @decided_at)`,
      )
      .run(row);
    const suggestion = mapDisclosureSuggestion(row);
    publish({
      type: SyncEventType.ContextDisclosureSuggested,
      projectId: input.projectId,
      payload: suggestion,
      timestamp: Date.now(),
    });
    this.appendCoordEvent({
      projectId: input.projectId,
      type: SyncEventType.ContextDisclosureSuggested,
      nodeId: input.targetNodeId,
      payload: {
        suggestionId: suggestion.id,
        signalId: input.signalId,
        sourceNodeId: input.sourceNodeId ?? null,
        targetNodeId: input.targetNodeId,
        relation: input.relation,
        reason: suggestion.reason,
      },
      actorId: input.createdBy ?? 'agent',
    });
    return suggestion;
  }

  createContextBundle(
    projectId: string,
    title: string,
    blockIds: string[],
    metadata: Record<string, unknown> = {},
    createdBy: string | null = null,
  ): ContextBundle {
    const ts = now();
    const uniqueBlockIds = Array.from(new Set(blockIds));
    const row: ContextBundleRowLike = {
      id: nid('cbu'),
      project_id: projectId,
      title: title.slice(0, 240) || 'Context bundle',
      block_ids_json: JSON.stringify(uniqueBlockIds),
      metadata_json: stringifyJson(metadata),
      created_at: ts,
      updated_at: ts,
      created_by: createdBy,
    };
    this.db
      .prepare(
        `INSERT INTO context_bundles
         (id, project_id, title, block_ids_json, metadata_json, created_at, updated_at, created_by)
         VALUES (@id, @project_id, @title, @block_ids_json, @metadata_json,
                 @created_at, @updated_at, @created_by)`,
      )
      .run(row);
    const bundle = mapContextBundle(row);
    publish({
      type: SyncEventType.ContextBundleCreated,
      projectId,
      payload: bundle,
      timestamp: Date.now(),
    });
    this.appendCoordEvent({
      projectId,
      type: SyncEventType.ContextBundleCreated,
      contextBlockIds: uniqueBlockIds,
      payload: { bundleId: bundle.id, title: bundle.title },
      actorId: createdBy,
    });
    return bundle;
  }

  createRunSnapshot(input: {
    projectId: string;
    nodeId: string;
    runId: string;
    prompt: string;
    includeBlockIds?: string[];
    createdBy?: string | null;
  }): ContextRunSnapshot {
    const existing = this.db
      .prepare(`SELECT * FROM context_run_snapshots WHERE project_id = ? AND run_id = ?`)
      .get(input.projectId, input.runId) as ContextRunSnapshotRowLike | undefined;
    if (existing) return mapContextRunSnapshot(existing);

    this.materializeLegacyContext(input.projectId);
    const nodeBindings = this.getContextBindingsForTarget(input.projectId, 'node', input.nodeId)
      .filter((b) => ['uses', 'references', 'constrains', 'resolves', 'mentions', 'discusses'].includes(b.relation));
    const inputBlockIds = Array.from(
      new Set([...(input.includeBlockIds ?? []), ...nodeBindings.map((b) => b.blockId)]),
    );
    const blocks = inputBlockIds
      .map((id) => this.getContextBlock(id))
      .filter((b): b is ContextBlock => Boolean(b));
    const relationByBlock = new Map(nodeBindings.map((b) => [b.blockId, b.relation]));
    const frozenContext: FrozenContextItem[] = blocks.map((b) => ({
      blockId: b.id,
      kind: b.kind,
      title: b.title,
      content: b.content,
      relation: relationByBlock.get(b.id),
    }));
    const bundle = this.createContextBundle(
      input.projectId,
      `Run ${input.runId.slice(0, 8)} context`,
      inputBlockIds,
      { nodeId: input.nodeId, runId: input.runId },
      input.createdBy ?? null,
    );
    const row: ContextRunSnapshotRowLike = {
      id: nid('crs'),
      project_id: input.projectId,
      node_id: input.nodeId,
      run_id: input.runId,
      bundle_id: bundle.id,
      input_block_ids_json: JSON.stringify(inputBlockIds),
      prompt: input.prompt,
      frozen_context_json: JSON.stringify(frozenContext),
      created_at: now(),
      created_by: input.createdBy ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO context_run_snapshots
         (id, project_id, node_id, run_id, bundle_id, input_block_ids_json,
          prompt, frozen_context_json, created_at, created_by)
         VALUES (@id, @project_id, @node_id, @run_id, @bundle_id,
                 @input_block_ids_json, @prompt, @frozen_context_json,
                 @created_at, @created_by)`,
      )
      .run(row);
    const snapshot = mapContextRunSnapshot(row);
    publish({
      type: SyncEventType.ContextSnapshotCreated,
      projectId: input.projectId,
      payload: snapshot,
      timestamp: Date.now(),
    });
    this.appendCoordEvent({
      projectId: input.projectId,
      type: SyncEventType.ContextSnapshotCreated,
      nodeId: input.nodeId,
      runId: input.runId,
      contextBlockIds: inputBlockIds,
      payload: { snapshotId: snapshot.id, bundleId: bundle.id },
      actorId: input.createdBy ?? null,
    });
    return snapshot;
  }

  attachRunSnapshotToRun(snapshotId: string, runId: string): ContextRunSnapshot | null {
    const existing = this.db
      .prepare(`SELECT * FROM context_run_snapshots WHERE id = ?`)
      .get(snapshotId) as ContextRunSnapshotRowLike | undefined;
    if (!existing) return null;
    if (existing.run_id === runId) return mapContextRunSnapshot(existing);
    this.db
      .prepare(`UPDATE context_run_snapshots SET run_id = ? WHERE id = ?`)
      .run(runId, snapshotId);
    const row = this.db
      .prepare(`SELECT * FROM context_run_snapshots WHERE id = ?`)
      .get(snapshotId) as ContextRunSnapshotRowLike | undefined;
    return row ? mapContextRunSnapshot(row) : null;
  }

  recordAgentLoop(input: NewAgentLoopRecord): AgentLoopRecord {
    const startedAt = input.startedAt ?? now();
    const completedAt =
      input.status === 'running'
        ? input.completedAt ?? null
        : input.completedAt ?? now();
    const existing = this.getAgentLoopByRunId(input.projectId, input.runId);
    if (existing) return existing;

    const tx = this.db.transaction(() => {
      const turnRow: AgentConversationTurnRowLike = {
        id: nid('turn'),
        project_id: input.projectId,
        node_id: input.nodeId ?? null,
        run_id: input.runId,
        user_id: input.userId ?? null,
        raw_input: input.rawInput,
        context_snapshot_id: input.contextSnapshotId ?? null,
        status: input.status,
        metadata_json: stringifyJson(input.metadata ?? {}),
        created_at: startedAt,
        completed_at: completedAt,
      };
      this.db
        .prepare(
          `INSERT INTO agent_conversation_turns
           (id, project_id, node_id, run_id, user_id, raw_input, context_snapshot_id,
            status, metadata_json, created_at, completed_at)
           VALUES (@id, @project_id, @node_id, @run_id, @user_id, @raw_input,
                   @context_snapshot_id, @status, @metadata_json, @created_at, @completed_at)`,
        )
        .run(turnRow);

      const transcript: AgentLoopTranscript = {
        userInput: input.rawInput,
        contextSnapshotId: input.contextSnapshotId ?? null,
        steps: input.steps.map((step, idx) => ({
          sequence: idx + 1,
          kind: step.kind,
          title: step.title,
          content: step.content,
          payload: step.payload ?? {},
          metadata: step.metadata ?? {},
        })),
      };

      const loopRow: AgentLoopRecordRowLike = {
        id: nid('loop'),
        project_id: input.projectId,
        turn_id: turnRow.id,
        node_id: input.nodeId ?? null,
        run_id: input.runId,
        provider: input.provider,
        status: input.status,
        summary: input.summary ?? null,
        final_output: input.finalOutput ?? null,
        context_snapshot_id: input.contextSnapshotId ?? null,
        transcript_json: stringifyJson(transcript),
        file_changes_json: stringifyJson(input.fileChanges ?? []),
        metadata_json: stringifyJson(input.metadata ?? {}),
        started_at: startedAt,
        completed_at: completedAt,
      };
      this.db
        .prepare(
          `INSERT INTO agent_loop_records
           (id, project_id, turn_id, node_id, run_id, provider, status, summary,
            final_output, context_snapshot_id, transcript_json, file_changes_json,
            metadata_json, started_at, completed_at)
           VALUES (@id, @project_id, @turn_id, @node_id, @run_id, @provider, @status,
                   @summary, @final_output, @context_snapshot_id, @transcript_json,
                   @file_changes_json, @metadata_json, @started_at, @completed_at)`,
        )
        .run(loopRow);

      const stepRows: AgentLoopStepRowLike[] = input.steps.map((step, idx) => ({
        id: nid('step'),
        loop_id: loopRow.id,
        project_id: input.projectId,
        run_id: input.runId,
        sequence: idx + 1,
        kind: step.kind,
        title: step.title,
        content: step.content,
        payload_json: stringifyJson(step.payload ?? {}),
        metadata_json: stringifyJson(step.metadata ?? {}),
        created_at: step.createdAt ?? startedAt,
      }));
      const insertStep = this.db.prepare(
        `INSERT INTO agent_loop_steps
         (id, loop_id, project_id, run_id, sequence, kind, title, content,
          payload_json, metadata_json, created_at)
         VALUES (@id, @loop_id, @project_id, @run_id, @sequence, @kind, @title,
                 @content, @payload_json, @metadata_json, @created_at)`,
      );
      for (const step of stepRows) insertStep.run(step);
      return mapAgentLoopRecord(loopRow, stepRows.map(mapAgentLoopStep));
    });

    const record = tx();
    publish({
      type: SyncEventType.CoordEventCreated,
      projectId: input.projectId,
      payload: { runId: input.runId, loopRecordId: record.id },
      timestamp: Date.now(),
    });
    this.appendCoordEvent({
      projectId: input.projectId,
      type: SyncEventType.AgentLoopRecorded,
      nodeId: input.nodeId ?? null,
      runId: input.runId,
      payload: {
        loopRecordId: record.id,
        summary: record.summary,
        status: record.status,
        contextSnapshotId: record.contextSnapshotId,
      },
      actorId: input.userId ?? 'agent',
    });
    return record;
  }

  getAgentLoopByRunId(projectId: string, runId: string): AgentLoopRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM agent_loop_records WHERE project_id = ? AND run_id = ?`)
      .get(projectId, runId) as AgentLoopRecordRowLike | undefined;
    if (!row) return null;
    const stepRows = this.db
      .prepare(`SELECT * FROM agent_loop_steps WHERE loop_id = ? ORDER BY sequence ASC`)
      .all(row.id) as AgentLoopStepRowLike[];
    return mapAgentLoopRecord(row, stepRows.map(mapAgentLoopStep));
  }

  listAgentLoopsByNode(projectId: string, nodeId: string, limit = 20): AgentLoopRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_loop_records
         WHERE project_id = ? AND node_id = ?
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(projectId, nodeId, Math.min(Math.max(limit, 1), 100)) as AgentLoopRecordRowLike[];
    return rows.map((row) => mapAgentLoopRecord(row));
  }

  listContextSignals(projectId: string, limit = 100): ContextSignal[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM context_signals
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(projectId, Math.min(Math.max(limit, 1), 500)) as ContextSignalRowLike[];
    return rows.map(mapContextSignal);
  }

  listDisclosureSuggestions(projectId: string, limit = 200): ContextDisclosureSuggestion[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM context_disclosure_suggestions
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(projectId, Math.min(Math.max(limit, 1), 1000)) as ContextDisclosureSuggestionRowLike[];
    return rows.map(mapDisclosureSuggestion);
  }

  acceptDisclosureSuggestion(suggestionId: string, actorId: string | null = 'web'): ContextDisclosureSuggestion {
    const row = this.db
      .prepare(`SELECT * FROM context_disclosure_suggestions WHERE id = ?`)
      .get(suggestionId) as ContextDisclosureSuggestionRowLike | undefined;
    if (!row) throw new Error(`Disclosure suggestion ${suggestionId} not found`);
    const signal = this.getContextSignal(row.signal_id);
    if (!signal) throw new Error(`Signal ${row.signal_id} not found`);
    this.createContextBinding({
      projectId: row.project_id,
      blockId: signal.blockId,
      targetKind: 'node',
      targetId: row.target_node_id,
      relation: row.relation as ContextBinding['relation'],
      confidence: row.confidence,
      metadata: { suggestionId, signalId: signal.id, sourceNodeId: row.source_node_id },
      createdBy: actorId,
    });
    const ts = now();
    this.db
      .prepare(
        `UPDATE context_disclosure_suggestions
         SET status = 'accepted', updated_at = ?, decided_by = ?, decided_at = ?
         WHERE id = ?`,
      )
      .run(ts, actorId, ts, suggestionId);
    const updated = this.db
      .prepare(`SELECT * FROM context_disclosure_suggestions WHERE id = ?`)
      .get(suggestionId) as ContextDisclosureSuggestionRowLike;
    const suggestion = mapDisclosureSuggestion(updated);
    publish({
      type: SyncEventType.ContextDisclosureUpdated,
      projectId: row.project_id,
      payload: suggestion,
      timestamp: Date.now(),
    });
    this.appendCoordEvent({
      projectId: row.project_id,
      type: SyncEventType.ContextDisclosureAccepted,
      nodeId: row.target_node_id,
      contextBlockIds: [signal.blockId],
      payload: { suggestionId, signalId: signal.id, sourceNodeId: row.source_node_id },
      actorId,
    });
    return suggestion;
  }

  dismissDisclosureSuggestion(suggestionId: string, actorId: string | null = 'web'): ContextDisclosureSuggestion {
    const row = this.db
      .prepare(`SELECT * FROM context_disclosure_suggestions WHERE id = ?`)
      .get(suggestionId) as ContextDisclosureSuggestionRowLike | undefined;
    if (!row) throw new Error(`Disclosure suggestion ${suggestionId} not found`);
    const ts = now();
    this.db
      .prepare(
        `UPDATE context_disclosure_suggestions
         SET status = 'dismissed', updated_at = ?, decided_by = ?, decided_at = ?
         WHERE id = ?`,
      )
      .run(ts, actorId, ts, suggestionId);
    const updated = this.db
      .prepare(`SELECT * FROM context_disclosure_suggestions WHERE id = ?`)
      .get(suggestionId) as ContextDisclosureSuggestionRowLike;
    const suggestion = mapDisclosureSuggestion(updated);
    publish({
      type: SyncEventType.ContextDisclosureUpdated,
      projectId: row.project_id,
      payload: suggestion,
      timestamp: Date.now(),
    });
    this.appendCoordEvent({
      projectId: row.project_id,
      type: SyncEventType.ContextDisclosureDismissed,
      nodeId: row.target_node_id,
      payload: { suggestionId, signalId: row.signal_id, sourceNodeId: row.source_node_id },
      actorId,
    });
    return suggestion;
  }

  shareContextSignal(input: {
    projectId: string;
    signalId: string;
    targetNodeId?: string | null;
    actorId?: string | null;
  }): ContextDisclosureSuggestion[] {
    const signal = this.getContextSignal(input.signalId);
    if (!signal || signal.projectId !== input.projectId) throw new Error(`Signal ${input.signalId} not found`);
    if (input.targetNodeId) {
      return [
        this.createDisclosureSuggestion({
          projectId: input.projectId,
          signalId: signal.id,
          sourceNodeId: signal.sourceNodeId,
          targetNodeId: input.targetNodeId,
          relation:
            signal.kind === 'risk' || signal.kind === 'constraint' || signal.kind === 'correction'
              ? 'constrains'
              : signal.kind === 'decision'
                ? 'uses'
                : 'references',
          confidence: Math.max(0.65, signal.confidence),
          reason: 'Shared manually from Synax Context.',
          createdBy: input.actorId ?? 'web',
        }),
      ];
    }
    return [];
  }

  getSynaxContextForNode(projectId: string, nodeId: string): SynaxNodeContext {
    const blocksById = new Map(this.listContextBlocks(projectId, 500).map((block) => [block.id, block]));
    const signals = this.listContextSignals(projectId, 500).filter((signal) => this.isDisplayableSignal(signal));
    const signalById = new Map(signals.map((signal) => [signal.id, signal]));
    const signalByBlockId = new Map(signals.map((signal) => [signal.blockId, signal]));
    const suggestions = this.listDisclosureSuggestions(projectId, 500);
    const state = this.getCoordinatesState(projectId);
    const incoming = suggestions
      .filter((suggestion) => suggestion.targetNodeId === nodeId && suggestion.status === 'pending')
      .map((suggestion) => {
        const signal = signalById.get(suggestion.signalId);
        if (!signal) return null;
        return { suggestion, signal, block: blocksById.get(signal.blockId) ?? null };
      })
      .filter((item): item is SynaxNodeContext['incoming'][number] => Boolean(item));
    const inputs: SynaxNodeContext['inputs'] = [];
    for (const binding of this.getContextBindingsForTarget(projectId, 'node', nodeId).filter(
      (candidate) => candidate.relation !== 'produces',
    )) {
        const block = blocksById.get(binding.blockId) ?? this.getContextBlock(binding.blockId);
        if (!block) continue;
        inputs.push({ binding, block, signal: signalByBlockId.get(block.id) ?? null });
    }
    const produced = signals
      .filter((signal) => signal.sourceNodeId === nodeId)
      .map((signal) => ({ signal, block: blocksById.get(signal.blockId) ?? null }))
      .slice(0, 20);
    const handoffs: SynaxNodeContext['handoffs'] = [];
    for (const suggestion of suggestions.filter(
      (candidate) => candidate.sourceNodeId === nodeId && candidate.targetNodeId !== nodeId && candidate.status === 'pending',
    )) {
        const signal = signalById.get(suggestion.signalId);
        if (!signal) continue;
        handoffs.push({
          suggestion,
          signal,
          targetLabel: state?.forest.nodes?.[suggestion.targetNodeId]?.label ?? null,
        });
    }
    const recentLoops = this.listAgentLoopsByNode(projectId, nodeId, 8);
    return {
      nodeId,
      incoming,
      inputs,
      produced,
      handoffs: handoffs.slice(0, 20),
      latestLoop: recentLoops[0] ?? null,
      recentLoops,
    };
  }

  private isDisplayableSignal(signal: Pick<ContextSignal, 'kind' | 'title' | 'summary' | 'content' | 'confidence'>): boolean {
    const text = `${signal.title} ${signal.summary} ${signal.content}`;
    if (isMechanicalRunNoise(text)) return false;
    if (signal.kind === 'artifact' && /^tool\s+/i.test(signal.title)) return false;
    if (signal.kind === 'artifact' && /^touched files/i.test(signal.title)) return false;
    if (signal.kind === 'artifact' && /^run completed/i.test(signal.title)) return false;
    return signal.confidence >= 0.6;
  }

  recordRunEvent(input: {
    projectId: string;
    nodeId: string;
    runId: string;
    eventType: string;
    message?: string;
    payload?: Record<string, unknown>;
    actorId?: string | null;
  }): { event: CoordEventLogEntry; blocks: ContextBlock[] } {
    const blocks: ContextBlock[] = [];
    const sourceId = `${input.runId}:${input.eventType}:${String(input.payload?.ts ?? Date.now())}`;
    const message = input.message ?? String(input.payload?.message ?? input.payload?.reason ?? '');
    const shouldPersistAsContextBlock =
      message.trim().length > 0 &&
      ['artifact_proposed', 'artifact_applied', 'run_completed', 'run_failed'].includes(input.eventType);
    if (shouldPersistAsContextBlock) {
      const kind =
        input.eventType === 'artifact_proposed' || input.eventType === 'artifact_applied'
          ? 'artifact'
          : input.eventType === 'run_failed'
            ? 'risk'
            : input.eventType === 'run_completed'
              ? 'artifact'
              : 'entry';
      const block = this.createContextBlock({
        projectId: input.projectId,
        kind,
        title: `${input.eventType.replace(/_/g, ' ')} · ${input.runId.slice(0, 8)}`,
        content: message,
        sourceType: 'run_event',
        sourceId,
        metadata: { nodeId: input.nodeId, runId: input.runId, eventType: input.eventType, payload: input.payload ?? {} },
        createdBy: input.actorId ?? 'agent',
      });
      blocks.push(block);
      this.createContextBinding({
        projectId: input.projectId,
        blockId: block.id,
        targetKind: 'node',
        targetId: input.nodeId,
        relation: kind === 'risk' ? 'constrains' : 'produces',
        createdBy: input.actorId ?? 'agent',
      });
      this.createContextBinding({
        projectId: input.projectId,
        blockId: block.id,
        targetKind: 'run',
        targetId: input.runId,
        relation: kind === 'risk' ? 'constrains' : 'produces',
        createdBy: input.actorId ?? 'agent',
      });
    }
    const event = this.appendCoordEvent({
      projectId: input.projectId,
      type: SyncEventType.RunEventRecorded,
      nodeId: input.nodeId,
      runId: input.runId,
      contextBlockIds: blocks.map((b) => b.id),
      payload: { eventType: input.eventType, ...(input.payload ?? {}) },
      actorId: input.actorId ?? 'agent',
    });
    return { event, blocks };
  }

  recordRunVerdict(input: {
    projectId: string;
    nodeId: string;
    runId: string;
    verdict: 'accepted' | 'rejected';
    note?: string;
    reasons?: string[];
    actorId?: string | null;
  }): ContextBlock {
    const block = this.createContextBlock({
      projectId: input.projectId,
      kind: input.verdict === 'accepted' ? 'decision' : 'correction',
      title: input.verdict === 'accepted' ? 'Run accepted' : 'Run rejected',
      content:
        input.note?.trim() ||
        (input.verdict === 'accepted'
          ? 'The latest run was accepted.'
          : 'The latest run was rejected and requires correction.'),
      sourceType: 'run_verdict',
      sourceId: `${input.runId}:${input.verdict}`,
      metadata: { nodeId: input.nodeId, runId: input.runId, verdict: input.verdict, reasons: input.reasons ?? [] },
      createdBy: input.actorId ?? 'human',
    });
    this.createContextBinding({
      projectId: input.projectId,
      blockId: block.id,
      targetKind: 'node',
      targetId: input.nodeId,
      relation: input.verdict === 'accepted' ? 'resolves' : 'constrains',
      createdBy: input.actorId ?? 'human',
    });
    this.createContextBinding({
      projectId: input.projectId,
      blockId: block.id,
      targetKind: 'run',
      targetId: input.runId,
      relation: input.verdict === 'accepted' ? 'resolves' : 'constrains',
      createdBy: input.actorId ?? 'human',
    });
    this.appendCoordEvent({
      projectId: input.projectId,
      type: SyncEventType.RunVerdictRecorded,
      nodeId: input.nodeId,
      runId: input.runId,
      contextBlockIds: [block.id],
      payload: { verdict: input.verdict, reasons: input.reasons ?? [] },
      actorId: input.actorId ?? 'human',
    });
    return block;
  }

  getCoordinatesContextIndex(projectId: string, limit = 250): CoordinatesContextIndex {
    this.materializeLegacyContext(projectId);
    const blocks = this.listContextBlocks(projectId, limit);
    const blockIds = new Set(blocks.map((b) => b.id));
    const bindingRows = this.db
      .prepare(
        `SELECT * FROM context_bindings
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(projectId, Math.min(Math.max(limit * 2, 1), 1000)) as ContextBindingRowLike[];
    const bindings = bindingRows.map(mapContextBinding).filter((b) => blockIds.has(b.blockId));
    const bundles = (
      this.db
        .prepare(`SELECT * FROM context_bundles WHERE project_id = ? ORDER BY updated_at DESC LIMIT 50`)
        .all(projectId) as ContextBundleRowLike[]
    ).map(mapContextBundle);
    const runSnapshots = (
      this.db
        .prepare(
          `SELECT * FROM context_run_snapshots
           WHERE project_id = ?
           ORDER BY created_at DESC
           LIMIT 100`,
        )
        .all(projectId) as ContextRunSnapshotRowLike[]
    ).map(mapContextRunSnapshot);
    const loopRecords = (
      this.db
        .prepare(
          `SELECT * FROM agent_loop_records
           WHERE project_id = ?
           ORDER BY started_at DESC
           LIMIT 50`,
        )
        .all(projectId) as AgentLoopRecordRowLike[]
    ).map((row) => mapAgentLoopRecord(row));
    const signals = this.listContextSignals(projectId, 100).filter((signal) => this.isDisplayableSignal(signal));
    const visibleSignalIds = new Set(signals.map((signal) => signal.id));
    const disclosureSuggestions = this.listDisclosureSuggestions(projectId, 200).filter((suggestion) =>
      visibleSignalIds.has(suggestion.signalId),
    );
    const recentEvents = this.getCoordEvents(projectId, Math.max(0, this.getHeadRevision(projectId) - 100), 100);
    return {
      blocks,
      bindings,
      bundles,
      runSnapshots,
      loopRecords,
      signals,
      disclosureSuggestions,
      recentEvents,
      headRevision: this.getHeadRevision(projectId),
    };
  }

  suggestContextBlocks(input: {
    projectId: string;
    nodeId?: string | null;
    runId?: string | null;
    limit?: number;
  }): Array<{ block: ContextBlock; relation: ContextBinding['relation']; score: number; reason: string }> {
    this.materializeLegacyContext(input.projectId);
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 30);
    const state = this.getCoordinatesState(input.projectId);
    const node = input.nodeId && state?.forest.nodes ? state.forest.nodes[input.nodeId] : null;
    const query = `${node?.label ?? ''} ${node?.summary ?? ''}`.trim().toLowerCase();
    const alreadyBound = new Set(
      input.nodeId
        ? this.getContextBindingsForTarget(input.projectId, 'node', input.nodeId).map((b) => b.blockId)
        : [],
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM context_blocks
         WHERE project_id = ? AND status = 'active'
         ORDER BY updated_at DESC
         LIMIT 300`,
      )
      .all(input.projectId) as ContextBlockRowLike[];
    const suggestions = rows
      .map(mapContextBlock)
      .filter((b) => !alreadyBound.has(b.id))
      .map((b) => {
        const hay = `${b.title} ${b.content}`.toLowerCase();
        let score = 0.1;
        const reasons: string[] = [];
        if (b.kind === 'memory' || b.kind === 'decision' || b.kind === 'constraint') {
          score += 0.25;
          reasons.push(`${b.kind} block`);
        }
        if (query) {
          const terms = query.split(/\s+/).filter((t) => t.length >= 3);
          const hits = terms.filter((t) => hay.includes(t)).length;
          if (hits > 0) {
            score += Math.min(0.6, hits / Math.max(terms.length, 1));
            reasons.push('matches selected node');
          }
        }
        const refs = b.metadata?.references;
        if (
          input.nodeId &&
          refs &&
          typeof refs === 'object' &&
          Array.isArray((refs as { nodeIds?: unknown }).nodeIds) &&
          (refs as { nodeIds: unknown[] }).nodeIds.includes(input.nodeId)
        ) {
          score += 0.8;
          reasons.push('explicit node reference');
        }
        return {
          block: b,
          relation: b.kind === 'risk' || b.kind === 'constraint' ? 'constrains' as const : 'references' as const,
          score,
          reason: reasons.join(', ') || 'recent project context',
        };
      })
      .filter((s) => s.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (input.runId) {
      return suggestions.map((s) => ({
        ...s,
        reason: `${s.reason}; candidate for run ${input.runId!.slice(0, 8)}`,
      }));
    }
    return suggestions;
  }

  materializeLegacyContext(projectId: string): void {
    const entries = this.db
      .prepare(`SELECT * FROM context_entries WHERE project_id = ? ORDER BY created_at DESC LIMIT 1000`)
      .all(projectId) as EntryRowLike[];
    for (const entry of entries) {
      this.createLegacyBlockForEntry(mapEntry(entry));
    }
    const memories = this.db
      .prepare(`SELECT * FROM project_memories WHERE project_id = ? AND status = 'active'`)
      .all(projectId) as MemoryRowLike[];
    for (const memory of memories) {
      this.createLegacyBlockForMemory(mapMemory(memory));
    }
    const links = this.db
      .prepare(`SELECT * FROM context_links WHERE project_id = ?`)
      .all(projectId) as LinkRowLike[];
    for (const link of links) {
      const block = this.findContextBlockBySource(projectId, 'context_entry', link.entry_id);
      if (!block) continue;
      this.createContextBinding({
        projectId,
        blockId: block.id,
        targetKind: 'node',
        targetId: link.node_id,
        relation: link.link_type as ContextBinding['relation'],
        confidence: link.confidence,
        metadata: { legacyLinkId: link.id },
        createdBy: 'migration',
      });
    }
  }

  private createLegacyBlockForEntry(entry: ContextEntry): ContextBlock {
    return this.createContextBlock({
      projectId: entry.projectId,
      kind: 'entry',
      title: `${entry.role} #${entry.sequence}`,
      content: entry.content,
      sourceType: 'context_entry',
      sourceId: entry.id,
      metadata: {
        sessionId: entry.sessionId,
        sequence: entry.sequence,
        role: entry.role,
        contentType: entry.contentType,
        legacy: true,
      },
      createdBy: entry.role,
    });
  }

  private createLegacyBlockForMemory(memory: ProjectMemory): ContextBlock {
    return this.createContextBlock({
      projectId: memory.projectId,
      kind: 'memory',
      title: memory.title,
      content: memory.content,
      sourceType: 'project_memory',
      sourceId: memory.id,
      metadata: {
        memoryType: memory.memoryType,
        tags: memory.tags,
        confidence: memory.confidence,
        references: memory.references,
        sourceSessionId: memory.sourceSessionId,
        sourceEntryId: memory.sourceEntryId,
        legacy: true,
      },
      createdBy: 'memory-manager',
    });
  }

  // ---------- Link ----------

  createLink(link: NewLink): ContextLink {
    const row: LinkRowLike = {
      id: nid('cl'),
      entry_id: link.entryId,
      node_id: link.nodeId,
      project_id: link.projectId,
      link_type: link.linkType,
      confidence: link.confidence ?? 1.0,
      created_at: now(),
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO context_links
         (id, entry_id, node_id, project_id, link_type, confidence, created_at)
         VALUES (@id, @entry_id, @node_id, @project_id, @link_type, @confidence, @created_at)`,
      )
      .run(row);
    const domain = mapLink(row);
    publish({
      type: SyncEventType.LinkCreated,
      projectId: link.projectId,
      payload: domain,
      timestamp: Date.now(),
    });
    return domain;
  }

  deleteLink(linkId: string): void {
    const row = this.db
      .prepare(`SELECT * FROM context_links WHERE id = ?`)
      .get(linkId) as LinkRowLike | undefined;
    if (!row) return;
    this.db.prepare(`DELETE FROM context_links WHERE id = ?`).run(linkId);
    publish({
      type: SyncEventType.LinkDeleted,
      projectId: row.project_id,
      payload: { id: linkId },
      timestamp: Date.now(),
    });
  }

  getLinksByEntry(entryId: string): ContextLink[] {
    const rows = this.db
      .prepare(`SELECT * FROM context_links WHERE entry_id = ?`)
      .all(entryId) as LinkRowLike[];
    return rows.map(mapLink);
  }

  getLinksByNode(projectId: string, nodeId: string): ContextLink[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM context_links WHERE project_id = ? AND node_id = ? ORDER BY created_at DESC`,
      )
      .all(projectId, nodeId) as LinkRowLike[];
    return rows.map(mapLink);
  }

  // ---------- Export / Import ----------

  /**
   * 导出某个 projectId 下的全部上下文数据。输出结构遵循 ExportPayload，
   * 直接可用于备份、跨实例迁移或在开发时倒入测试数据。
   */
  exportProject(projectId: string): ExportPayload {
    const sessions = (
      this.db
        .prepare(`SELECT * FROM context_sessions WHERE project_id = ?`)
        .all(projectId) as SessionRowLike[]
    ).map(mapSession);
    const entries = (
      this.db
        .prepare(
          `SELECT * FROM context_entries WHERE project_id = ? ORDER BY session_id, sequence`,
        )
        .all(projectId) as EntryRowLike[]
    ).map(mapEntry);
    const snapshots = (
      this.db
        .prepare(`SELECT * FROM context_snapshots WHERE project_id = ?`)
        .all(projectId) as SnapshotRowLike[]
    ).map(mapSnapshot);
    const memories = (
      this.db
        .prepare(`SELECT * FROM project_memories WHERE project_id = ?`)
        .all(projectId) as MemoryRowLike[]
    ).map(mapMemory);
    const links = (
      this.db
        .prepare(`SELECT * FROM context_links WHERE project_id = ?`)
        .all(projectId) as LinkRowLike[]
    ).map(mapLink);

    return {
      projectId,
      exportedAt: now(),
      sessions,
      entries,
      snapshots,
      memories,
      links,
    };
  }

  /**
   * 导入到指定 projectId。
   *   - replace: 先删除该 projectId 现有全部数据，再插入
   *   - merge:   在现有数据基础上追加
   *
   * 重要：sessions / entries / snapshots / memories / links 的主键都是全局唯一的，
   * 为避免跨项目导入时与源项目数据发生 PK 冲突（导致 ignore 或者 replace 操源项目），
   * 当 data.projectId !== projectId 时一律重生成新 id，并重映射外键。
   * 同项目导入（如备份恢复）则保留原 id。
   */
  importProject(
    projectId: string,
    data: ExportPayload,
    strategy: ImportStrategy = 'merge',
  ): ImportResult {
    const tx = this.db.transaction(() => {
      if (strategy === 'replace') {
        // 依赖 ON DELETE CASCADE：删 sessions 会级联 entries/snapshots
        this.db
          .prepare(`DELETE FROM context_links WHERE project_id = ?`)
          .run(projectId);
        this.db
          .prepare(`DELETE FROM project_memories WHERE project_id = ?`)
          .run(projectId);
        this.db
          .prepare(`DELETE FROM context_sessions WHERE project_id = ?`)
          .run(projectId);
      }

      // 跨项目导入：重生成所有主键并重映射外键，防止 PK 冲突损坏源项目
      // 不依赖 data.projectId（可能被调用方覆写），而是看实体行内的 projectId 与 target 是否一致
      const sourceProjectId =
        data.sessions[0]?.projectId ??
        data.entries[0]?.projectId ??
        data.memories[0]?.projectId ??
        data.links[0]?.projectId ??
        data.snapshots[0]?.projectId ??
        data.projectId ??
        projectId;
      const crossProject = sourceProjectId !== projectId;
      const sessionMap = new Map<string, string>();
      const entryMap = new Map<string, string>();
      const snapshotMap = new Map<string, string>();
      const memoryMap = new Map<string, string>();
      const linkMap = new Map<string, string>();
      for (const s of data.sessions) sessionMap.set(s.id, crossProject ? nid('cs') : s.id);
      for (const e of data.entries) entryMap.set(e.id, crossProject ? nid('ce') : e.id);
      for (const sn of data.snapshots) snapshotMap.set(sn.id, crossProject ? nid('cn') : sn.id);
      for (const m of data.memories) memoryMap.set(m.id, crossProject ? nid('pm') : m.id);
      for (const l of data.links) linkMap.set(l.id, crossProject ? nid('cl') : l.id);

      // merge: 同项目时 id 可能已存在 → IGNORE；跨项目由于重生成 id，不会冲突
      // replace: 已先清空目标项目，INSERT 即可；但为防单次导入 payload 内重复 id依然用 OR REPLACE
      const verb = strategy === 'replace' ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';

      const insSession = this.db.prepare(
        `${verb} INTO context_sessions (
          id, project_id, user_id, status, title, summary,
          token_count, entry_count, source_agent,
          created_at, updated_at, expires_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insEntry = this.db.prepare(
        `${verb} INTO context_entries (
          id, session_id, project_id, sequence, role, content, content_type,
          token_estimate, metadata, parent_entry_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insSnap = this.db.prepare(
        `${verb} INTO context_snapshots (
          id, session_id, project_id, label,
          from_sequence, to_sequence, entry_count,
          compressed_content, diff_base_id, created_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insMem = this.db.prepare(
        `${verb} INTO project_memories (
          id, project_id, memory_type, title, content,
          source_session_id, source_entry_id, tags, confidence,
          access_count, references_json, status,
          created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insLink = this.db.prepare(
        `${verb} INTO context_links (
          id, entry_id, node_id, project_id, link_type, confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      let sCount = 0;
      for (const s of data.sessions) {
        const r = insSession.run(
          sessionMap.get(s.id)!,
          projectId,
          s.userId,
          s.status,
          s.title,
          s.summary,
          s.tokenCount,
          s.entryCount,
          s.sourceAgent,
          s.createdAt,
          s.updatedAt,
          s.expiresAt,
          s.archivedAt,
        );
        if (r.changes > 0) sCount++;
      }

      let eCount = 0;
      for (const e of data.entries) {
        const r = insEntry.run(
          entryMap.get(e.id)!,
          sessionMap.get(e.sessionId) ?? e.sessionId,
          projectId,
          e.sequence,
          e.role,
          e.content,
          e.contentType,
          e.tokenEstimate,
          JSON.stringify(e.metadata ?? {}),
          e.parentEntryId ? (entryMap.get(e.parentEntryId) ?? e.parentEntryId) : null,
          e.createdAt,
        );
        if (r.changes > 0) eCount++;
      }

      let snCount = 0;
      for (const sn of data.snapshots) {
        const r = insSnap.run(
          snapshotMap.get(sn.id)!,
          sessionMap.get(sn.sessionId) ?? sn.sessionId,
          projectId,
          sn.label,
          sn.fromSequence,
          sn.toSequence,
          sn.entryCount,
          sn.compressedContent,
          sn.diffBaseId ? (snapshotMap.get(sn.diffBaseId) ?? sn.diffBaseId) : null,
          sn.createdAt,
          sn.createdBy,
        );
        if (r.changes > 0) snCount++;
      }

      let mCount = 0;
      for (const m of data.memories) {
        const r = insMem.run(
          memoryMap.get(m.id)!,
          projectId,
          m.memoryType,
          m.title,
          m.content,
          m.sourceSessionId ? (sessionMap.get(m.sourceSessionId) ?? m.sourceSessionId) : null,
          m.sourceEntryId ? (entryMap.get(m.sourceEntryId) ?? m.sourceEntryId) : null,
          JSON.stringify(m.tags ?? []),
          m.confidence,
          m.accessCount ?? 0,
          JSON.stringify(m.references ?? {}),
          m.status,
          m.createdAt,
          m.updatedAt,
          m.expiresAt,
        );
        if (r.changes > 0) mCount++;
      }

      let lCount = 0;
      for (const l of data.links) {
        const r = insLink.run(
          linkMap.get(l.id)!,
          entryMap.get(l.entryId) ?? l.entryId,
          l.nodeId,
          projectId,
          l.linkType,
          l.confidence,
          l.createdAt,
        );
        if (r.changes > 0) lCount++;
      }

      return {
        sessions: sCount,
        entries: eCount,
        snapshots: snCount,
        memories: mCount,
        links: lCount,
      };
    });

    const result = tx();
    // 导入后广播一个汇总事件，前端可进行 refreshAll
    publish({
      type: SyncEventType.SessionUpdated,
      projectId,
      payload: { imported: result } as unknown,
      timestamp: Date.now(),
    });
    return result;
  }
}

// 单例（ContextDb 是全局单例，Service 也对应单例即可）
export const contextService = new ContextService();
