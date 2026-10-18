import { agentRuntimeStore } from "./agent-runtime/session-store.js";
import { normalizeAgentSessionStatus } from "./agent-runtime/session-projection.js";

/** Read Git workspace occupancy from the Rust-backed runtime working set. */
export function listGitSessions(projectId?: string) {
  return agentRuntimeStore
    .listSessions({ limit: Number.MAX_SAFE_INTEGER })
    .filter((session) => !projectId || session.projectId === projectId)
    .filter((session) => !session.sessionMetadata?.archivedAt && !session.sessionMetadata?.deletedAt)
    .map((session) => {
      const activeRun = session.activeRunId
        ? agentRuntimeStore.listRuns(session.id).find((run) => run.id === session.activeRunId)
        : undefined;
      const backend = session.sessionMetadata?.backend as
        | { workDir?: string; workspaceRoots?: Array<{ path: string }> }
        | undefined;
      return {
        id: session.id,
        title: session.title || session.prompt.slice(0, 100),
        status: normalizeAgentSessionStatus(session.status),
        activeRunId: session.activeRunId,
        pendingResumeToken: session.pendingResumeToken,
        runStatus: activeRun?.status ?? null,
        backend: backend && typeof backend === "object" ? backend : undefined,
      };
    });
}
