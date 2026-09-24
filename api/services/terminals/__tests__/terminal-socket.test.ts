import { ObservationTransport } from "../../realtime/observation-transport.js";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { terminalManager } from '../terminal-manager.js';
import { attachTerminalSockets, issueTerminalTicket, consumeTerminalTicket } from '../terminal-socket.js';
import { installRuntimeAccess } from '../../../middleware/runtime-access.js';
import { terminalRoutes } from '../../../routes/terminals.js';
import { DATA_ROOT } from '../../../lib/env.js';
import { agentSessionRuntime } from '../../agent-runtime/session-runtime.js';
import { ensureSynaxAgentRegistered } from '../../agent-runtime/synax/index.js';

let cwd: string, server: Server, stopSockets: () => void, port: number;
const clients: WebSocket[] = [];
beforeEach(async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-terminal-socket-'));
  const app = new Hono(); installRuntimeAccess(app, { dataRoot: DATA_ROOT, webOrigins: ['http://trusted.test'] }); app.route('/api/terminals', terminalRoutes);
  const observations = new ObservationTransport(request => app.fetch(request));
  app.route('/api/realtime', observations.routes);
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }) as Server;
  const stopTerminals = attachTerminalSockets(server), stopObservations = observations.attach(server);
  stopSockets = () => { stopTerminals(); stopObservations(); };
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => { for (const client of clients.splice(0)) client.terminate(); stopSockets(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await terminalManager.shutdown(); fs.rmSync(cwd, { recursive: true, force: true }); });
async function connect(origin = 'http://trusted.test') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/socket`, { origin }); clients.push(ws);
  const frames: any[] = []; ws.on('message', data => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, frames };
}
it('requires an origin-bound single-use grant before releasing any terminal data', async () => {
  const terminal = await terminalManager.create({ projectId: 'p', rootId: 'r', cwd, title: 'auth', kind: 'terminal', shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', shellArgs: process.platform === 'win32' ? [] : ['-i'], env: { HOME: cwd, PS1: 'READY> ' } });
  const unauthorized = await connect();
  const denied = new Promise(resolve => unauthorized.ws.once('close', resolve));
  unauthorized.ws.send(JSON.stringify({ type: 'input', data: 'bad', requestId: randomUUID() }));
  await denied; expect(unauthorized.frames).toEqual([]);
  const wrong = await connect('http://wrong.test');
  const wrongClosed = new Promise(resolve => wrong.ws.once('close', resolve));
  wrong.ws.send(JSON.stringify({ type: 'attach', ticket: issueTerminalTicket('p', terminal.id, 'http://trusted.test') }));
  await wrongClosed; expect(wrong.frames).toEqual([]);
  const ticket = issueTerminalTicket('p', terminal.id, 'http://trusted.test');
  const valid = await connect(); valid.ws.send(JSON.stringify({ type: 'attach', ticket }));
  await vi.waitFor(() => expect(valid.frames.some(frame => frame.type === 'ready')).toBe(true));
  valid.ws.send(JSON.stringify({ type: 'input', data: process.platform === 'win32' ? 'echo socket-ready\r' : "printf 'socket-%s\\n' ready\r", requestId: randomUUID() }));
  await vi.waitFor(() => expect(valid.frames.filter(frame => frame.type === 'data').map(frame => frame.data).join('')).toContain('socket-ready'));
  expect(() => consumeTerminalTicket(ticket, 'http://trusted.test')).toThrow();
});
it('expires unclaimed connection grants', async () => {
  const terminal = await terminalManager.create({ projectId: 'p', rootId: 'r', cwd, title: 'expiry', kind: 'service', command: process.platform === 'win32' ? 'echo expiry' : 'printf expiry' });
  const ticket = issueTerminalTicket('p', terminal.id);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  try { expect(() => consumeTerminalTicket(ticket)).toThrow(); } finally { clock.mockRestore(); }
});
it('hosts worker-created services after their requesting worker has exited', async () => {
  ensureSynaxAgentRegistered();
  const session = agentSessionRuntime.create({ projectId: 'worker-pty', profileId: 'synax', prompt: 'test', workDir: cwd });
  const source = new URL('../terminal-service.ts', import.meta.url).href;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('setInterval(()=>{},1000)')}`;
  const script = `import { startBackgroundTerminal } from ${JSON.stringify(source)};const controller=new AbortController();const item=await startBackgroundTerminal(${JSON.stringify(session.id)},${JSON.stringify(command)},{cwd:${JSON.stringify(cwd)},signal:controller.signal});controller.abort();console.log(JSON.stringify(item));process.exit(0);`;
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script], {
    cwd: process.cwd(), timeout: 20000,
    env: { ...process.env, DATA_ROOT, SYNAX_AGENT_SESSION_CHILD: '1', SYNAX_TERMINAL_HOST_ORIGIN: `http://127.0.0.1:${port}`, LOG_LEVEL: 'error', HOME: cwd, ZDOTDIR: cwd },
  });
  const started = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  expect(terminalManager.get(started.processId).state).toBe('active');
  expect(() => terminalManager.write(started.processId, '\x03', randomUUID())).not.toThrow();
  await terminalManager.stop(started.processId);
  expect(terminalManager.get(started.processId).state).toBe('closed');
}, 30000);

it('shares the upgrade listener with authenticated realtime without killing either path', async () => {
  const token = fs.readFileSync(path.join(DATA_ROOT, 'runtime-access-token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${port}/api/realtime/connection`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'http://trusted.test' } });
  expect(response.status).toBe(200);
  const { ticket } = await response.json() as { ticket: string };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/realtime/socket`, { origin: 'http://trusted.test' }); clients.push(ws);
  const ready = new Promise<any>(resolve => ws.once('message', data => resolve(JSON.parse(data.toString()))));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'attach', ticket }));
  expect(await ready).toMatchObject({ type: 'ready', protocol: 1 });
});
