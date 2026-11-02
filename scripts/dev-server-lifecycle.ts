import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createConnection, createServer, type Server } from 'node:net';
import path from 'node:path';
import { ROOT_DIR } from './_shared.js';

/** Let the OS choose ephemeral ports; hold both sockets until the pair is chosen. */
export async function resolveWebDevPorts(env: NodeJS.ProcessEnv = process.env): Promise<{ PORT: string; WEB_PORT: string }> {
  const requests = (['PORT', 'WEB_PORT'] as const).map(name => {
    const raw = env[name]?.trim();
    const port = raw ? Number(raw) : 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error(`${name} must be an integer from 0 to 65535 (0 selects a random port).`);
    return { name, port, host: name === 'PORT' ? '127.0.0.1' : env.WEB_HOST ?? '127.0.0.1' };
  });
  if (requests[0].port && requests[0].port === requests[1].port)
    throw new Error('PORT and WEB_PORT must be different.');
  const reservations: Server[] = [];
  const result = {} as { PORT: string; WEB_PORT: string };
  try {
    // Reserve fixed overrides first so random allocation cannot claim them.
    for (const request of requests.sort((a, b) => Number(b.port !== 0) - Number(a.port !== 0))) {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', error => reject(new Error(`Cannot allocate ${request.name}=${request.port}: ${error.message}`)));
        server.listen({ port: request.port, host: request.host, exclusive: true }, resolve);
      });
      reservations.push(server);
      result[request.name] = String((server.address() as { port: number }).port);
    }
    return result;
  } finally {
    await Promise.all(reservations.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}

function listening(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const finish = (busy: boolean) => { socket.destroy(); resolve(busy); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(750, () => finish(false));
  });
}

/** Check loopback too: a wildcard bind can coexist with an older loopback listener. */
export async function assertDevPortsAvailable(ports: number[], host = '127.0.0.1'): Promise<void> {
  if (new Set(ports).size !== ports.length) throw new Error('PORT and WEB_PORT must be different.');
  for (const port of ports) {
    const hosts = new Set(['127.0.0.1', '::1', host]);
    const busy = await Promise.all([...hosts].map(address => listening(address, port)));
    if (busy.some(Boolean)) throw new Error(`Port ${port} is already in use. Stop the existing development service or choose different PORT / WEB_PORT values; no existing process was stopped.`);
  }
}

/** Direct Node entrypoints avoid npm/npx wrappers; each child owns its process group. */
export function spawnDevServer(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const hosts = [env.NO_PROXY, env.no_proxy, 'localhost,127.0.0.1,::1'].filter(Boolean).join(',');
  return spawn(process.execPath, [path.join(ROOT_DIR, entry), ...args], {
    cwd, env: { ...env, NO_PROXY: hosts, no_proxy: hosts }, stdio: 'inherit',
    detached: process.platform !== 'win32',
  });
}

/** Only signal children started by this invocation, never a pre-existing port owner. */
export function stopDevServer(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}

export async function waitForDevApi(port: number, signal: AbortSignal, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: 'error',
      });
      if (response.ok) {
        const body = await response.json();
        if (body.ok === true && body.service === 'api') return;
      }
    } catch { signal.throwIfAborted(); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`API on port ${port} did not become ready within ${timeoutMs}ms. Check the backend output above.`);
}
