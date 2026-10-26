import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { AgentSession } from '../contracts.js';
import { runWithExecutionContext, setAuthoritativeExecutionFence } from '../../../infrastructure/runtime/execution-context.js';

const fixture = vi.hoisted(() => ({ session: null as AgentSession | null, others: [] as AgentSession[], processes: [] as object[], control: vi.fn() }));
vi.mock('../sidecar/runtime-facade.js', () => ({ runtimeFacade: {
  uiSnapshotAuthoritative: async () => ({ session: fixture.session }),
  listSessionProjection: async () => fixture.others,
  controlCommand: fixture.control,
} }));
vi.mock('../session-store.js', () => ({ agentRuntimeStore: {
  flushSession: async () => {}, hydrateSession: async () => {},
  getSession: () => fixture.session, tryGetSession: () => fixture.session,
  updateSessionMetadata: (_id: string, patch: object) => { fixture.session!.sessionMetadata = { ...fixture.session!.sessionMetadata, ...patch }; },
} }));
vi.mock('../session-background-processes.js', () => ({ listSessionBackgroundProcesses: async () => fixture.processes }));
vi.mock('../session-environment.js', () => ({ invalidateSessionEnvironment: vi.fn() }));
vi.mock('../runtime-bus-bridge.js', () => ({ emitRuntimeBusEvent: vi.fn() }));
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synax-bind-tree-')));
const main = path.join(directory, 'main');
const reference = path.join(directory, 'reference');
const mainTree = path.join(directory, 'main-tree');
const refTree = path.join(directory, 'ref-tree');
const nestedTree = path.join(main, '.worktrees', 'nested');
let bind: typeof import('../session-worktree-binding.js').bindSessionWorktree;
let workspace: typeof import('../tools/workspace.js');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
beforeAll(async () => {
  vi.stubEnv('DATA_ROOT', directory);
  for (const [repo, tree] of [[main, mainTree], [reference, refTree]]) {
    fs.mkdirSync(repo); git(repo, 'init', '-b', 'main');
    git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial');
    git(repo, 'worktree', 'add', '-b', 'feature/task', tree);
  }
  git(main, 'worktree', 'add', '-b', 'feature/nested', nestedTree);
  fs.writeFileSync(path.join(directory, 'projects.json'), JSON.stringify({ items: [{ id: 'p', name: 'Main', source: { localPath: main }, references: [{ id: 'ref', name: 'Reference', localPath: reference }] }] }));
  bind = (await import('../session-worktree-binding.js')).bindSessionWorktree;
  workspace = await import('../tools/workspace.js');
});
beforeEach(() => {
  setAuthoritativeExecutionFence(async () => {});
  fixture.session = { id: 's', projectId: 'p', status: 'completed', activeRunId: null, parentSessionId: null, childSessionIds: [],
    sessionMetadata: { backend: { version: 1, id: 'native', model: null, workDir: main } } } as unknown as AgentSession;
  fixture.others = []; fixture.processes = [];
  workspace.clearSessionWorkspaceRoot('s');
  fixture.control.mockReset().mockImplementation(async ({ payload }) => {
    fixture.session!.sessionMetadata = { ...fixture.session!.sessionMetadata, ...payload.patch.sessionMetadata };
  });
});
afterAll(() => { setAuthoritativeExecutionFence(undefined); vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });

it('binds a reference worktree without changing the default cwd, and preserves it at the next run', async () => {
  const result = await bind('s', { rootId: 'ref', path: refTree, expectedPath: reference });
  expect(result.roots.map(root => root.path)).toEqual([main, refTree]);
  expect(workspace.bindSessionWorkDir('s')).toBe(main);
  expect(workspace.resolveSessionWorkspaceRoots('s', 'p').map(root => root.path)).toEqual([main, refTree]);
  workspace.refreshSessionWorkspaceRoots('s');
  expect(workspace.resolveSessionWorkspaceRoots('s', 'p')[1].path).toBe(refTree);
});
it('changes primary tools and persisted roots together and can explicitly return to main', async () => {
  await bind('s', { rootId: 'p', path: mainTree, expectedPath: main });
  expect(workspace.workspaceRoot('s')).toBe(mainTree);
  expect(fixture.control).toHaveBeenCalledWith(expect.objectContaining({ operation: 'workspace_bind', payload: expect.objectContaining({ expectedBindingRevision: 0 }) }));
  await bind('s', { rootId: 'p', path: main, expectedPath: mainTree });
  expect(workspace.workspaceRoot('s')).toBe(main);
});
it.each([
  { rootId: 'p', mainPath: main, treePath: mainTree },
  { rootId: 'ref', mainPath: reference, treePath: refTree },
])('can return $rootId to its shared main directory while another workspace session is running', async ({ rootId, mainPath, treePath }) => {
  const sibling = { ...fixture.session!, id: 'other', status: 'running', activeRunId: 'other-run' } as AgentSession;
  fixture.others = [sibling];
  const previousSibling = structuredClone(sibling);
  const before = [mainPath, treePath].map(cwd => git(cwd, 'rev-parse', 'HEAD').toString());
  await bind('s', { rootId, path: treePath, expectedPath: mainPath });
  expect(workspace.resolveWorkspaceRootsFromSession(fixture.session!).find(root => root.id === rootId)?.path).toBe(treePath);
  await bind('s', { rootId, path: mainPath, expectedPath: treePath });
  expect(workspace.resolveSessionWorkspaceRoots('s', 'p').find(root => root.id === rootId)?.path).toBe(mainPath);
  expect(fixture.session!.sessionMetadata!.backend).toMatchObject({
    workspaceBindingRevision: 2, rootWorktrees: { [rootId]: { path: mainPath } }, userWorktrees: { [rootId]: { path: mainPath } },
  });
  expect(fixture.others).toEqual([previousSibling]);
  expect([mainPath, treePath].map(cwd => git(cwd, 'rev-parse', 'HEAD').toString())).toEqual(before);
});

it('still rejects a shadow worktree that another running session has selected', async () => {
  fixture.others = [{ ...fixture.session!, id: 'other', status: 'running', activeRunId: 'other-run',
    sessionMetadata: { backend: { version: 1, id: 'native', model: null, workDir: mainTree } } }];
  await expect(bind('s', { rootId: 'p', path: mainTree, expectedPath: main })).rejects.toMatchObject({ code: 'WORKTREE_IN_USE' });
  expect(fixture.control).not.toHaveBeenCalled();
  expect(workspace.workspaceRoot('s')).toBe(main);
});

it('does not let shared main-directory membership reserve a nested worktree', async () => {
  fixture.others = [{ ...fixture.session!, id: 'other', status: 'running', activeRunId: 'other-run' }];
  await bind('s', { rootId: 'p', path: nestedTree, expectedPath: main });
  expect(workspace.workspaceRoot('s')).toBe(nestedTree);
  await bind('s', { rootId: 'p', path: main, expectedPath: nestedTree });
  expect(workspace.workspaceRoot('s')).toBe(main);
});

it('protects a shadow checkout when another running session is rooted inside it', async () => {
  const subdirectory = path.join(nestedTree, 'src');
  fs.mkdirSync(subdirectory);
  fixture.others = [{ ...fixture.session!, id: 'other', status: 'running', activeRunId: 'other-run',
    sessionMetadata: { backend: { version: 1, id: 'native', model: null, workDir: subdirectory } } }];
  await expect(bind('s', { rootId: 'p', path: nestedTree, expectedPath: main })).rejects.toMatchObject({ code: 'WORKTREE_IN_USE' });
  expect(fixture.control).not.toHaveBeenCalled();
});

it('lets the owning agent return to shared main without changing another running session', async () => {
  await bind('s', { rootId: 'ref', path: refTree, expectedPath: reference });
  fixture.session!.activeRunId = 'run'; fixture.session!.status = 'running';
  fixture.others = [{ ...fixture.session!, id: 'other', activeRunId: 'other-run',
    sessionMetadata: { backend: { version: 1, id: 'native', model: null, workDir: main } } }];
  const execution = { sessionId: 's', runId: 'run', epoch: '1', hostId: 'host' };
  await runWithExecutionContext(execution, () => bind('s', { rootId: 'ref', path: reference, expectedPath: refTree }, 'agent'));
  expect(workspace.workspaceRoot('s')).toBe(reference);
  expect(fixture.session!.sessionMetadata!.backend).toMatchObject({ executionRootId: 'ref', userWorktrees: { ref: { path: refTree } } });
  expect(fixture.control).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ execution }) }));
});

it('still blocks returning to main while a descendant is running', async () => {
  await bind('s', { rootId: 'p', path: mainTree, expectedPath: main });
  fixture.others = [{ ...fixture.session!, id: 'child', parentSessionId: 's', status: 'running', activeRunId: 'child-run' }];
  await expect(bind('s', { rootId: 'p', path: main, expectedPath: mainTree })).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
  expect(workspace.workspaceRoot('s')).toBe(mainTree);
  expect(fixture.control).toHaveBeenCalledTimes(1);
});
it('rejects paths from another repository and stale view selections', async () => {
  await expect(bind('s', { rootId: 'p', path: refTree, expectedPath: main })).rejects.toThrow(/not a worktree/);
  await expect(bind('s', { rootId: 'p', path: mainTree, expectedPath: reference })).rejects.toMatchObject({ code: 'WORKSPACE_BINDING_CHANGED' });
  expect(fixture.control).not.toHaveBeenCalled();
});
it('blocks running sessions, descendants and background processes', async () => {
  fixture.session!.activeRunId = 'run';
  await expect(bind('s', { rootId: 'p', path: mainTree, expectedPath: main })).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
  fixture.session!.activeRunId = null;
  fixture.others = [{ ...fixture.session!, id: 'child', parentSessionId: 's', activeRunId: 'child-run' }];
  await expect(bind('s', { rootId: 'p', path: mainTree, expectedPath: main })).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
  fixture.others = []; fixture.processes = [{ state: 'running', endedAt: null }];
  await expect(bind('s', { rootId: 'p', path: mainTree, expectedPath: main })).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
  expect(fixture.control).not.toHaveBeenCalled();
});
it('does not acknowledge or cache a binding rejected by the durable runtime', async () => {
  fixture.control.mockRejectedValueOnce(new Error('revision changed'));
  await expect(bind('s', { rootId: 'p', path: mainTree, expectedPath: main })).rejects.toThrow('revision changed');
  expect(workspace.workspaceRoot('s')).toBe(main);
});

it('fails the next run when an explicitly bound reference worktree disappears', async () => {
  await bind('s', { rootId: 'ref', path: refTree, expectedPath: reference });
  const moved = `${refTree}-missing`;
  fs.renameSync(refTree, moved);
  try {
    expect(() => workspace.bindSessionWorkDir('s')).toThrow(/unavailable/);
    expect(workspace.resolveWorkspaceRootsFromSession(fixture.session!)).toContainEqual(expect.objectContaining({ id: 'ref', path: refTree, status: 'missing' }));
  } finally { fs.renameSync(moved, refTree); }
});

it('lets only the owning agent select a checkout and keeps user selections separate', async () => {
  fixture.session!.activeRunId = 'run'; fixture.session!.status = 'running';
  const input = { rootId: 'p', path: mainTree, expectedPath: main };
  await expect(bind('s', input, 'agent')).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
  const execution = { sessionId: 's', runId: 'run', epoch: '1', hostId: 'host' };
  await runWithExecutionContext(execution, () => bind('s', input, 'agent'));
  expect(workspace.workspaceRoot('s')).toBe(mainTree);
  expect(fixture.session!.sessionMetadata!.backend).toMatchObject({ executionRootId: 'p', userWorktrees: { p: { path: main } }, rootWorktrees: { p: { path: mainTree } } });
  expect(fixture.control).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ execution }) }));
  // A reference selection changes native tool cwd without moving primary identity.
  await runWithExecutionContext(execution, () => bind('s', { rootId: 'ref', path: refTree, expectedPath: reference }, 'agent'));
  expect(workspace.workspaceRoot('s')).toBe(refTree);
  expect(workspace.resolveSessionWorkDir('s', 'p')).toBe(refTree);
  expect(workspace.resolveSessionWorkspaceRoots('s', 'p').map(root => root.path)).toEqual([mainTree, refTree]);
  expect(fixture.session!.sessionMetadata!.backend).toMatchObject({ workDir: mainTree, userWorktrees: { ref: { path: reference } } });
});

it('exposes real list/create/select/remove tools scoped to the registered project', async () => {
  const { worktreeTools } = await import('../tools/worktree.js');
  const call = async (id: string, args: unknown) => worktreeTools.find(tool => tool.id === id)!.execute({ sessionId: 's', runId: 'run', stepId: null, toolCallId: id, toolId: id, category: 'write', mutability: 'write', args });
  const listed = await call('worktree.list', {});
  expect(listed.result).toMatchObject({ repositories: [{ rootId: 'p' }, { rootId: 'ref' }] });
  await expect(call('worktree.create', { branch: 'feature/new', createBranch: true })).rejects.toThrow(/rootId/);
  const created = (await call('worktree.create', { rootId: 'p', branch: 'feature/agent', createBranch: true })).result as { worktree: { path: string } };
  expect(fs.existsSync(created.worktree.path)).toBe(true);
  fixture.session!.activeRunId = 'run'; fixture.session!.status = 'running';
  await runWithExecutionContext({ sessionId: 's', runId: 'run', epoch: '1', hostId: 'host' }, () => call('worktree.select', { rootId: 'p', path: created.worktree.path }));
  expect(workspace.resolveWorkspacePath('agent.txt', 's')).toBe(path.join(created.worktree.path, 'agent.txt'));
  await expect(call('worktree.remove', { rootId: 'p', path: created.worktree.path })).rejects.toThrow(/different worktree/);
  await runWithExecutionContext({ sessionId: 's', runId: 'run', epoch: '1', hostId: 'host' }, () => call('worktree.select', { rootId: 'p', path: main }));
  await call('worktree.remove', { rootId: 'p', path: created.worktree.path });
  expect(fs.existsSync(created.worktree.path)).toBe(false);
  expect(git(main, 'rev-parse', 'feature/agent').toString().trim()).toBeTruthy();
});
