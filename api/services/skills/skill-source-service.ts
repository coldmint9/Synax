import { getRawSqlite } from '../../db/index.js';
import type { SkillSourceConfig, SkillSourceRecord, SkillSourceType } from './types.js';

const CORE_SOURCES: Array<Omit<SkillSourceRecord, 'lastSyncAt' | 'lastSyncError' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'synax-builtin',
    label: 'Local Skills',
    type: 'builtin',
    enabled: true,
    priority: 100,
    readOnly: true,
    config: {},
  },
];

/** Default remote catalog seeded on first run. */
export const DEFAULT_REMOTE_SOURCE: Omit<SkillSourceRecord, 'lastSyncAt' | 'lastSyncError' | 'createdAt' | 'updatedAt'> = {
  id: 'default-remote',
  label: 'Agent Skills Index',
  type: 'well-known',
  enabled: true,
  priority: 60,
  readOnly: true,
  config: {
    url: 'https://agentskills.ac.cn/.well-known/agent-skills/index.json',
  },
};

/** @deprecated Use DEFAULT_REMOTE_SOURCE. Kept for tests that import the array shape. */
export const PRESET_REMOTE_SOURCES = [DEFAULT_REMOTE_SOURCE];

const REMOVED_SOURCE_IDS = [
  'local',
  'project',
  'cursor',
  'cn-agentskills-portal',
  'cn-everything-skills',
  'cn-skills-zh',
  'cn-ecc-zh',
  'cn-kunhai-skills',
];

export const PROTECTED_SOURCE_IDS = new Set([
  'synax-builtin',
  'default-remote',
]);

const DEFAULT_SOURCES = [...CORE_SOURCES, DEFAULT_REMOTE_SOURCE];

interface SkillSourceRow {
  id: string;
  label: string;
  type: string;
  enabled: number;
  priority: number;
  read_only: number;
  config_json: string;
  last_sync_at: string | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToRecord(row: SkillSourceRow): SkillSourceRecord {
  return {
    id: row.id,
    label: row.label,
    type: row.type as SkillSourceType,
    enabled: row.enabled === 1,
    priority: row.priority,
    readOnly: row.read_only === 1,
    config: JSON.parse(row.config_json) as SkillSourceConfig,
    lastSyncAt: row.last_sync_at,
    lastSyncError: row.last_sync_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertSourceRow(
  insert: ReturnType<ReturnType<typeof getRawSqlite>['prepare']>,
  source: Omit<SkillSourceRecord, 'lastSyncAt' | 'lastSyncError' | 'createdAt' | 'updatedAt'>,
  now: string,
): void {
  insert.run(
    source.id,
    source.label,
    source.type,
    source.enabled ? 1 : 0,
    source.priority,
    source.readOnly ? 1 : 0,
    JSON.stringify(source.config),
    now,
    now,
  );
}

export class SkillSourceService {
  private seeded = false;

  ensureDefaultSources(): void {
    if (this.seeded) return;
    const db = getRawSqlite();
    const countRow = db.prepare('SELECT COUNT(*) AS count FROM skill_sources').get() as { count: number };
    const now = nowIso();
    const insert = db.prepare(`
      INSERT INTO skill_sources (
        id, label, type, enabled, priority, read_only, config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    if (countRow.count === 0) {
      for (const source of DEFAULT_SOURCES) {
        insertSourceRow(insert, source, now);
      }
    } else {
      const exists = db.prepare('SELECT 1 FROM skill_sources WHERE id = ?').get(DEFAULT_REMOTE_SOURCE.id);
      if (!exists) {
        insertSourceRow(insert, DEFAULT_REMOTE_SOURCE, now);
      }
    }

    const deleteCatalog = db.prepare('DELETE FROM skill_catalog_entries WHERE source_id = ?');
    const deleteSource = db.prepare('DELETE FROM skill_sources WHERE id = ?');
    for (const sourceId of REMOVED_SOURCE_IDS) {
      deleteCatalog.run(sourceId);
      deleteSource.run(sourceId);
    }

    this.seeded = true;
  }

  listSources(): SkillSourceRecord[] {
    this.ensureDefaultSources();
    const rows = getRawSqlite()
      .prepare('SELECT * FROM skill_sources ORDER BY priority DESC, label ASC')
      .all() as SkillSourceRow[];
    return rows.map(rowToRecord);
  }

  getSource(sourceId: string): SkillSourceRecord | null {
    this.ensureDefaultSources();
    const row = getRawSqlite()
      .prepare('SELECT * FROM skill_sources WHERE id = ?')
      .get(sourceId) as SkillSourceRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  createSource(input: {
    id: string;
    label: string;
    type: SkillSourceType;
    enabled?: boolean;
    priority?: number;
    readOnly?: boolean;
    config?: SkillSourceConfig;
  }): SkillSourceRecord {
    this.ensureDefaultSources();
    const now = nowIso();
    getRawSqlite()
      .prepare(`
        INSERT INTO skill_sources (
          id, label, type, enabled, priority, read_only, config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.label,
        input.type,
        input.enabled === false ? 0 : 1,
        input.priority ?? 60,
        input.readOnly ? 1 : 0,
        JSON.stringify(input.config ?? {}),
        now,
        now,
      );
    return this.getSource(input.id)!;
  }

  updateSource(sourceId: string, patch: Partial<{
    label: string;
    enabled: boolean;
    priority: number;
    readOnly: boolean;
    config: SkillSourceConfig;
  }>): SkillSourceRecord {
    const existing = this.getSource(sourceId);
    if (!existing) throw new Error(`Skill source not found: ${sourceId}`);
    if (PROTECTED_SOURCE_IDS.has(sourceId) && patch.config) {
      throw new Error(`Cannot replace config for protected source: ${sourceId}`);
    }

    const next = {
      label: patch.label ?? existing.label,
      enabled: patch.enabled ?? existing.enabled,
      priority: patch.priority ?? existing.priority,
      readOnly: patch.readOnly ?? existing.readOnly,
      config: patch.config ?? existing.config,
    };

    getRawSqlite()
      .prepare(`
        UPDATE skill_sources
        SET label = ?, enabled = ?, priority = ?, read_only = ?, config_json = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.label,
        next.enabled ? 1 : 0,
        next.priority,
        next.readOnly ? 1 : 0,
        JSON.stringify(next.config),
        nowIso(),
        sourceId,
      );
    return this.getSource(sourceId)!;
  }

  deleteSource(sourceId: string): void {
    if (PROTECTED_SOURCE_IDS.has(sourceId)) {
      throw new Error(`Cannot delete protected source: ${sourceId}`);
    }
    getRawSqlite().prepare('DELETE FROM skill_catalog_entries WHERE source_id = ?').run(sourceId);
    getRawSqlite().prepare('DELETE FROM skill_sources WHERE id = ?').run(sourceId);
  }

  markSyncResult(sourceId: string, input: { ok: boolean; error?: string }): void {
    getRawSqlite()
      .prepare(`
        UPDATE skill_sources
        SET last_sync_at = ?, last_sync_error = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.ok ? nowIso() : null,
        input.ok ? null : (input.error ?? 'Sync failed'),
        nowIso(),
        sourceId,
      );
  }
}

export const skillSourceService = new SkillSourceService();
