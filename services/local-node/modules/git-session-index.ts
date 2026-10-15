import { getRawSqlite } from "../infrastructure/database/index.js";
import { normalizeAgentSessionStatus } from "./agent-runtime/session-projection.js";

/** Only metadata needed by Git views; never hydrate message bodies or full
 * session metadata, and fetch active-run status in one join rather than N reads. */
export function listGitSessions(projectId?: string) {
  const rows = getRawSqlite().prepare(`
    SELECT s.id, COALESCE(NULLIF(s.title,''), substr(s.prompt,1,100)) AS title,
      s.status, s.active_run_id, s.pending_resume_token, r.status AS run_status,
      CASE WHEN json_valid(s.session_metadata_json)
        THEN json_extract(s.session_metadata_json,'$.backend') ELSE NULL END AS backend_json
    FROM agent_runtime_sessions s
    LEFT JOIN agent_runtime_runs r ON r.id=s.active_run_id
    WHERE s.archived_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM conversation_v3_deletions d WHERE d.session_id=s.id)
      ${projectId ? "AND s.project_id=?" : ""}
    ORDER BY s.updated_at DESC
  `).all(...(projectId ? [projectId] : [])) as Array<{
    id: string; title: string; status: string; active_run_id: string | null;
    pending_resume_token: string | null; run_status: string | null; backend_json: string | null;
  }>;
  return rows.map(row => {
    let backend: { workDir?: string; workspaceRoots?: Array<{ path: string }> } | undefined;
    try { backend = row.backend_json ? JSON.parse(row.backend_json) : undefined; } catch { /* invalid metadata */ }
    return { id: row.id, title: row.title, status: normalizeAgentSessionStatus(row.status),
      activeRunId: row.active_run_id, pendingResumeToken: row.pending_resume_token,
      runStatus: row.run_status, backend };
  });
}
