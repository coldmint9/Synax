import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';
import { agentRuntimeRoutes } from '../../../routes/agent-runtime.js';

const trashed = vi.hoisted(() => vi.fn());
vi.mock('trash', () => ({ default: trashed }));

let dir: string;
let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const action = (sessionId: string, kind: 'rename' | 'trash', body: Record<string, unknown>) =>
  agentRuntimeRoutes.request(`/sessions/${sessionId}/environment/file/${kind}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
function session(status = 'completed') {
  const item = agentSessionRuntime.create({ projectId: 'file-actions-test', profileId: 'synax', prompt: 'test' });
  agentRuntimeStore.updateSession(item.id, { status: status as typeof item.status });
  agentRuntimeStore.updateSessionMetadata(item.id, { backend: { workDir: repo, workspaceRoots: [
    { id: 'primary', name: 'Primary', role: 'primary', status: 'available', path: repo },
  ] } });
  return item;
}

beforeEach(() => {
  resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  trashed.mockReset().mockImplementation(async (target: string) => { fs.renameSync(target, path.join(dir, 'trash-copy')); });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-file-actions-'));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'test\n');
  git('add', '.'); git('commit', '-m', 'initial');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks(); });

it('renames only within the selected root and never overwrites an existing target', async () => {
  const item = session();
  fs.writeFileSync(path.join(repo, 'taken.txt'), 'keep');
  const conflict = await action(item.id, 'rename', { path: 'a.txt', newName: 'taken.txt', rootId: 'primary' });
  expect(conflict.status).toBe(400);
  expect(fs.readFileSync(path.join(repo, 'taken.txt'), 'utf8')).toBe('keep');
  const response = await action(item.id, 'rename', { path: 'a.txt', newName: 'new.txt', rootId: 'primary' });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ previousPath: 'a.txt', path: 'new.txt' });
  expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(false);
  expect(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8')).toBe('test\n');
});

it('rejects traversal, separators, symlink escapes and running sessions', async () => {
  const item = session();
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside');
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(repo, 'link.txt'));
  for (const body of [
    { path: '../outside.txt', newName: 'next.txt' },
    { path: 'a.txt', newName: '../outside.txt' },
    { path: 'link.txt', newName: 'next.txt' },
    { path: 'a.txt', newName: 'next.txt', rootId: 'unknown' },
  ]) expect((await action(item.id, 'rename', body)).status).toBe(400);
  agentRuntimeStore.updateSession(item.id, { status: 'running' });
  expect((await action(item.id, 'rename', { path: 'a.txt', newName: 'next.txt' })).status).toBe(400);
  expect((await action(item.id, 'trash', { path: 'a.txt' })).status).toBe(400);
  expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('test\n');
});

it('moves the file via trash and leaves it untouched when trash fails', async () => {
  const item = session();
  trashed.mockRejectedValueOnce(new Error('Trash unavailable'));
  const failed = await action(item.id, 'trash', { path: 'a.txt', rootId: 'primary' });
  expect(failed.status).toBe(500);
  expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(true);
  const done = await action(item.id, 'trash', { path: 'a.txt', rootId: 'primary' });
  expect(done.status).toBe(200);
  expect(await done.json()).toMatchObject({ trashed: true, path: 'a.txt' });
  expect(trashed).toHaveBeenCalledWith(fs.realpathSync(repo) + path.sep + 'a.txt', { glob: false });
  expect(fs.existsSync(path.join(repo, 'a.txt'))).toBe(false);
});
