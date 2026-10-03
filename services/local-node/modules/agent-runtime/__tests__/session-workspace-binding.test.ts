import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synax-workspace-binding-')));
const main = path.join(root, 'main');
const worktree = path.join(root, 'worktree');
const reference = path.join(root, 'reference');
let workspace: typeof import('../tools/workspace.js');
let runtime: typeof import('../session-runtime.js').agentSessionRuntime;
let store: typeof import('../session-store.js').agentRuntimeStore;
let environment: typeof import('../prompt-environment.js').buildRuntimeEnvironment;
let sandbox: typeof import('../sandbox/sandbox-config.js').sandboxConfigForSession;

beforeAll(async () => {
  vi.stubEnv('DATA_ROOT', root);
  vi.resetModules();
  workspace = await import('../tools/workspace.js');
  runtime = (await import('../session-runtime.js')).agentSessionRuntime;
  store = (await import('../session-store.js')).agentRuntimeStore;
  environment = (await import('../prompt-environment.js')).buildRuntimeEnvironment;
  sandbox = (await import('../sandbox/sandbox-config.js')).sandboxConfigForSession;
});
beforeEach(() => {
  for (const directory of [main, worktree, reference]) fs.mkdirSync(directory, { recursive: true });
  registry(reference);
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});
function registry(referencePath?: string) {
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify({ items: [{
    id: 'binding-project', name: 'Main', source: { localPath: main },
    references: referencePath ? [{ id: 'ref', name: 'Reference', localPath: referencePath }] : [],
  }] }));
}
function session() {
  return runtime.create({ projectId: 'binding-project', profileId: 'planner', prompt: 'Workspace test', workDir: worktree });
}

it('uses the explicit worktree for tools, roots and environment before and after binding', () => {
  const s = session();
  expect(workspace.resolveSessionWorkspaceRoots(s.id, s.projectId)[0].path).toBe(worktree);
  expect(workspace.bindSessionWorkDir(s.id)).toBe(worktree);
  expect(workspace.workspaceRoot(s.id)).toBe(worktree);
  expect(workspace.resolveSessionWorkspaceRoots(s.id, s.projectId)[0].path).toBe(worktree);
  expect(JSON.parse(environment(s.id, s.projectId).split('\n')[1]).cwd).toBe(worktree);
});
it('repairs legacy persisted primary roots and restores tools after transient cache loss', () => {
  const s = session();
  store.updateSessionMetadata(s.id, { backend: { ...s.sessionMetadata!.backend as object,
    workspaceRoots: [{ id: s.projectId, name: 'Main', path: main, role: 'primary', status: 'available' }],
  } });
  store.updateSession(s.id, { activeRunId: 'legacy-run' });
  workspace.bindSessionWorkDir(s.id);
  workspace.clearSessionWorkspaceRoot(s.id);
  expect(workspace.workspaceRoot(s.id)).toBe(worktree);
  expect(workspace.resolveSessionWorkspaceRoots(s.id, s.projectId)[0].path).toBe(worktree);
});
it('keeps unavailable references visible but outside the allowed sandbox roots', () => {
  const missing = path.join(root, 'deleted-reference');
  registry(missing);
  const s = session();
  expect(workspace.bindSessionWorkDir(s.id)).toBe(worktree);
  expect(workspace.resolveSessionWorkspaceRoots(s.id, s.projectId)).toContainEqual(
    expect.objectContaining({ id: 'ref', path: missing, status: 'missing' }),
  );
  expect(sandbox(s.id).workspaceRoots).toEqual([worktree]);
});
it('keeps the run reference membership for children, refreshing only on the next parent run', () => {
  const parent = session();
  workspace.bindSessionWorkDir(parent.id);
  store.updateSession(parent.id, { activeRunId: 'frozen-run' });
  registry();
  const child = runtime.create({ projectId: parent.projectId, parentSessionId: parent.id, profileId: 'explorer', prompt: 'Child' });
  workspace.bindSessionWorkDir(child.id);
  expect(workspace.resolveSessionWorkspaceRoots(child.id, parent.projectId).map(r => r.path)).toEqual([worktree, reference]);
  workspace.bindSessionWorkDir(parent.id);
  expect(workspace.resolveSessionWorkspaceRoots(parent.id, parent.projectId)).toHaveLength(2);
  store.updateSession(parent.id, { activeRunId: null });
  workspace.bindSessionWorkDir(parent.id);
  expect(workspace.resolveSessionWorkspaceRoots(parent.id, parent.projectId).map(r => r.path)).toEqual([worktree]);
});
it('does not silently use the API directory for an unregistered project', () => {
  expect(() => workspace.resolveProjectWorkDir('not-registered')).toThrow(/registered workspace/);
  expect(() => workspace.resolveSessionWorkDir('not-a-session', 'not-registered')).toThrow(/registered workspace/);
});
it('still rejects an unavailable primary directory', () => {
  const s = session();
  fs.rmdirSync(worktree);
  expect(() => workspace.bindSessionWorkDir(s.id)).toThrow(/unavailable/);
});

it('does not let the inherited location override an explicit child working directory', () => {
  const parent = session();
  workspace.bindSessionWorkDir(parent.id);
  const child = runtime.create({ projectId: parent.projectId, parentSessionId: parent.id,
    profileId: 'explorer', prompt: 'Child override', workDir: reference });
  expect(workspace.bindSessionWorkDir(child.id)).toBe(reference);
  expect(workspace.resolveSessionWorkspaceRoots(child.id, child.projectId)[0].path).toBe(reference);
});

it('rejects relative session directories instead of resolving them inside the application', () => {
  expect(() => workspace.resolveWorkspaceRoot('.')).toThrow(/absolute path/);
  expect(() => workspace.setSessionWorkspaceRoot('relative', 'src')).toThrow(/absolute path/);
});
