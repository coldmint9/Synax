import { randomUUID } from 'node:crypto';
import { resolveGitWorkspaceSelection } from '../git-workspaces.js';
import { projectWorkspaceRoots, readWorkspaceProject, workspaceRootLocation } from '../project-workspace.js';
import { locationContains, physicalLocationKey, parseWslUncPath, workspaceLocationHostPath, type WorkspaceLocation } from '../workspace-location.js';
import { readBackendBinding } from './backends/backend-binding.js';
import { agentRuntimeStore } from './session-store.js';
import { runtimeFacade } from './sidecar/runtime-facade.js';
import { projectSessionState } from './session-projection.js';
import type { AgentSession } from './contracts.js';
import { AgentRuntimeError } from './runtime-errors.js';
import { listSessionBackgroundProcesses } from './session-background-processes.js';
import { clearSessionWorkspaceRoot, resolveWorkspaceRootsFromSession } from './tools/workspace.js';
import { invalidateSessionEnvironment } from './session-environment.js';
import { withSessionWorkspaceLock } from './session-workspace-lock.js';
import { emitRuntimeBusEvent } from './runtime-bus-bridge.js';
import { currentExecutionContext, assertRuntimeExecutionCurrent } from '../../infrastructure/runtime/execution-context.js';

const busy = (session: AgentSession) => Boolean(session.activeRunId || session.sessionMetadata?.runtimeControl ||
  ['running', 'waiting_permission', 'waiting_input', 'paused'].includes(session.status));

export async function bindSessionWorktree(sessionId: string, input: { rootId: string; path: string; expectedPath: string }, actor: 'user' | 'agent' = 'user') {
  return withSessionWorkspaceLock(sessionId, async () => {
    await agentRuntimeStore.flushSession(sessionId);
    const snapshot = await runtimeFacade.uiSnapshotAuthoritative(sessionId);
    const session = projectSessionState(snapshot.session as never) as AgentSession;
    const execution = actor === 'agent' ? currentExecutionContext() : undefined;
    if (actor === 'agent' && (!execution || execution.sessionId !== sessionId || execution.runId !== session.activeRunId))
      throw new AgentRuntimeError('只有当前执行中的 Agent 可以选择工作树。', 'WORKSPACE_BUSY', 409);
    if (actor === 'agent') await assertRuntimeExecutionCurrent();
    else if (busy(session)) throw new AgentRuntimeError('请等待当前执行结束后再切换工作树。', 'WORKSPACE_BUSY', 409);
    const project = readWorkspaceProject(session.projectId);
    const registered = project && projectWorkspaceRoots(project).find(root => root.id === input.rootId);
    if (!registered) throw new AgentRuntimeError('工作区项目不存在。', 'WORKSPACE_ROOT_NOT_FOUND', 404);
    const current = resolveWorkspaceRootsFromSession(session).find(root => root.id === input.rootId);
    if (!current || physicalLocationKey(parseWslUncPath(input.expectedPath) ?? { ...workspaceRootLocation(current), path: input.expectedPath }) !== physicalLocationKey(workspaceRootLocation(current)))
      throw new AgentRuntimeError('会话目录已变化，请刷新后重试。', 'WORKSPACE_BINDING_CHANGED', 409);
    const selected = await resolveGitWorkspaceSelection(workspaceRootLocation(registered), session.projectId, { kind: 'worktree', path: input.path });
    const location: WorkspaceLocation = selected.location ?? { kind: 'host', path: selected.workDir };
    const registeredMainKey = physicalLocationKey(workspaceRootLocation(registered));
    const targetKey = physicalLocationKey(location);
    const processes = await listSessionBackgroundProcesses(sessionId);
    if (processes.some(process => !process.endedAt && process.state !== 'closed'))
      throw new AgentRuntimeError('请先停止此会话的终端和后台进程，再切换工作树。', 'WORKSPACE_BUSY', 409);
    const sessions = (await runtimeFacade.listSessionProjection()).map(value => projectSessionState(value as never) as AgentSession);
    const byId = new Map(sessions.map(item => [item.id, item]));
    for (const other of sessions) {
      if (other.id === sessionId || !busy(other)) continue;
      let parent = other.parentSessionId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        if (parent === sessionId) throw new AgentRuntimeError('子 Agent 仍在执行，请结束后再切换目录。', 'WORKSPACE_BUSY', 409);
        seen.add(parent); parent = byId.get(parent)?.parentSessionId ?? null;
      }
      // Selecting the shared project directory changes only this session's
      // binding. Other sessions' membership does not reserve that directory.
      if (targetKey === registeredMainKey) continue;
      let roots;
      try { roots = resolveWorkspaceRootsFromSession(other); } catch { continue; }
      if (roots.some(root => {
        const otherLocation = workspaceRootLocation(root);
        const otherKey = physicalLocationKey(otherLocation);
        // A reference to the shared main directory does not reserve linked
        // checkouts nested beneath it. Explicit shadow checkouts and their
        // subdirectories still participate in occupancy checks.
        if (otherKey === targetKey) return true;
        if (otherKey === registeredMainKey) return false;
        return locationContains(otherLocation, location) || locationContains(location, otherLocation);
      }))
        throw new AgentRuntimeError('目标工作树正被其他会话使用。', 'WORKTREE_IN_USE', 409);
    }
    const backend = readBackendBinding(session);
    const previousRevision = backend.workspaceBindingRevision ?? 0;
    const next = {
      ...backend,
      rootWorktrees: { ...backend.rootWorktrees, [registered.id]: location },
      userWorktrees: {
        ...Object.fromEntries(resolveWorkspaceRootsFromSession(session).map(root => [root.id, workspaceRootLocation(root)])),
        ...backend.userWorktrees,
        ...(actor === 'user' ? { [registered.id]: location } : {}),
      },
      executionRootId: actor === 'agent' ? registered.id : undefined,
      workspaceBindingRevision: previousRevision + 1,
      ...(registered.role === 'primary' ? { workDir: workspaceLocationHostPath(location), workspaceLocation: location } : {}),
    };
    const nextSession = { ...session, sessionMetadata: { ...session.sessionMetadata, backend: next } };
    next.workspaceRoots = resolveWorkspaceRootsFromSession(nextSession).map(root => ({ ...root, location: workspaceRootLocation(root) }));
    const subagent = session.sessionMetadata?.subagentProfile as { workspaceRoot: string; profile?: { writeScope?: string[] } } | undefined;
    if (actor === 'agent' && subagent?.profile?.writeScope)
      throw new AgentRuntimeError('限定文件范围的子 Agent 不能切换工作目录。', 'WORKSPACE_BUSY', 409);
    const metadata = { backend: next, ...(actor === 'agent' && subagent ? { subagentProfile: { ...subagent, workspaceRoot: workspaceLocationHostPath(location) } } : {}) };
    await runtimeFacade.controlCommand({ sessionId, requestId: `workspace-bind:${randomUUID()}`, operation: 'workspace_bind',
      payload: { expectedBindingRevision: previousRevision, ...(execution ? { execution } : {}), patch: { sessionMetadata: metadata } } });
    await agentRuntimeStore.hydrateSession(sessionId, true);
    clearSessionWorkspaceRoot(sessionId);
    invalidateSessionEnvironment(sessionId);
    emitRuntimeBusEvent({ type: 'session_changed', sessionId, patch: { sessionMetadata: { ...session.sessionMetadata, ...metadata } } });
    return { roots: next.workspaceRoots, revision: next.workspaceBindingRevision };
  });
}
