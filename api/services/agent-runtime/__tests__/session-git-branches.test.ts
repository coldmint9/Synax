import { terminalManager } from "../../terminals/terminal-manager.js";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';
import { prepareOwnedProcess, releaseOwnedProcess } from '../process-ownership.js';
import { agentRuntimeRoutes } from '../../../routes/agent-runtime.js';

let dir: string;
let one: string;
let two: string;
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeEach(() => {
  resetAgentRuntimeFixtures(); ensureSynaxAgentRegistered();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-branch-routes-'));
  one = path.join(dir, 'one'); two = path.join(dir, 'two');
  for (const root of [one, two]) {
    fs.mkdirSync(root); git(root, 'init', '-b', 'main'); git(root, 'config', 'user.email', 'test@example.test'); git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false'); fs.writeFileSync(path.join(root, 'file.txt'), 'initial');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'initial'); git(root, 'branch', 'feature');
  }
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function session(root = one, includeReference = true) {
  const created = agentSessionRuntime.create({ projectId: 'branches-test', profileId: 'synax', prompt: 'test' });
  agentRuntimeStore.updateSession(created.id, { status: 'completed' });
  agentRuntimeStore.updateSessionMetadata(created.id, { backend: { workDir: root, workspaceRoots: [
    { id: 'primary', name: 'Primary', role: 'primary', status: 'available', path: root },
    ...(includeReference ? [{ id: 'reference', name: 'Reference', role: 'reference', status: 'available', path: two }] : []),
  ] } });
  return created;
}
function switchBranch(id: string, rootId?: string) {
  return agentRuntimeRoutes.request(`/sessions/${id}/git/branches/switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: 'feature', rootId }) });
}
it('requires an explicit member and switches only the selected checkout', async () => {
  const owner = session();
  expect((await switchBranch(owner.id)).status).toBe(400);
  expect((await switchBranch(owner.id, 'outside')).status).toBe(400);
  const listed = await agentRuntimeRoutes.request(`/sessions/${owner.id}/git/branches?rootId=reference`);
  expect((await listed.json()).branches.map((b: any) => b.name)).toEqual(['feature', 'main']);
  const result = await switchBranch(owner.id, 'reference');
  expect(result.status).toBe(200); expect((await result.json()).current).toBe('feature');
  expect(git(one, 'branch', '--show-current')).toBe('main');
  expect(git(two, 'branch', '--show-current')).toBe('feature');
});
it('blocks another active session or background service sharing the physical checkout', async () => {
  const owner = session(one, false); const other = session(one, false);
  agentRuntimeStore.updateSession(other.id, { status: 'running' });
  expect((await switchBranch(owner.id, 'primary')).status).toBe(409);
  agentRuntimeStore.updateSession(other.id, { status: 'stopping' });
  expect((await switchBranch(owner.id, 'primary')).status).toBe(409);
  agentRuntimeStore.updateSession(other.id, { status: 'completed' });
  agentRuntimeStore.updateSessionMetadata(other.id, { runtimeControl: { state: 'unconfirmed' } });
  expect((await switchBranch(owner.id, 'primary')).status).toBe(409);
  agentRuntimeStore.updateSessionMetadata(other.id, { runtimeControl: null });
  const process = prepareOwnedProcess('test background', true, { sessionId: other.id, background: true });
  expect((await switchBranch(owner.id, 'primary')).status).toBe(409);
  releaseOwnedProcess(process.id);
  expect((await switchBranch(owner.id, 'primary')).status).toBe(200);
});
it('allows an unrelated running repository and protects uncommitted files', async () => {
  const owner = session(one, false); const other = session(two, false);
  agentRuntimeStore.updateSession(other.id, { status: 'running' });
  fs.writeFileSync(path.join(one, 'file.txt'), 'do not discard');
  expect((await switchBranch(owner.id, 'primary')).status).toBe(409);
  expect(fs.readFileSync(path.join(one, 'file.txt'), 'utf8')).toBe('do not discard');
  git(one, 'restore', 'file.txt');
  expect((await switchBranch(owner.id, 'primary')).status).toBe(200);
});

it('protects a checkout with a manually opened terminal, even without an AI-session owner', async () => {
  const owner = session(one, false);
  const terminal = await terminalManager.create({ projectId: 'same-checkout', rootId: 'primary', cwd: one, kind: 'terminal', title: 'open shell', shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', shellArgs: process.platform === 'win32' ? [] : ['-i'] });
  try { expect((await switchBranch(owner.id, 'primary')).status).toBe(409); }
  finally { await terminalManager.stop(terminal.id); }
  expect((await switchBranch(owner.id, 'primary')).status).toBe(200);
});
