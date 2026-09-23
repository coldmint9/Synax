import { getRawSqlite } from '../../db/index.js';
import type {
  ExtensionDefinition,
  ExtensionKind,
  ExtensionState,
} from './types.js';

/** Overrides are intentionally project-scoped; absence preserves existing installations. */
export const extensionStore = {
  state(
    projectId: string | undefined,
    kind: ExtensionKind,
    id: string,
    fallback: ExtensionState = { installed: true, enabled: true },
  ): ExtensionState {
    if (!projectId) return fallback;
    const row = getRawSqlite()
      .prepare(
        'SELECT installed, enabled FROM project_extensions WHERE project_id = ? AND kind = ? AND extension_id = ?',
      )
      .get(projectId, kind, id) as
      | { installed: number; enabled: number }
      | undefined;
    return row
      ? {
          installed: Boolean(row.installed),
          enabled: Boolean(row.installed && row.enabled),
        }
      : fallback;
  },
  active(
    projectId: string | undefined,
    kind: ExtensionKind,
    id: string,
  ): boolean {
    const state = this.state(projectId, kind, id);
    return state.installed && state.enabled;
  },
  setState(
    projectId: string,
    kind: ExtensionKind,
    id: string,
    state: ExtensionState,
  ): void {
    getRawSqlite()
      .prepare(
        `INSERT INTO project_extensions (project_id, kind, extension_id, installed, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, kind, extension_id)
      DO UPDATE SET installed=excluded.installed, enabled=excluded.enabled, updated_at=excluded.updated_at`,
      )
      .run(
        projectId,
        kind,
        id,
        Number(state.installed),
        Number(state.installed && state.enabled),
        new Date().toISOString(),
      );
  },
  definitions(projectId: string, kind?: ExtensionKind): ExtensionDefinition[] {
    const rows = getRawSqlite()
      .prepare(
        'SELECT definition_json FROM extension_definitions WHERE project_id = ?' +
          (kind ? ' AND kind = ?' : ''),
      )
      .all(...(kind ? [projectId, kind] : [projectId])) as Array<{
      definition_json: string;
    }>;
    return rows.map(
      (row) => JSON.parse(row.definition_json) as ExtensionDefinition,
    );
  },
  definition(
    projectId: string,
    kind: ExtensionKind,
    id: string,
  ): ExtensionDefinition | undefined {
    return this.definitions(projectId, kind).find((item) => item.id === id);
  },
  save(projectId: string, definition: ExtensionDefinition): void {
    getRawSqlite()
      .prepare(
        `INSERT INTO extension_definitions (project_id, kind, extension_id, source_id, definition_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, kind, extension_id)
      DO UPDATE SET source_id=excluded.source_id, definition_json=excluded.definition_json, updated_at=excluded.updated_at`,
      )
      .run(
        projectId,
        definition.kind,
        definition.id,
        definition.sourceId,
        JSON.stringify(definition),
        new Date().toISOString(),
      );
  },
  registerSkillPackage(installId: string): void {
    getRawSqlite()
      .prepare(
        'INSERT OR IGNORE INTO extension_skill_packages (install_id) VALUES (?)',
      )
      .run(installId);
  },
  isSkillPackage(installId: string): boolean {
    return Boolean(
      getRawSqlite()
        .prepare('SELECT 1 FROM extension_skill_packages WHERE install_id = ?')
        .get(installId),
    );
  },
  directories(projectId: string): string[] {
    const row = getRawSqlite()
      .prepare(
        'SELECT directories_json FROM extension_source_settings WHERE project_id = ?',
      )
      .get(projectId) as { directories_json: string } | undefined;
    return row ? JSON.parse(row.directories_json) : [];
  },
  setDirectories(projectId: string, directories: string[]): void {
    getRawSqlite()
      .prepare(
        `INSERT INTO extension_source_settings (project_id, directories_json) VALUES (?, ?)
      ON CONFLICT(project_id) DO UPDATE SET directories_json=excluded.directories_json`,
      )
      .run(projectId, JSON.stringify(directories));
  },
};
