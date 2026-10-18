import { getRawSqlite } from '../../../../infrastructure/database/index.js';
import { mapLegacyHistoryRow } from "../../../../../../scripts/runtime-migration/records.js";
import type { AgentSession } from '../../contracts.js';
import { historySessionFields, versionRepository } from './bridge.js';
import { VersionHeads } from '../version-store/heads.js';
import { retainVersionRecordAssets } from "./assets.js";
import type { RuntimeContentPart } from "../../content-parts.js";
import { randomUUID } from 'node:crypto';

/** Read the first before-image after a boundary, without undoing live tables or
 * materializing the whole legacy audit history. Absence means current state. */
function rowAt(sessionId: string, table: string, id: string, cursor: number): Record<string, unknown> | undefined {
  const db = getRawSqlite();
  const undo = db.prepare('SELECT before_json FROM conversation_history_journal WHERE session_id=? AND table_name=? AND record_key=? AND sequence>? ORDER BY sequence LIMIT 1')
    .get(sessionId, table, id, cursor) as { before_json: string | null } | undefined;
  if (undo) return undo.before_json ? JSON.parse(undo.before_json) : undefined;
  return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown> | undefined;
}
export function readMigrationSession(sessionId: string): AgentSession {
  const row = getRawSqlite().prepare('SELECT * FROM agent_runtime_sessions WHERE id=?').get(sessionId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Migration session is missing: ${sessionId}`);
  return mapLegacyHistoryRow('agent_runtime_sessions', row) as unknown as AgentSession;
}
export function reconstructedFields(session: AgentSession): Record<string, unknown> {
  const metadata = { ...session.sessionMetadata };
  for (const key of ['activeWorkId', 'contextCompactionState', 'contextEpoch', 'goal', 'latestSystemPrompt', 'pendingResume', 'inputQueue', 'runtimeControl', 'turnReferences']) delete metadata[key];
  return historySessionFields({ ...session, contextSnapshotId: null, resultSummary: null, sessionMetadata: metadata });
}

/** Copy the decision state available at an actual legacy checkpoint. Execution
 * audit/authorization/usage are deliberately not restored into executable state. */
export function attachLegacyDecisionState(stageId: string, source: AgentSession, cursor = Number.MAX_SAFE_INTEGER, at = new Date().toISOString()): void {
  const db = getRawSqlite(), repo = versionRepository();
  const sessionRow = rowAt(source.id, 'agent_runtime_sessions', source.id, cursor);
  const historical = sessionRow ? mapLegacyHistoryRow('agent_runtime_sessions', sessionRow) as unknown as AgentSession : source;
  repo.session(stageId, historySessionFields(historical));
  const fields = [
    ['agent_runtime_context_bundles', 'contexts', historical.contextSnapshotId],
    ['agent_runtime_work', 'work', historical.sessionMetadata?.activeWorkId],
  ] as const;
  for (const [table, kind, identity] of fields) {
    if (typeof identity !== 'string' || !identity) continue;
    const row = rowAt(source.id, table, identity, cursor);
    if (row) repo.put(stageId, kind, identity, { ...mapLegacyHistoryRow(table, row), __synaxExecutionEpoch: 0 });
  }
  const compaction = db.prepare(`SELECT id FROM (
    SELECT id,created_at FROM agent_runtime_compaction_summaries WHERE session_id=?
    UNION SELECT record_key AS id,json_extract(before_json,'$.created_at') AS created_at
      FROM conversation_history_journal WHERE session_id=? AND table_name='agent_runtime_compaction_summaries' AND sequence>? AND before_json IS NOT NULL
    ) WHERE created_at<=? ORDER BY created_at DESC LIMIT 1`).get(source.id, source.id, cursor, at) as { id: string } | undefined;
  if (compaction) {
    const row = rowAt(source.id, 'agent_runtime_compaction_summaries', compaction.id, cursor);
    if (row) repo.put(stageId, 'compactions', compaction.id, { ...mapLegacyHistoryRow('agent_runtime_compaction_summaries', row), __synaxExecutionEpoch: 0 });
  }
}
export function legacyCheckpointVersion(prefixVersion: string, source: AgentSession, boundary: { cursor?: number; legacy?: boolean }, at: string): { versionId: string; messageCount: number; cleanup(): void } {
  const db = getRawSqlite(), repo = versionRepository();
  const temporary = `jsonl_boundary_${randomUUID()}`;
  if (!boundary.legacy && Number.isSafeInteger(boundary.cursor)) {
    repo.create(temporary, reconstructedFields(source));
    // Use the earliest before-image after the checkpoint for each message.
    // Read only message rows; never materialize all runs/tools/events to migrate
    // one boundary. Keyset pages bound memory even for long legacy histories.
    let afterSequence = -1, afterId = "";
    for (;;) {
      const rows = db.prepare(`WITH first_undo AS (
        SELECT record_key,min(sequence) AS sequence FROM conversation_history_journal
        WHERE session_id=? AND table_name='agent_runtime_messages' AND sequence>? GROUP BY record_key
      ), historical AS (
        SELECT m.id,m.sequence,json_object('id',m.id,'session_id',m.session_id,'run_id',m.run_id,'step_id',m.step_id,
          'role',m.role,'content',m.content,'content_parts_json',m.content_parts_json,'metadata_json',m.metadata_json,'created_at',m.created_at) AS body
        FROM agent_runtime_messages m WHERE m.session_id=? AND NOT EXISTS(SELECT 1 FROM first_undo u WHERE u.record_key=m.id)
        UNION ALL
        SELECT u.record_key,CAST(json_extract(j.before_json,'$.sequence') AS INTEGER),j.before_json
        FROM first_undo u JOIN conversation_history_journal j ON j.sequence=u.sequence WHERE j.before_json IS NOT NULL
      ) SELECT id,sequence,length(CAST(body AS BLOB)) AS bytes FROM historical
        WHERE sequence>? OR (sequence=? AND id>?) ORDER BY sequence,id LIMIT 16`)
        .all(source.id, boundary.cursor!, source.id, afterSequence, afterSequence, afterId) as { id: string; sequence: number; bytes: number }[];
      if (!rows.length) break;
      for (const row of rows) {
        if (row.bytes > 16 * 1024 * 1024 + 4096) throw new Error("Legacy checkpoint message exceeds migration record budget.");
        const original = rowAt(source.id, 'agent_runtime_messages', row.id, boundary.cursor!);
        if (!original) throw new Error("Legacy checkpoint message disappeared during migration.");
        const fields = mapLegacyHistoryRow('agent_runtime_messages', original);
        repo.put(temporary, 'messages', row.id, fields);
        if (Array.isArray(fields.contentParts)) retainVersionRecordAssets(temporary, 'messages', row.id, fields.contentParts as RuntimeContentPart[], source.id);
        afterSequence = row.sequence; afterId = row.id;
      }
    }
    attachLegacyDecisionState(temporary, source, boundary.cursor, at);
  } else new VersionHeads(db, repo.objects).create(temporary, prefixVersion);
  return { versionId: repo.head(temporary).versionId, messageCount: repo.count(temporary, "messages"), cleanup() {
    db.prepare('DELETE FROM conversation_v3_owned_versions WHERE session_id=?').run(temporary);
    db.prepare('DELETE FROM conversation_v3_heads WHERE session_id=?').run(temporary);
  } };
}
