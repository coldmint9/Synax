import { getRawSqlite } from "../../db/index.js";
import { agentRuntimeStore } from "./session-store.js";

export interface ProjectToolGrant {
  projectId: string;
  toolId: string;
  permissionId: string;
  createdAt: string;
}

type GrantRow = {
  project_id: string;
  tool_id: string;
  permission_id: string;
  created_at: string;
};

function fromRow(row: GrantRow): ProjectToolGrant {
  return {
    projectId: row.project_id,
    toolId: row.tool_id,
    permissionId: row.permission_id,
    createdAt: row.created_at,
  };
}

/** External provider approvals must not inherit Synax tool grants. */
export function grantedToolId(input: {
  sessionId: string;
  metadata?: Record<string, unknown>;
}): string | null {
  const toolId = input.metadata?.toolId;
  return !input.metadata?.source && typeof toolId === "string" &&
    hasProjectToolGrant(input.sessionId, toolId) ? toolId : null;
}

export function listProjectToolGrants(projectId: string): ProjectToolGrant[] {
  return (getRawSqlite()
    .prepare("SELECT * FROM agent_project_tool_grants WHERE project_id = ? ORDER BY created_at, tool_id")
    .all(projectId) as GrantRow[]).map(fromRow);
}

export function hasProjectToolGrant(sessionId: string, toolId: string): boolean {
  if (!toolId) return false;
  const session = agentRuntimeStore.tryGetSession(sessionId);
  if (!session) return false;
  return Boolean(getRawSqlite()
    .prepare("SELECT 1 FROM agent_project_tool_grants WHERE project_id = ? AND tool_id = ?")
    .get(session.projectId, toolId));
}

/** Called in the same runtime transaction as the permission reply. */
export function grantProjectTool(sessionId: string, toolId: string, permissionId: string): void {
  const session = agentRuntimeStore.getSession(sessionId);
  getRawSqlite()
    .prepare(`INSERT INTO agent_project_tool_grants (project_id, tool_id, permission_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, tool_id) DO UPDATE SET
        permission_id = excluded.permission_id, created_at = excluded.created_at`)
    .run(session.projectId, toolId, permissionId, new Date().toISOString());
}

export function revokeProjectToolGrant(projectId: string, toolId: string): boolean {
  return getRawSqlite()
    .prepare("DELETE FROM agent_project_tool_grants WHERE project_id = ? AND tool_id = ?")
    .run(projectId, toolId).changes > 0;
}

/** Project deletion/settings reset must not leave an approval for a reused ID. */
export function revokeAllProjectToolGrants(projectId: string): void {
  getRawSqlite()
    .prepare("DELETE FROM agent_project_tool_grants WHERE project_id = ?")
    .run(projectId);
}
