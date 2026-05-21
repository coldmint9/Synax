import { spawn, type ChildProcess } from 'node:child_process';
import { utilityProcess, app, type UtilityProcess } from 'electron';
import path from 'node:path';
import net from 'node:net';
import { getDataRoot, getResourcePath } from './data-paths.js';

let sidecar: UtilityProcess | ChildProcess | null = null;
let assignedPort: number = 3210;

export function getSidecarPort(): number {
  return assignedPort;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error('Failed to get port'));
      }
    });
    server.on('error', reject);
  });
}

function getServerEntry(): string {
  if (app.isPackaged) {
    return getResourcePath('server-dist', 'server.js');
  }
  return path.resolve(app.getAppPath(), 'api', 'server.ts');
}

export async function startSidecar(): Promise<number> {
  assignedPort = await findFreePort();
  const entry = getServerEntry();
  const dataRoot = getDataRoot();

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PORT: String(assignedPort),
    DATA_ROOT: dataRoot,
    NODE_ENV: app.isPackaged ? 'production' : 'development',
  };

  if (app.isPackaged) {
    const child = utilityProcess.fork(entry, [], {
      cwd: process.resourcesPath,
      env,
      stdio: 'pipe',
    });
    child.on('exit', (code) => {
      console.log(`[sidecar] exited with code ${code}`);
      sidecar = null;
    });
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
    sidecar = child;
  } else {
    const child = spawn('npx', ['tsx', entry], {
      cwd: app.getAppPath(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('exit', (code) => {
      console.log(`[sidecar] exited with code ${code}`);
      sidecar = null;
    });
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
    sidecar = child;
  }

  await waitForHealth(assignedPort);
  return assignedPort;
}

async function waitForHealth(port: number, retries = 30): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Sidecar failed to start on port ${port}`);
}

export function stopSidecar(): void {
  if (!sidecar) return;
  sidecar.kill();
  const ref = sidecar;
  setTimeout(() => {
    if (ref && 'killed' in ref && !ref.killed) ref.kill();
  }, 3000);
}