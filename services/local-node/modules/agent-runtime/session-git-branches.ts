import {
  listGitWorkspaces,
  switchGitBranch,
  createAndSwitchGitBranch,
  countGitCheckoutChanges,
  GitWorkspaceError,
} from "../git-workspaces.js";
import {
  canonicalWorkspaceDirectory,
  workspaceRootHostPath,
  workspaceRootLocation,
} from "../project-workspace.js";
import { agentRuntimeStore } from "./session-store.js";
import {
  resolveSessionRepository,
  invalidateSessionEnvironment,
} from "./session-environment.js";
import { resolveSessionWorkspaceRoots } from "./tools/workspace.js";
import { AgentRuntimeError } from "./runtime-errors.js";

/** Canonical checkout directories this session's roots cover, or null when the
 * session has no readable checkout at all. */
function sessionCheckoutDirectories(
  sessionId: string,
  projectId: string,
): string[] | null {
  let roots: ReturnType<typeof resolveSessionWorkspaceRoots>;
  try {
    roots = resolveSessionWorkspaceRoots(sessionId, projectId);
  } catch {
    return null;
  }
  const directories: string[] = [];
  for (const root of roots) {
    try {
      directories.push(
        canonicalWorkspaceDirectory(workspaceRootHostPath(root)),
      );
    } catch {
      // A missing member never matches the checkout that just changed.
    }
  }
  return directories.length ? directories : null;
}

/** The checked-out location, plus the containing worktree root. Sessions bound
 * to a parent of the checkout (for example a subdirectory workDir) must be
 * refreshed too. */
function affectedDirectories(checkoutPath: string): string[] {
  const directories: string[] = [];
  try {
    directories.push(canonicalWorkspaceDirectory(checkoutPath));
  } catch {
    // Unreadable checkout: membership still compares against its parent.
  }
  const parent = canonicalWorkspaceDirectory(`${checkoutPath}/..`);
  if (!directories.includes(parent)) directories.push(parent);
  return directories;
}

/** True when a session root is an ancestor of the checked-out directory. */
function directoryCovers(
  directories: string[],
  checkoutDirectory: string,
): boolean {
  return directories.some((directory) =>
    checkoutDirectory.startsWith(`${directory}/`),
  );
}

/** Detached-worktree sessions keep their own path; only the checked-out shared
 * worktree location changes, so repository snapshots must be refreshed there.
 *
 * Membership is read once per session and compared against two canonical
 * directories. Asking the filesystem per session kept this pass on the critical
 * path of every branch switch and stalled the whole server process while it
 * walked the session table.
 */
function refreshSharedSessions(checkoutPath: string): void {
  const changed = affectedDirectories(checkoutPath);
  const checkoutDirectory = changed[0];
  for (const item of agentRuntimeStore.listSessions({ limit: Infinity })) {
    const directories = sessionCheckoutDirectories(item.id, item.projectId);
    if (!directories) continue;
    const involved =
      changed.some((directory) => directories.includes(directory)) ||
      (changed[1] !== undefined &&
        directories.includes(changed[1]) &&
        directoryCovers(directories, checkoutDirectory ?? ""));
    if (involved) invalidateSessionEnvironment(item.id);
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
