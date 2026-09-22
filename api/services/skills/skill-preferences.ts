import { getRawSqlite } from '../../db/index.js';

export const skillPreferences = {
  disabledIds(projectId?: string): Set<string> {
    const rows = getRawSqlite()
      .prepare(
        "SELECT skill_id FROM skill_preferences WHERE enabled = 0 AND (scope = '' OR scope = ?)",
      )
      .all(projectId ?? '') as Array<{ skill_id: string }>;
    return new Set(rows.map((row) => row.skill_id));
  },

  setEnabled(skillId: string, enabled: boolean, projectId?: string): void {
    const scope = skillId.startsWith('project/') ? projectId : '';
    if (scope === undefined)
      throw new Error('Project skill requires a project id');
    getRawSqlite()
      .prepare(
        `
      INSERT INTO skill_preferences (skill_id, scope, enabled) VALUES (?, ?, ?)
      ON CONFLICT(skill_id, scope) DO UPDATE SET enabled = excluded.enabled
    `,
      )
      .run(skillId, scope, enabled ? 1 : 0);
  },
};
