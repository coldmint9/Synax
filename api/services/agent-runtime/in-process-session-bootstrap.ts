import { logger } from "../../lib/logger.js";
import { agentRuntimeStore } from "./session-store.js";
import {
  resolveSessionWorkDir,
  setSessionWorkspaceRoot,
} from "./tools/workspace.js";

const boundSessions = new Set<string>();

/**
 * Bind the session workspace in the host process, mirroring the
 * `AGENT_SESSION_INIT.workDir` handshake a forked agent-session-runner child
 * performs before its first turn. Domain profiles are deliberately not
 * re-registered here: the host registers them at startup.
 */
export function ensureInProcessSessionReady(sessionId: string): void {
  if (boundSessions.has(sessionId)) return;
  const session = agentRuntimeStore.tryGetSession(sessionId);
  if (!session) return;
  try {
    setSessionWorkspaceRoot(
      sessionId,
      resolveSessionWorkDir(sessionId, session.projectId),
    );
  } catch (error) {
    logger.warn(
      { err: error, sessionId },
      "[in-process-session] workspace root binding skipped",
    );
  }
  boundSessions.add(sessionId);
}
