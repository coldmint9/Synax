import { getRawSqlite } from "../../db/index.js";
import { listGitWorkspaces, switchGitBranch, GitWorkspaceError } from '../git-workspaces.js';
import { canonicalWorkspaceDirectory, isWithinWorkspace } from '../project-workspace.js';
import { agentRuntimeStore } from './session-store.js';
import { resolveSessionRepository, invalidateSessionEnvironment } from './session-environment.js';
import { resolveSessionWorkspaceRoots } from './tools/workspace.js';
import { hasBackgroundProcesses } from './process-ownership.js';
import { AgentRuntimeError } from './runtime-errors.js';

const BUSY = new Set(['queued', 'running', 'stopping', 'waiting_permission', 'waiting_input']);
function sharesRepository(sessionId: string, projectId: string, target: string): boolean {
  try {
    return resolveSessionWorkspaceRoots(sessionId, projectId).some(root => {
      try {
        const location = canonicalWorkspaceDirectory(root.path);
        return isWithinWorkspace(target, location) || isWithinWorkspace(location, target);
      } catch { return false; }
    });
  } catch { return false; }

}
function assertRepositoryIdle(root: string) {
  const terminals = getRawSqlite().prepare("SELECT t.cwd FROM terminal_sessions t JOIN agent_runtime_processes p ON p.id=t.id WHERE t.kind='terminal' AND p.state<>'closed'").all() as { cwd: string }[];
  for (const terminal of terminals) {
    let cwd: string;
    try { cwd = canonicalWorkspaceDirectory(terminal.cwd); } catch { continue; }
    if (isWithinWorkspace(root, cwd) || isWithinWorkspace(cwd, root)) throw new AgentRuntimeError('请先结束此仓库的终端，再切换分支。 / End the open terminal in this repository before switching branches.', 'GIT_WORKSPACE_BUSY', 409);
  }
  const sessions = agentRuntimeStore.listSessions({ limit: Infinity });
  for (const session of sessions) {
    const control = session.sessionMetadata?.runtimeControl as { state?: string } | undefined;
    const uncertainShutdown = control?.state === 'stopping' || control?.state === 'unconfirmed';
    if ((BUSY.has(session.status) || uncertainShutdown || hasBackgroundProcesses(session.id)) && sharesRepository(session.id, session.projectId, root)) {
      throw new AgentRuntimeError('请先停止此仓库中的运行任务与后台服务，再切换分支。 / Stop active tasks and services in this repository before switching branches.', 'GIT_WORKSPACE_BUSY', 409);
    }
  }
}
async function withGitErrors<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof GitWorkspaceError) throw new AgentRuntimeError(error.message, 'GIT_BRANCH_ERROR', error.status);
    throw error;
  }
}
export function listSessionGitBranches(sessionId: string, rootId?: string) {
  return withGitErrors(async () => {
    const session = agentRuntimeStore.getSession(sessionId);
    const root = resolveSessionRepository(sessionId, session.projectId, rootId, true);
    const summary = await listGitWorkspaces(root.path, session.projectId);
    return { rootId: root.id, current: summary.worktrees.find(item => item.path === summary.defaultPath)?.branch ?? '',
      branches: summary.branches.map(branch => ({ name: branch.name, current: branch.checkedOutPath === summary.defaultPath, occupied: Boolean(branch.checkedOutPath && branch.checkedOutPath !== summary.defaultPath) })) };
  });
}
export function switchSessionGitBranch(sessionId: string, branch: string, rootId?: string) {
  return withGitErrors(async () => {
    const session = agentRuntimeStore.getSession(sessionId);
    const root = resolveSessionRepository(sessionId, session.projectId, rootId, true);
    let checkoutPath = root.path;
    await switchGitBranch(root.path, branch, (physicalRoot) => {
      assertRepositoryIdle(physicalRoot);
      checkoutPath = physicalRoot;
    });
    // Several sessions can share one physical checkout; invalidate every snapshot.
    for (const item of agentRuntimeStore.listSessions({ limit: Infinity })) {
      if (sharesRepository(item.id, item.projectId, checkoutPath)) invalidateSessionEnvironment(item.id);
    }
    return listSessionGitBranches(sessionId, root.id);
  });
}
