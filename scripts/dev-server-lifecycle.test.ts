import { createServer as createTcpServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDevPortsAvailable, resolveWebDevPorts, spawnDevServer, stopDevServer, waitForDevApi } from './dev-server-lifecycle.js';
import { ROOT_DIR } from './_shared.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function busyPort() {
  const server = createTcpServer(socket => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return (server.address() as { port: number }).port;
}

describe('development server lifecycle', () => {
  it('allocates two distinct random ports and releases temporary reservations', async () => {
    const ports = await resolveWebDevPorts({});
    expect(Number(ports.PORT)).toBeGreaterThan(0);
    expect(Number(ports.WEB_PORT)).toBeGreaterThan(0);
    expect(ports.PORT).not.toBe(ports.WEB_PORT);
    await expect(assertDevPortsAvailable(Object.values(ports).map(Number))).resolves.toBeUndefined();
  });
  it('preserves a fixed override while randomizing the other port', async () => {
    const initial = await resolveWebDevPorts({});
    const ports = await resolveWebDevPorts({ PORT: initial.PORT, WEB_PORT: '0' });
    expect(ports.PORT).toBe(initial.PORT);
    expect(ports.WEB_PORT).not.toBe(ports.PORT);
    expect(Number(ports.WEB_PORT)).toBeGreaterThan(0);
  });
  it('rejects invalid or duplicate explicit ports', async () => {
    await expect(resolveWebDevPorts({ PORT: 'bad' })).rejects.toThrow('PORT must be');
    await expect(resolveWebDevPorts({ WEB_PORT: '65536' })).rejects.toThrow('WEB_PORT must be');
    await expect(resolveWebDevPorts({ PORT: '4301', WEB_PORT: '4301' })).rejects.toThrow('must be different');
  });
  it('detects an existing loopback listener even when WEB_HOST is a wildcard', async () => {
    const port = await busyPort();
    await expect(assertDevPortsAvailable([port], '0.0.0.0')).rejects.toThrow(`Port ${port} is already in use`);
  });
  it('rejects overlapping API and frontend ports', async () => {
    await expect(assertDevPortsAvailable([4301, 4301])).rejects.toThrow('must be different');
  });
  it('waits for this API health contract and does not accept an unrelated HTTP service', async () => {
    let ready = false;
    const server = createHttpServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(ready ? { ok: true, service: 'api' } : { ok: true, service: 'other' }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const port = (server.address() as { port: number }).port;
    await expect(waitForDevApi(port, new AbortController().signal, 150)).rejects.toThrow('did not become ready');
    ready = true;
    await expect(waitForDevApi(port, new AbortController().signal, 1000)).resolves.toBeUndefined();
  });
  it('stops waiting immediately when startup is cancelled', async () => {
    const controller = new AbortController(); controller.abort(new Error('Stopped'));
    await expect(waitForDevApi(1, controller.signal)).rejects.toThrow('Stopped');
  });
  it('dev:all fails before starting anything when its frontend port is already occupied', async () => {
    const webPort = await busyPort();
    const available = createTcpServer();
    available.listen(0, '127.0.0.1'); await once(available, 'listening');
    const apiPort = (available.address() as { port: number }).port;
    await new Promise<void>(resolve => available.close(() => resolve()));
    const child = spawn(process.execPath, [path.join(ROOT_DIR, 'node_modules/tsx/dist/cli.mjs'), 'scripts/dev-profile.ts', 'test-dev-ports', 'all'], {
      cwd: ROOT_DIR, env: { ...process.env, PORT: String(apiPort), WEB_PORT: String(webPort), WEB_HOST: '0.0.0.0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    cleanup.push(() => { child.kill(); });
    const [code] = await once(child, 'exit');
    expect(code).toBe(1);
    expect(stderr).toContain(`Port ${webPort} is already in use`);
    await expect(assertDevPortsAvailable([apiPort])).resolves.toBeUndefined();
    await expect(assertDevPortsAvailable([webPort])).rejects.toThrow('already in use');
  });
  it('terminates a directly launched child and releases its listening port', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'synax-dev-process-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const fixture = path.join(directory, 'server.cjs');
    const portFile = path.join(directory, 'port');
    await writeFile(fixture, `const net=require('node:net');const fs=require('node:fs');const server=net.createServer(s=>s.end());server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[2],String(server.address().port)));`);
    const child = spawnDevServer(path.relative(ROOT_DIR, fixture), [portFile], ROOT_DIR, process.env);
    cleanup.push(() => stopDevServer(child));
    const exited = once(child, 'exit');
    let port = 0;
    for (let i=0; i<100; i++) {
      try { port = Number(await readFile(portFile, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    expect(port).toBeGreaterThan(0);
    await expect(assertDevPortsAvailable([port])).rejects.toThrow('already in use');
    stopDevServer(child);
    await exited;
    await expect(assertDevPortsAvailable([port])).resolves.toBeUndefined();
  });
});
