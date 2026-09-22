import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';
import { agentRuntimeRoutes } from '../../../routes/agent-runtime.js';

let dir: string;
let repo: string;
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeEach(() => {
  resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-git-files-'));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.test');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function session() {
  const created = agentSessionRuntime.create({ projectId: 'git-files-test', profileId: 'synax', prompt: 'test' });
  agentRuntimeStore.updateSession(created.id, { status: 'completed' });
  agentRuntimeStore.updateSessionMetadata(created.id, { backend: { workDir: repo, workspaceRoots: [
    { id: 'primary', name: 'Primary', role: 'primary', status: 'available', path: repo },
  ] } });
  return created;
}

function restore(id: string, body: Record<string, unknown>) {
  return agentRuntimeRoutes.request(`/sessions/${id}/git/files/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function commit(id: string, body: Record<string, unknown>) {
  return agentRuntimeRoutes.request(`/sessions/${id}/git/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

it('deletes an untracked file on restore', async () => {
  const owner = session();
  fs.writeFileSync(path.join(repo, 'new.txt'), 'scratch');
  const response = await restore(owner.id, { path: 'new.txt' });
  expect(response.status).toBe(200);
  expect((await response.json()).deleted).toBe(true);
  expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(false);
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

it('restores a modified tracked file to its HEAD state', async () => {
  const owner = session();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n');
  const response = await restore(owner.id, { path: 'tracked.txt' });
  expect(response.status).toBe(200);
  expect((await response.json()).deleted).toBe(false);
  expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('base\n');
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

it('unstages and removes a staged new file', async () => {
  const owner = session();
  fs.writeFileSync(path.join(repo, 'added.txt'), 'staged\n');
  git(repo, 'add', 'added.txt');
  const response = await restore(owner.id, { path: 'added.txt' });
  expect(response.status).toBe(200);
  expect(fs.existsSync(path.join(repo, 'added.txt'))).toBe(false);
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

it('restores a staged rename back to the original path', async () => {
  const owner = session();
  git(repo, 'mv', 'tracked.txt', 'moved.txt');
  const response = await restore(owner.id, { path: 'moved.txt' });
  expect(response.status).toBe(200);
  expect(fs.existsSync(path.join(repo, 'moved.txt'))).toBe(false);
  expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('base\n');
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

it('rejects paths without pending changes and path traversals', async () => {
  const owner = session();
  expect((await restore(owner.id, { path: 'tracked.txt' })).status).toBe(400);
  expect((await restore(owner.id, { path: '../outside.txt' })).status).toBe(400);
  expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('base\n');
});

it('commits only tracked files when includeUntracked is false', async () => {
  const owner = session();
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'keep untracked\n');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n');
  const response = await commit(owner.id, { message: 'feat: tracked only', includeUntracked: false, push: false });
  expect(response.status).toBe(200);
  expect((await response.json()).committedFiles).toBe(1);
  expect(git(repo, 'status', '--porcelain')).toBe('?? untracked.txt');
  expect(fs.readFileSync(path.join(repo, 'untracked.txt'), 'utf8')).toBe('keep untracked\n');
});

it('includes untracked files by default', async () => {
  const owner = session();
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n');
  const response = await commit(owner.id, { message: 'feat: everything', push: false });
  expect(response.status).toBe(200);
  expect((await response.json()).committedFiles).toBe(2);
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

it('reports nothing to commit when only untracked files exist and they are excluded', async () => {
  const owner = session();
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
  const response = await commit(owner.id, { message: 'feat: tracked only', includeUntracked: false });
  expect(response.status).toBe(409);
  expect(git(repo, 'status', '--porcelain')).toBe('?? untracked.txt');
});
