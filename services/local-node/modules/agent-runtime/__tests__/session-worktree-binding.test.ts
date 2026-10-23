import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { AgentSession } from '../contracts.js';

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
  fs.writeFileSync(path.join(directory, 'projects.json'), JSON.stringify({ items: [{ id: 'p', name: 'Main', source: { localPath: main }, references: [{ id: 'ref', name: 'Reference', localPath: reference }] }] }));
  bind = (await import('../session-worktree-binding.js')).bindSessionWorktree;
  workspace = await import('../tools/workspace.js');
});
beforeEach(() => {
  fixture.session = { id: 's', projectId: 'p', status: 'completed', activeRunId: null, parentSessionId: null, childSessionIds: [],
    sessionMetadata: { backend: { version: 1, id: 'native', model: null, workDir: main } } } as unknown as AgentSession;
  fixture.others = []; fixture.processes = [];
  workspace.clearSessionWorkspaceRoot('s');
  fixture.control.mockReset().mockImplementation(async ({ payload }) => {
    fixture.session!.sessionMetadata = { ...fixture.session!.sessionMetadata, ...payload.patch.sessionMetadata };
  });
});
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });

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
