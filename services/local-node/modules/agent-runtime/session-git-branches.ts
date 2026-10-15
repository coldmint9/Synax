import {
  listGitWorkspaces,
  switchGitBranch,
  createAndSwitchGitBranch,
  countGitCheckoutChanges,
  GitWorkspaceError,
} from "../git-workspaces.js";
import {
  canonicalWorkspaceDirectory,
  isWithinWorkspace,
  workspaceRootLocation,
} from "../project-workspace.js";
import { agentRuntimeStore } from "./session-store.js";
import {
  resolveSessionRepository,
  invalidateSessionEnvironment,
} from "./session-environment.js";
import { resolveSessionWorkspaceRoots } from "./tools/workspace.js";
import { AgentRuntimeError } from "./runtime-errors.js";

function sharesRepository(
  sessionId: string,
  projectId: string,
  target: string,
): boolean {
  try {
    return resolveSessionWorkspaceRoots(sessionId, projectId).some((root) => {
      try {
        const location = canonicalWorkspaceDirectory(root.path);
        return (
          isWithinWorkspace(target, location) ||
          isWithinWorkspace(location, target)
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
/** Detached-worktree sessions keep their own path; only the checked-out shared
 * worktree location changes, so repository snapshots must be refreshed there. */
function refreshSharedSessions(checkoutPath: string): void {
  for (const item of agentRuntimeStore.listSessions({ limit: Infinity })) {
    if (sharesRepository(item.id, item.projectId, checkoutPath))
      invalidateSessionEnvironment(item.id);
  }
}
async function withGitErrors<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof GitWorkspaceError)
      throw new AgentRuntimeError(
        error.message,
        "GIT_BRANCH_ERROR",
        error.status,
      );
    throw error;
  }
}
export function listSessionGitBranches(sessionId: string, rootId?: string) {
  return withGitErrors(async () => {
    const session = agentRuntimeStore.getSession(sessionId);
    const root = resolveSessionRepository(
      sessionId,
      session.projectId,
      rootId,
      true,
    );
    const [summary, dirtyFileCount] = await Promise.all([
      listGitWorkspaces(workspaceRootLocation(root), session.projectId),
      countGitCheckoutChanges(workspaceRootLocation(root)),
    ]);
    return {
      rootId: root.id,
      dirtyFileCount,
      current:
        summary.worktrees.find((item) => item.path === summary.defaultPath)
          ?.branch ?? "",
      branches: summary.branches.map((branch) => ({
        name: branch.name,
        current: branch.checkedOutPath === summary.defaultPath,
        occupied: Boolean(
          branch.checkedOutPath &&
          branch.checkedOutPath !== summary.defaultPath,
        ),
      })),
    };
  });
}
export function switchSessionGitBranch(
  sessionId: string,
  branch: string,
  rootId?: string,
  transferChanges = false,
) {
  return withGitErrors(async () => {
    const session = agentRuntimeStore.getSession(sessionId);
    const root = resolveSessionRepository(
      sessionId,
      session.projectId,
      rootId,
      true,
    );
    try {
      await switchGitBranch(workspaceRootLocation(root), branch, {
        transferChanges,
      });
    } finally {
      // Stash restoration may fail after HEAD changes. Refresh shared snapshots
      // on failure too, so the UI reports the actual checkout.
      refreshSharedSessions(root.path);
    }
    return listSessionGitBranches(sessionId, root.id);
  });
}

export function createSessionGitBranch(
  sessionId: string,
  branch: string,
  rootId?: string,
) {
  return withGitErrors(async () => {
    const session = agentRuntimeStore.getSession(sessionId);
    const root = resolveSessionRepository(sessionId, session.projectId, rootId, true);
    await createAndSwitchGitBranch(workspaceRootLocation(root), branch);
    refreshSharedSessions(root.path);
    return listSessionGitBranches(sessionId, root.id);
  });
}
