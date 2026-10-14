import { randomUUID, createHash } from 'node:crypto';
import { setImmediate as yieldNow } from 'node:timers/promises';
import path from 'node:path';
import { getRawSqlite } from '../../../../infrastructure/database/index.js';
import { DATA_ROOT } from '../../../../infrastructure/runtime/env.js';
import { readTranscript } from '../../../../infrastructure/storage/transcript-jsonl.js';
import { AgentRuntimeError } from '../../runtime-errors.js';
import { mapLegacyHistoryRow } from '../../session-store.js';
import type { AgentSession } from '../../contracts.js';
import type { RuntimeContentPart } from '../../content-parts.js';
import { historyRevision } from "../guards.js";
import { atomicVersionWrite } from '../version-store/transaction.js';
import { hashBytes } from '../version-store/hash-codec.js';
import { VersionHeads } from '../version-store/heads.js';
import { versionRepository, versionedSession, historySessionFields } from './bridge.js';
import type { RuntimeCheckpoint } from './checkpoint-index.js';
import { retainVersionRecordAssets } from './assets.js';
import { attachLegacyDecisionState, legacyCheckpointVersion, readMigrationSession, reconstructedFields } from './jsonl-migration-state.js';

interface Migration {
  session_id: string; stage_id: string; source_backend: 'v3' | 'jsonl' | 'legacy';
  source_revision: number; source_version_id: string | null; source_cursor: string | null;
  after_sequence: number; after_rowid: number; copied_count: number; verified_count: number;
  state: 'copying' | 'verified' | 'published';
}
interface MessageSource {
  id: string; fields: Record<string, unknown>; reference?: string; sequence?: number; rowid?: number;
}
export interface JsonlMigrationResult { sessionId: string; messages: number; checkpoints: number; migrated: boolean }
const fail = (message: string, code = 'JSONL_HISTORY_MIGRATION_FAILED') => new AgentRuntimeError(message, code, 409);
const MAX_RECORD_BYTES = 16 * 1024 * 1024 + 4096;
function sourceRevision(id: string): number {
  const db = getRawSqlite();
  if (versionedSession(id)) return versionRepository().head(id).revision;
  const transcript = db.prepare('SELECT revision FROM transcript_heads WHERE session_id=?').get(id) as { revision: number } | undefined;
  if (transcript) return transcript.revision;
  return historyRevision(id);
}
function sourceCount(migration: Migration): number {
  if (migration.source_backend === 'v3') return versionRepository().count(migration.session_id, 'messages');
  return Number((getRawSqlite().prepare(migration.source_backend === 'jsonl'
    ? 'SELECT count(*) AS n FROM transcript_records WHERE session_id=? AND visible=1'
    : 'SELECT count(*) AS n FROM agent_runtime_messages WHERE session_id=?').get(migration.session_id) as { n: number }).n);
}
function sourcePage(migration: Migration): { items: MessageSource[]; next?: string } {
  const db = getRawSqlite(), repo = versionRepository(), id = migration.session_id;
  if (migration.source_backend === 'v3') {
    if (migration.source_cursor === 'done') return { items: [] };
    const page = repo.page(id, 'messages', { limit: 16, maxBytes: 512 * 1024, fields: ['id','role','runId','stepId','createdAt'], cursor: migration.source_cursor ?? undefined });
    return { items: page.items.map(fields => {
      const reference = repo.recordReference(id, 'messages', String(fields.id))!;
      return { id: String(fields.id), reference, fields };
    }), next: page.next ?? 'done' };
  }
  if (migration.source_backend === 'jsonl') {
    const head = db.prepare('SELECT segment,committed_bytes FROM transcript_heads WHERE session_id=?').get(id) as { segment: string; committed_bytes: number };
    const rows = db.prepare('SELECT message_id,sequence,offset,length,hash FROM transcript_records WHERE session_id=? AND visible=1 AND sequence>? ORDER BY sequence LIMIT 16').all(id, migration.after_sequence) as { message_id: string; sequence: number; offset: number; length: number; hash: string }[];
    return { items: rows.map(row => {
      if (row.offset + row.length > head.committed_bytes) throw fail('Legacy JSONL points beyond committed bytes.');
      const record = readTranscript(path.resolve(DATA_ROOT), head.segment, row.offset, row.length);
      if (record.hash !== row.hash || record.kind !== 'message' || createHash('sha256').update(record.payload).digest('hex') !== row.hash) throw fail('Legacy JSONL identity mismatch.');
      const fields = JSON.parse(record.payload.toString('utf8')) as Record<string, unknown>;
      if (fields.id !== row.message_id || fields.sessionId !== id) throw fail('Legacy JSONL owner mismatch.');
      return { id: row.message_id, fields, sequence: row.sequence };
    }) };
  }
  const rows = db.prepare(`SELECT id,sequence,rowid AS rowid,length(CAST(content AS BLOB))+coalesce(length(CAST(content_parts_json AS BLOB)),0)+coalesce(length(CAST(metadata_json AS BLOB)),0) AS bytes
    FROM agent_runtime_messages WHERE session_id=? AND (sequence>? OR (sequence=? AND rowid>?)) ORDER BY sequence,rowid LIMIT 16`)
    .all(id, migration.after_sequence, migration.after_sequence, migration.after_rowid) as { id: string; sequence: number; rowid: number; bytes: number }[];
  return { items: rows.map(row => {
    if (row.bytes > MAX_RECORD_BYTES) throw fail('A legacy message exceeds the migration record budget; source data was preserved.');
    return { id: row.id, sequence: row.sequence, rowid: row.rowid, fields: {} };
  }) };
}
function importAssets(stage: string, source: AgentSession, message: MessageSource): void {
  const db = getRawSqlite(), repo = versionRepository();
  if (message.reference) {
    const target = repo.recordReference(stage, 'messages', message.id)!;
    const assets = db.prepare('SELECT asset_id FROM conversation_v3_asset_refs WHERE object_hash=:hash').all({ hash: hashBytes(message.reference) }) as { asset_id: string }[];
    for (const asset of assets) {
      db.prepare('INSERT OR IGNORE INTO conversation_v3_asset_refs(object_hash,asset_id) VALUES(?,?)').run(hashBytes(target), asset.asset_id);
      if (!repo.recordReference(stage, 'assets', asset.asset_id)) {
        repo.put(stage, 'assets', asset.asset_id, { assetId: asset.asset_id, projectId: source.projectId });
        db.prepare('INSERT OR IGNORE INTO conversation_v3_asset_refs(object_hash,asset_id) VALUES(?,?)').run(hashBytes(repo.recordReference(stage, 'assets', asset.asset_id)!), asset.asset_id);
      }
    }
    return;
  }
  const parts = message.fields.contentParts as RuntimeContentPart[] | undefined;
  if (!Array.isArray(parts)) return;
  retainVersionRecordAssets(stage, 'messages', message.id, parts, source.id);
  for (const part of parts) {
    if (part.type === 'text') continue;
    if (!repo.recordReference(stage, 'assets', part.assetId)) {
      repo.put(stage, 'assets', part.assetId, { assetId: part.assetId, projectId: source.projectId });
      const ref = repo.recordReference(stage, 'assets', part.assetId)!;
      db.prepare('INSERT OR IGNORE INTO conversation_v3_asset_refs(object_hash,asset_id) VALUES(?,?)').run(hashBytes(ref), part.assetId);
    }
  }
}
function boundary(migration: Migration, source: AgentSession, message: MessageSource, kind: 'input' | 'reply'): void {
  const db = getRawSqlite(), repo = versionRepository();
  let original: RuntimeCheckpoint | undefined;
  if (migration.source_backend === 'v3') original = repo.checkpointForMessage(source.id, kind, message.id);
  const legacy = migration.source_backend !== 'v3'
    ? db.prepare('SELECT id,payload_json,mutation_cursor,created_at FROM conversation_checkpoints WHERE session_id=? AND kind=? AND message_id=? ORDER BY ordinal DESC LIMIT 1').get(source.id, kind, message.id) as { id: string; payload_json: string; mutation_cursor: number; created_at: string } | undefined
    : undefined;
  let versionId = original?.payload.versionId ?? repo.head(migration.stage_id).versionId;
  let cleanup: (() => void) | undefined;
  let historicalMessageCount: number | undefined;
  const legacyPayload = legacy ? JSON.parse(legacy.payload_json) as { version: number; boundary?: { cursor?: number; legacy?: boolean; omitRunId?: string } } : undefined;
  if (legacyPayload?.version === 2 && legacyPayload.boundary) {
    const historical = legacyCheckpointVersion(versionId, source, legacyPayload.boundary, legacy!.created_at);
    versionId = historical.versionId; cleanup = historical.cleanup; historicalMessageCount = historical.messageCount;
  }
  const accurateLegacy = Boolean(legacyPayload?.version === 2 && legacyPayload.boundary && !legacyPayload.boundary.legacy);
  const cp = repo.importBoundary(migration.stage_id, {
    sessionId: source.id, kind, messageId: message.id,
    stepId: typeof message.fields.stepId === 'string' ? message.fields.stepId : null,
    mutationCursor: original?.mutationCursor ?? legacy?.mutation_cursor ?? 0,
    createdAt: original?.createdAt ?? legacy?.created_at ?? String(message.fields.createdAt ?? source.createdAt),
    payload: { version: 3, versionId, transcriptOnly: !original && !accurateLegacy,
      boundary: { cursor: 0, sessionIds: [source.id], messageCount: original?.payload.boundary.messageCount ?? historicalMessageCount ?? repo.count(migration.stage_id, 'messages'),
        ...(original?.payload.boundary.omitRunId || legacyPayload?.boundary?.omitRunId ? { omitRunId: original?.payload.boundary.omitRunId ?? legacyPayload?.boundary?.omitRunId } : {}) } },
  });
  db.prepare('INSERT OR IGNORE INTO conversation_v3_owned_versions(session_id,version_id) VALUES(?,?)').run(migration.stage_id, hashBytes(versionId));
  if (original || legacy) db.prepare('INSERT INTO jsonl_checkpoint_aliases(session_id,old_id,new_id) VALUES(?,?,?) ON CONFLICT(session_id,old_id) DO UPDATE SET new_id=excluded.new_id,published=0')
    .run(source.id, original?.id ?? legacy!.id, cp.id);
  cleanup?.();
}
function isReply(fields: Record<string, unknown>): boolean {
  const metadata = fields.metadata as Record<string, unknown> | undefined;
  return fields.role === 'assistant' && !metadata?.partial && metadata?.type !== 'thinking' && metadata?.kind !== 'thought';
}

/** Resumable source -> staging -> verified -> published migration. No source
 * body or checkpoint is deleted; publication changes only the active pointers. */
export async function migrateJsonlSession(sessionId: string, options: { offline?: boolean; maxPages?: number; onProgress?: (value: { sessionId: string; copied: number }) => void } = {}): Promise<JsonlMigrationResult> {
  const db = getRawSqlite(), repo = versionRepository();
  if (!repo.objects.jsonl) throw fail('JSONL payload storage must be enabled before migration.');
  const read = () => db.prepare('SELECT * FROM jsonl_history_migrations WHERE session_id=?').get(sessionId) as Migration | undefined;
  const stored = db.prepare("SELECT 1 FROM session_history_storage WHERE session_id=? AND backend='jsonl-v3'").get(sessionId);
  if (stored) return { sessionId, messages: repo.count(sessionId, 'messages'), checkpoints: Number((db.prepare('SELECT next_checkpoint-1 AS n FROM conversation_v3_heads WHERE session_id=?').get(sessionId) as { n: number }).n), migrated: false };
  const source = readMigrationSession(sessionId);
  const canRollback = !source.parentSessionId && (((source.sessionMetadata?.backend as { id?: string })?.id ?? 'native') === 'native') && source.sessionMetadata?.historyRollbackEnabled !== false &&
    (db.prepare('SELECT rollback_enabled FROM conversation_v3_heads WHERE session_id=?').get(sessionId) as { rollback_enabled: number } | undefined)?.rollback_enabled !== 0;
  if (!options.offline && (source.activeRunId || ['running','queued','waiting_input','waiting_permission'].includes(source.status) || db.prepare("SELECT 1 FROM agent_runtime_runs WHERE session_id=? AND (status IN ('running','queued') OR json_extract(metadata_json,'$.executionLease.closed')=0) LIMIT 1").get(sessionId))) throw fail('Stop this session before migrating its history.', 'HISTORY_SESSION_BUSY');
  if (!options.offline && db.prepare("SELECT 1 FROM agent_runtime_processes WHERE session_id=? AND state<>'closed' LIMIT 1").get(sessionId)) throw fail('Stop background processes before migration.', 'HISTORY_PROCESS_ACTIVE');
  if (db.prepare("SELECT 1 FROM conversation_history_operations WHERE session_id=? AND state IN ('prepared','applying','recovery_required','fork_preparing') LIMIT 1").get(sessionId)) throw fail('Finish or recover the existing history operation before migration.', 'HISTORY_LOCKED');
  let migration = read();
  if (!migration) {
    atomicVersionWrite(db, () => {
      const stage = `jsonl_migration_${randomUUID()}`;
      const backend = versionedSession(sessionId) ? 'v3' : db.prepare('SELECT 1 FROM transcript_heads WHERE session_id=?').get(sessionId) ? 'jsonl' : 'legacy';
      const version = backend === 'v3' ? repo.head(sessionId).versionId : null;
      const revision = sourceRevision(sessionId);
      repo.create(stage, reconstructedFields(source));
      db.prepare("UPDATE conversation_v3_heads SET runtime_mode='native',boundary_only=1,full_history=1 WHERE session_id=?").run(stage);
      db.prepare('INSERT INTO jsonl_history_migrations(session_id,stage_id,source_backend,source_revision,source_version_id,updated_at) VALUES(?,?,?,?,?,?)')
        .run(sessionId, stage, backend, revision, version, new Date().toISOString());
    });
    migration = read()!;
  }
  if (migration.state === 'published') throw fail('Published migration is missing its backend marker.');
  try {
    let pages = 0;
    while (migration.state === 'copying') {
      if (sourceRevision(sessionId) !== migration.source_revision) throw fail('Source history changed while being copied.', 'HISTORY_STALE');
      const page = sourcePage(migration);
      if (!page.items.length) {
        atomicVersionWrite(db, () => {
          if (migration!.source_backend !== 'v3') attachLegacyDecisionState(migration!.stage_id, source);
          if (repo.count(migration!.stage_id, 'messages') !== sourceCount(migration!)) throw fail('Message count verification failed.');
          db.prepare("UPDATE jsonl_history_migrations SET state='verified',verified_count=copied_count,updated_at=? WHERE session_id=?").run(new Date().toISOString(), sessionId);
        });
        migration = read()!; break;
      }
      atomicVersionWrite(db, () => {
        for (const message of page.items) {
          if (migration!.source_backend === 'legacy') {
            const row = db.prepare('SELECT * FROM agent_runtime_messages WHERE session_id=? AND rowid=?').get(source.id, message.rowid!) as Record<string, unknown>;
            message.fields = mapLegacyHistoryRow('agent_runtime_messages', row);
          } else if (message.reference) {
            message.fields = { ...message.fields, ...repo.records.read(message.reference, MAX_RECORD_BYTES, ['metadata']) };
          }
          if (canRollback && message.fields.role === 'user') boundary(migration!, source, message, 'input');
          if (message.reference) repo.putBatch(migration!.stage_id, [{ table: 'messages', id: message.id, copyFrom: message.reference, fields: {} }]);
          else repo.put(migration!.stage_id, 'messages', message.id, message.fields);
          const destination = repo.recordReference(migration!.stage_id, 'messages', message.id)!;
          if (message.reference && JSON.stringify(repo.records.header(message.reference).fields) !== JSON.stringify(repo.records.header(destination).fields)) throw fail('Message field references changed during migration.');
          if (!message.reference) {
            const actual = repo.get(migration!.stage_id, 'messages', message.id, MAX_RECORD_BYTES)!;
            if (JSON.stringify(actual) !== JSON.stringify(JSON.parse(JSON.stringify(message.fields)))) throw fail('Legacy message verification failed.');
          }
          importAssets(migration!.stage_id, source, message);
          if (canRollback && isReply(message.fields)) boundary(migration!, source, message, 'reply');
          migration!.copied_count++;
          migration!.after_sequence = message.sequence ?? migration!.after_sequence;
          migration!.after_rowid = message.rowid ?? migration!.after_rowid;
          message.fields = {}; // release large legacy DTOs before the next record
        }
        db.prepare('UPDATE jsonl_history_migrations SET copied_count=?,after_sequence=?,after_rowid=?,source_cursor=?,updated_at=?,error=NULL WHERE session_id=?')
          .run(migration!.copied_count, migration!.after_sequence, migration!.after_rowid, page.next ?? null, new Date().toISOString(), sessionId);
      });
      migration = read()!;
      options.onProgress?.({ sessionId, copied: migration.copied_count });
      if (++pages >= (options.maxPages ?? Number.MAX_SAFE_INTEGER)) throw fail('Migration paused at a durable page boundary.', 'JSONL_MIGRATION_PAUSED');
      await yieldNow();
    }
    atomicVersionWrite(db, () => {
      if (sourceRevision(sessionId) !== migration!.source_revision) throw fail('Source revision changed before publication.', 'HISTORY_STALE');
      const stage = db.prepare('SELECT * FROM conversation_v3_heads WHERE session_id=?').get(migration!.stage_id) as Record<string, unknown>;
      // Release the source fence and switch all pointers in the same transaction.
      db.prepare("UPDATE jsonl_history_migrations SET state='published',updated_at=? WHERE session_id=?").run(new Date().toISOString(), sessionId);
      if (migration!.source_backend !== 'v3') {
        new VersionHeads(db, repo.objects).create(sessionId, repo.head(migration!.stage_id).versionId, source.parentSessionId ? { appendOnly: true } : undefined);
        const nativeRoot = !source.parentSessionId && (((source.sessionMetadata?.backend as { id?: string })?.id ?? 'native') === 'native') && source.sessionMetadata?.historyRollbackEnabled !== false;
        db.prepare("UPDATE conversation_v3_heads SET runtime_mode='native',boundary_only=1,legacy_runtime=1,rollback_enabled=? WHERE session_id=?").run(nativeRoot ? 1 : 0, sessionId);
      }
      if (canRollback) db.prepare('UPDATE conversation_v3_heads SET checkpoint_root=?,checkpoint_identity_root=?,next_checkpoint=?,file_retention_floor=?,full_history=1,revision=revision+1 WHERE session_id=?')
        .run(stage.checkpoint_root, stage.checkpoint_identity_root, stage.next_checkpoint, stage.file_retention_floor, sessionId);
      else db.prepare('UPDATE conversation_v3_heads SET full_history=1,revision=revision+1 WHERE session_id=?').run(sessionId);
      db.prepare('INSERT OR IGNORE INTO conversation_v3_owned_versions(session_id,version_id) SELECT ?,version_id FROM conversation_v3_owned_versions WHERE session_id=?').run(sessionId, migration!.stage_id);
      db.prepare("INSERT INTO session_history_storage(session_id,backend,migrated_at,source_backend) VALUES(?,'jsonl-v3',?,?)").run(sessionId, new Date().toISOString(), migration!.source_backend);
      db.prepare('UPDATE jsonl_checkpoint_aliases SET published=1 WHERE session_id=?').run(sessionId);
      db.prepare('DELETE FROM conversation_history_tracking WHERE session_id=?').run(sessionId);
      db.prepare('DELETE FROM conversation_v3_owned_versions WHERE session_id=?').run(migration!.stage_id);
      db.prepare('DELETE FROM conversation_v3_heads WHERE session_id=?').run(migration!.stage_id);
      db.prepare('UPDATE jsonl_payload_segments SET sealed=1 WHERE owner=?').run(migration!.stage_id);
      db.prepare('DELETE FROM jsonl_payload_heads WHERE owner=?').run(migration!.stage_id);
    });
    return { sessionId, messages: migration.verified_count, checkpoints: Number((db.prepare('SELECT next_checkpoint-1 AS n FROM conversation_v3_heads WHERE session_id=?').get(sessionId) as { n: number }).n), migrated: true };
  } catch (error) {
    db.prepare('UPDATE jsonl_history_migrations SET error=?,updated_at=? WHERE session_id=?').run((error as Error).message, new Date().toISOString(), sessionId);
    throw error;
  }
}
