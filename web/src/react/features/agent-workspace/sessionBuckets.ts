import { resolveSynaxMode } from "./synaxDisplay";
import type { AgentSession } from "../../../lib/api/agentRuntime";

/** Primary sessions page vs wiki/automation workflow sub-page. */
export type SessionListView = "sessions" | "workflow";

const WORKFLOW_PROFILE_IDS = new Set([
  "wiki-refresh",
  "plan-planner",
  "plan-generator",
]);

const LEGACY_GOAL_PROFILE_ID = "goal";
const WORKSPACE_SESSION_MODES = new Set(["plan", "goal", "plan_node"]);

export function isWorkflowSession(session: AgentSession): boolean {
  const { profileId, sessionMetadata } = session;

  if (profileId.startsWith("wiki-") || WORKFLOW_PROFILE_IDS.has(profileId)) {
    return true;
  }

  if (
    sessionMetadata &&
    typeof sessionMetadata.snapshotId === "string" &&
    sessionMetadata.snapshotId
  ) {
    return true;
  }

  return false;
}

/** Interactive Agent workspace sessions, including plan and legacy plan_node. */
export function isAgentWorkspaceSession(session: AgentSession): boolean {
  const mode = resolveSynaxMode(session);
  if (mode && WORKSPACE_SESSION_MODES.has(mode)) return true;

  const source =
    typeof session.sessionMetadata?.source === "string"
      ? session.sessionMetadata.source
      : undefined;

  return (
    session.profileId === LEGACY_GOAL_PROFILE_ID ||
    source === "agent-dock" ||
    source === "goal-dock" ||
    source === "session-page" ||
    source === "plan-execution"
  );
}

/** Sessions page shows interactive Synax sessions; workflow page shows wiki/plan automation. */
export function classifySession(session: AgentSession): SessionListView {
  if (isWorkflowSession(session)) return "workflow";
  return "sessions";
}

/**
 * Session list data source: root sessions only. Subagent child sessions are hidden
 * from the Sessions page list and never render as nested child items.
 */
export function listRootSessions(sessions: AgentSession[]): AgentSession[] {
  return sessions.filter((session) => !session.parentSessionId);
}

export const SESSION_LIST_VIEW_LABELS: Record<
  SessionListView,
  { zh: string; en: string }
> = {
  sessions: { zh: "会话", en: "Sessions" },
  workflow: { zh: "Workflow", en: "Workflows" },
};
