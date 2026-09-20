import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { terminalRoutes } from '../../../routes/terminals.js';
import { installRuntimeAccess } from '../../../middleware/runtime-access.js';
import { terminalManager } from '../terminal-manager.js';
import { getRawSqlite } from '../../../db/index.js';
import { DATA_ROOT } from '../../../lib/env.js';
import { agentRuntimeStore } from '../../agent-runtime/session-store.js';
import { agentSessionRuntime } from '../../agent-runtime/session-runtime.js';
import { ensureSynaxAgentRegistered } from '../../agent-runtime/synax/index.js';
import { prepareOwnedProcess, releaseOwnedProcess } from '../../agent-runtime/process-ownership.js';

let root: string, token: string, app: Hono;
let registry: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-terminal-routes-'));
  fs.mkdirSync(path.join(root, 'one')); fs.mkdirSync(path.join(root, 'two'));
  try { registry = fs.readFileSync(path.join(DATA_ROOT, 'projects.json'), 'utf8'); } catch { registry = undefined; }
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.writeFileSync(path.join(DATA_ROOT, 'projects.json'), JSON.stringify([{ id: 'p', name: 'P', source: { localPath: path.join(root, 'one') }, references: [{ id: 'ref', name: 'Reference', localPath: path.join(root, 'two') }] }]));
  vi.stubEnv('HOME', root); vi.stubEnv('SHELL', '/bin/sh');
  getRawSqlite().exec('DELETE FROM terminal_sessions; DELETE FROM agent_runtime_processes;');
  app = new Hono(); installRuntimeAccess(app, { dataRoot: path.join(root, 'auth') }); app.route('/api/terminals', terminalRoutes);
  token = fs.readFileSync(path.join(root, 'auth/runtime-access-token'), 'utf8').trim();
  ensureSynaxAgentRegistered();
});
afterEach(async () => {
  await terminalManager.shutdown(); vi.unstubAllEnvs();
  if (registry !== undefined) fs.writeFileSync(path.join(DATA_ROOT, 'projects.json'), registry);
  else fs.rmSync(path.join(DATA_ROOT, 'projects.json'), { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
const request = (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(`/api/terminals${route}`, {
  method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
});
it('requires local authentication for both streaming and input, and rejects hostile origins', async () => {
  expect((await app.request('/api/terminals/projects/p')).status).toBe(401);
  expect((await request('/projects/p', 'GET', undefined, { Origin: 'https://untrusted.invalid' })).status).toBe(403);
  expect((await request('/projects/p')).status).toBe(200);
});
it('uses the selected workspace, deduplicates creation and prevents cross-project operations', async () => {
  expect((await request('/projects/p', 'POST', { requestId: randomUUID() })).status).toBe(400);
  const input = { requestId: randomUUID(), rootId: 'ref' };
  const created = await request('/projects/p', 'POST', input); expect(created.status).toBe(201);
  const item = await created.json(); expect(item.cwd).toBe(fs.realpathSync(path.join(root, 'two')));
  expect((await (await request('/projects/p', 'POST', input)).json()).id).toBe(item.id);
  for (const suffix of ['', '/stream']) expect((await request(`/projects/other/${item.id}${suffix}`)).status).toBe(404);
  expect((await request(`/projects/other/${item.id}/input`, 'POST', { data: 'echo nope\r', requestId: randomUUID() })).status).toBe(404);
  expect((await request(`/projects/p/${item.id}/resize`, 'POST', { cols: 0, rows: 30 })).status).toBe(400);
  expect((await request(`/projects/p/${item.id}`, 'DELETE')).status).toBe(409);
  expect((await request(`/projects/p/${item.id}/stop`, 'POST')).status).toBe(200);
  expect((await request(`/projects/p/${item.id}`, 'DELETE')).status).toBe(200);
});
it('retains a completed service transcript and exposes it through authenticated SSE', async () => {
  const item = await terminalManager.create({ projectId: 'p', rootId: 'p', cwd: path.join(root, 'one'), kind: 'service', title: 'output', command: process.platform === 'win32' ? 'echo retained output' : 'printf "retained output"' });
  await vi.waitFor(() => expect(terminalManager.get(item.id).state).toBe('closed'));
  const response = await request(`/projects/p/${item.id}/stream`);
  const output = await response.text(); expect(output).toContain('retained output'); expect(output).toContain('terminal-state');
  expect(output).toContain('"state":"closed"');
});
it('does not restart legacy services without explicit confirmation and validates the directory before stopping', async () => {
  const session = agentSessionRuntime.create({ projectId: 'p', profileId: 'synax', prompt: 'test' });
  const previous = prepareOwnedProcess('legacy command', true, { sessionId: session.id, background: true });
  const url = `/sessions/${session.id}/processes/${previous.id}/restart`;
  expect((await request(url, 'POST', { command: 'echo x', cwd: root, requestId: randomUUID() })).status).toBe(400);
  await request(url, 'POST', { confirm: true, command: 'echo x', cwd: '/does-not-exist/synax-e2e', requestId: randomUUID() });
  expect(getRawSqlite().prepare('SELECT state FROM agent_runtime_processes WHERE id=?').get(previous.id)).toMatchObject({ state: 'preparing' });
  releaseOwnedProcess(previous.id);
  expect((await request(url, 'POST', { confirm: true, command: 'printf legacy-restarted', cwd: root, requestId: randomUUID() })).status).toBe(201);
});
it('rejects a stale worker execution lease before spawning a background terminal', async () => {
  const session = agentSessionRuntime.create({ projectId: 'p', profileId: 'synax', prompt: 'test' });
  vi.stubEnv('SYNAX_RUNTIME_HOST_ID', 'unit-host');
  const result = await request(`/sessions/${session.id}/services`, 'POST', { command: 'echo must-not-run', cwd: root, requestId: randomUUID(), execution: { sessionId: session.id, runId: 'missing-run', epoch: 'expired', hostId: 'unit-host' } });
  expect(result.status).toBe(409);
  expect(terminalManager.list('p')).toHaveLength(0);
  agentRuntimeStore.updateSession(session.id, { status: 'completed' });
});
