import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installRuntimeAccess } from '../runtime-access.js';
let root: string; let app: Hono; let token: string; let mutations: number;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-access-')); mutations = 0; app = new Hono();
  const access = installRuntimeAccess(app, { dataRoot: root, webOrigins: ['http://localhost:5173'] });
  token = fs.readFileSync(access.tokenPath, 'utf8').trim();
  app.get('/api/health', c => c.json({ ok: true }));
  app.post('/api/change', c => { mutations++; return c.json({ ok: true }); });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const url = 'http://localhost:3210';

describe('runtime access boundary', () => {
  it('rejects unauthenticated calls and hostile browser origins without performing work', async () => {
    expect((await app.request(`${url}/api/change`, { method: 'POST' })).status).toBe(401);
    expect((await app.request(`${url}/api/change`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect(mutations).toBe(0);
    expect((await app.request(`${url}/api/health`)).status).toBe(200);
  });
  it('bootstraps a same-site local browser with an HttpOnly cookie, never returning the token in JSON', async () => {
    const bootstrap = await app.request(`${url}/api/auth/session`, { method: 'POST', headers: {
      Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin',
    } });
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.text()).not.toContain(token);
    const cookie = bootstrap.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
    const response = await app.request(`${url}/api/change`, { method: 'POST', headers: {
      Origin: 'http://localhost:5173', Cookie: cookie.split(';')[0],
    } });
    expect(response.status).toBe(200); expect(mutations).toBe(1);
  });
  it('requires a bearer token for opaque desktop origins and supports trusted headless clients', async () => {
    expect((await app.request(`${url}/api/auth/session`, { method: 'POST', headers: { Origin: 'null' } })).status).toBe(403);
    expect((await app.request(`${url}/api/change`, { method: 'POST', headers: {
      Origin: 'null', Authorization: `Bearer ${token}`,
    } })).status).toBe(200);
    expect((await app.request(`${url}/api/change`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });
  it('permits desktop preflight but never treats it as authentication', async () => {
    const response = await app.request(`${url}/api/change`, { method: 'OPTIONS', headers: {
      Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Authorization',
    } });
    expect(response.status).toBe(204); expect(mutations).toBe(0);
    expect((await app.request(`${url}/api/change`, { method: 'POST', headers: { Authorization: `Bearer ${'é'.repeat(64)}` } })).status).toBe(401);
  });

  it('blocks DNS rebinding hosts and cross-site cookie requests', async () => {
    expect((await app.request('http://evil.example/api/change', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
    expect((await app.request(`${url}/api/auth/session`, { method: 'POST', headers: {
      Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'cross-site',
    } })).status).toBe(403);
    expect(fs.statSync(path.join(root, 'runtime-access-token')).mode & 0o777).toBe(0o600);
  });
});
