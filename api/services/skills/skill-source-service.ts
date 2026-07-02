import { getRawSqlite } from '../../db/index.js';
import type { SkillSourceConfig, SkillSourceRecord, SkillSourceType } from './types.js';

const CORE_SOURCES: Array<Omit<SkillSourceRecord, 'lastSyncAt' | 'lastSyncError' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'synax-builtin',
    label: 'Synax Built-in',
    type: 'builtin',
    enabled: true,
    priority: 100,
    readOnly: true,
    config: {},
  },
  {
    id: 'project',
    label: 'Project Skills',
    type: 'project',
    enabled: true,
    priority: 90,
    readOnly: false,
    config: {},
  },
  {
    id: 'local',
    label: 'Local Skills',
    type: 'local',
    enabled: true,
    priority: 80,
    readOnly: false,
    config: { scanPaths: ['~/.synax/skills/'] },
  },
  {
    id: 'cursor',
    label: 'Cursor Skills',
    type: 'local',
    enabled: true,
    priority: 50,
    readOnly: true,
    config: { scanPaths: ['~/.cursor/skills/'] },
  },
];

/** Pre-installed remote catalogs popular in the Chinese agent-skills community. */
export const PRESET_REMOTE_SOURCES: Array<Omit<SkillSourceRecord, 'lastSyncAt' | 'lastSyncError' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'cn-agentskills-portal',
    label: 'Agent Skills 中文规范',
    type: 'well-known',
    enabled: true,
    priority: 62,
    readOnly: true,
    config: {
      url: 'https://agentskills.ac.cn/.well-known/agent-skills/index.json',
    },
  },
  {
    id: 'cn-everything-skills',
    label: '万物 Skills（中文全集）',
    type: 'git-index',
    enabled: true,
    priority: 61,
    readOnly: true,
    config: {
      repo: 'findscripter/everything-skills',
      ref: 'main',
      indexPath: 'INDEX/search.json',
      contentBase: 'repo-root',
    },
  },
  {
    id: 'cn-skills-zh',
    label: 'Anthropic Skills 中文版',
    type: 'git-index',
    enabled: true,
    priority: 60,
    readOnly: true,
    config: {
      repo: 'MarcelLeon/skills-zh',
      ref: 'main',
      scanRoot: 'skills',
    },
  },
  {
    id: 'cn-ecc-zh',
    label: 'Everything Claude Code 中文版',
    type: 'git-index',
    enabled: true,
    priority: 59,
    readOnly: true,
    config: {
      repo: 'aaione/everything-claude-code-zh',
      ref: 'main',
      scanRoot: 'skills',
    },
  },
  {
    id: 'cn-kunhai-skills',
    label: 'Kunhai Skills 中文合集',
    type: 'git-index',
    enabled: true,
    priority: 58,
    readOnly: true,
    config: {
      repo: 'kunhai-88/skills',
      ref: 'main',
      scanRoot: '.',
    },
  },
];

export const PROTECTED_SOURCE_IDS = new Set([
  'synax-builtin',
  'local',
  'project',
  'cursor',
  ...PRESET_REMOTE_SOURCES.map((source) => source.id),
]);

const DEFAULT_SOURCES = [...CORE_SOURCES, ...PRESET_REMOTE_SOURCES];

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
      for (const source of PRESET_REMOTE_SOURCES) {
        const exists = db.prepare('SELECT 1 FROM skill_sources WHERE id = ?').get(source.id);
        if (!exists) {
          insertSourceRow(insert, source, now);
        }
      }
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
