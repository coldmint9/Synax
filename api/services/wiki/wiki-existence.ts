import { getRawSqlite } from '../../db/index.js';

/**
 * Synchronous "has this project generated a wiki" probe.
 *
 * Session tool providers run inside a loop step and cannot await, so the wiki
 * read tools are mounted from this raw lookup instead of an async store query.
 * A latest snapshot in `failed` state means generation produced nothing usable.
 */
export function projectHasGeneratedWiki(projectId: string): boolean {
  if (!projectId) return false;
  try {
    const row = getRawSqlite()
      .prepare(
        `SELECT status AS status
         FROM wiki_snapshots
         WHERE project_id = ?
         ORDER BY revision DESC
         LIMIT 1`,
      )
      .get(projectId) as { status?: string } | undefined;
    if (!row?.status) return false;
    return row.status !== 'failed';
  } catch {
    // No database yet (fresh install, tests without a bound project): no wiki.
    return false;
  }
}
