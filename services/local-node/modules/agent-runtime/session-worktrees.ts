import { createGitWorktree, listGitWorkspaces, removeGitWorktree, removeMissingGitWorktree, type WorktreeSessionUsage } from '../git-workspaces.js';
import { projectWorkspaceRoots, readWorkspaceProject, workspaceRootHostPath, workspaceRootLocation } from '../project-workspace.js';
import { physicalLocationKey, parseWslUncPath } from '../workspace-location.js';
import { agentRuntimeStore } from './session-store.js';
import { resolveWorkspaceRootsFromSession } from './tools/workspace.js';
import { bindSessionWorktree } from './session-worktree-binding.js';
import { runtimeFacade } from './sidecar/runtime-facade.js';
import { projectSessionState } from './session-projection.js';
import { AgentValidationError } from './runtime-errors.js';
import { emitRuntimeBusEvent } from './runtime-bus-bridge.js';
import { invalidateSessionEnvironment } from './session-environment.js';
import type { AgentSession } from './contracts.js';

function repository(sessionId: string, rootId?: string) {
  const session = agentRuntimeStore.getSession(sessionId);
  const project = readWorkspaceProject(session.projectId);
  const registered = project ? projectWorkspaceRoots(project) : [];
  if (!rootId && registered.length > 1) throw new AgentValidationError('Specify rootId from worktree.list for a multi-project workspace.');
  const root = registered.find(item => item.id === (rootId ?? session.projectId));
  if (!root) throw new AgentValidationError('Workspace project not found.');
  return { session, root, location: workspaceRootLocation(root), scope: root.role === 'primary' ? session.projectId : `${session.projectId}/${root.id}` };
}

/** Workers read all live sessions from Rust, never from their partial local cache. */
async function usage(): Promise<WorktreeSessionUsage> {
  const sessionCounts = new Map<string, number>();
  const activeSessionCounts = new Map<string, number>();
  for (const value of await runtimeFacade.listSessionProjection()) {
    const session = projectSessionState(value as never) as AgentSession;
    if (session.sessionMetadata?.archivedAt || session.sessionMetadata?.deletedAt) continue;
    let paths: string[];
    try { paths = resolveWorkspaceRootsFromSession(session).map(workspaceRootHostPath); } catch { continue; }
    const active = Boolean(session.activeRunId || session.pendingResumeToken || session.sessionMetadata?.runtimeControl ||
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(session.status));
    for (const path of new Set(paths)) {
      sessionCounts.set(path, (sessionCounts.get(path) ?? 0) + 1);
      if (active) activeSessionCounts.set(path, (activeSessionCounts.get(path) ?? 0) + 1);
    }
  }
  return { sessionCounts, activeSessionCounts };
}

function changed(session: AgentSession) {
  invalidateSessionEnvironment(session.id);
  // A metadata change refreshes the lightweight inventory in every open view.
  agentRuntimeStore.updateSessionMetadata(session.id, { worktreesUpdatedAt: new Date().toISOString() });
  emitRuntimeBusEvent({ type: 'session_changed', sessionId: session.id,
    patch: { sessionMetadata: agentRuntimeStore.getSession(session.id).sessionMetadata } });
}

export async function listSessionWorktrees(sessionId: string, rootId?: string) {
  const session = agentRuntimeStore.getSession(sessionId);
  const roots = resolveWorkspaceRootsFromSession(session);
  const ids = rootId ? [rootId] : roots.map(root => root.id);
  const repositories = [];
  // Inventory deliberately avoids scanning Git status in every checkout.
  for (const id of ids) {
    const { root, location, scope } = repository(sessionId, id);
    if (root.status !== 'available') {
      repositories.push({ rootId: id, name: root.name, status: root.status, selectedPath: root.path, repositoryRoot: root.path, defaultPath: root.path, branches: [], commits: [], worktrees: [] });
      continue;
    }
    const summary = await listGitWorkspaces(location, scope, undefined, undefined, { includeHistory: false, inspectStatus: false });
    repositories.push({ rootId: id, name: root.name, selectedPath: roots.find(item => item.id === id)?.path,
      status: root.status,
      ...summary });
  }
  return { repositories, hint: 'Use rootId and a listed path with worktree.select. Then relative file and command tools use the selected directory.' };
}

export async function selectSessionWorktree(sessionId: string, rootId: string | undefined, path: string) {
  const { session, root } = repository(sessionId, rootId);
  const current = resolveWorkspaceRootsFromSession(session).find(item => item.id === root.id)!;
  await bindSessionWorktree(sessionId, { rootId: root.id, path, expectedPath: workspaceRootHostPath(current) }, 'agent');
  return { rootId: root.id, path, selected: true };
}

export async function createSessionWorktree(sessionId: string, input: { rootId?: string; branch: string; createBranch?: boolean; startPoint?: string }) {
  const { session, root, location, scope } = repository(sessionId, input.rootId);
  const worktree = await createGitWorktree(location, scope, input);
  changed(session);
  return { rootId: root.id, worktree, hint: 'Call worktree.select to execute in this checkout.' };
}

export async function removeSessionWorktree(sessionId: string, input: { rootId?: string; path: string; missingOnly?: boolean }) {
  const { session, root, location, scope } = repository(sessionId, input.rootId);
  if (input.missingOnly) await removeMissingGitWorktree(location, input.path);
  else {
    const requested = physicalLocationKey(parseWslUncPath(input.path) ?? { ...location, path: input.path });
    if (resolveWorkspaceRootsFromSession(session).some(item => physicalLocationKey(workspaceRootLocation(item)) === requested))
      throw new AgentValidationError('Select a different worktree before removing the current checkout.');
    await removeGitWorktree(location, scope, input.path, { readUsage: usage });
  }
  changed(session);
  return { rootId: root.id, path: input.path, removed: true, branchesPreserved: true };
}
