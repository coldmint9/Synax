import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { CliOptions } from './args.js';

export interface LocalRuntimeConnection {
  baseUrl: string;
  tokenFile: string;
  managed: boolean;
  port: number;
}

function packageRoot(): string {
  const candidates: string[] = [];
  if (process.env.SYNAX_PACKAGE_ROOT) candidates.push(process.env.SYNAX_PACKAGE_ROOT);
  if (typeof __filename !== 'undefined') candidates.push(path.resolve(path.dirname(__filename), '..'));
  if (process.argv[1]) {
    try { candidates.push(path.resolve(path.dirname(fs.realpathSync(process.argv[1])), '..')); }
    catch { candidates.push(path.resolve(path.dirname(process.argv[1]), '..')); }
  }
  candidates.push(process.cwd());
  return candidates.find(candidate => fs.existsSync(path.join(candidate, 'package.json'))) ?? process.cwd();
}

function dataRoot(): string {
  return path.resolve(process.env.DATA_ROOT ?? path.join(os.homedir(), '.synax'));
}

function requestedPort(): { port: number; explicit: boolean } {
  const raw = process.env.PORT;
  const parsed = raw ? Number(raw) : 3210;
  return { port: Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : 3210, explicit: Boolean(raw) };
}

function baseUrl(port: number): string { return `http://127.0.0.1:${port}`; }

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch { return false; }
}

async function synaxProtocol(url: string, tokenFile: string): Promise<boolean> {
  if (!fs.existsSync(tokenFile)) return false;
  let token: string;
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return false; }
  if (!token) return false;
  try {
    const response = await fetch(`${url}/api/agent-runtime/protocol`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return false;
    const payload = await response.json() as { protocol?: unknown };
    return payload.protocol === 'synax.runtime.v1';
  } catch { return false; }
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    const finish = (available: boolean) => { server.removeAllListeners(); server.close(() => resolve(available)); };
    server.once('error', () => finish(false));
    server.listen(port, '127.0.0.1', () => finish(true));
  });
}

async function selectPort(): Promise<number> {
  const requested = requestedPort();
  if (requested.explicit || await portAvailable(requested.port)) return requested.port;
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function serverCommand(): { command: string; args: string[]; cwd: string } {
  const root = packageRoot();
  const bundled = path.join(root, 'server-dist', 'server.cjs');
  if (fs.existsSync(bundled)) return { command: process.execPath, args: [bundled], cwd: path.dirname(bundled) };
  const source = path.join(root, 'api', 'server.ts');
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(source) && fs.existsSync(tsx)) return { command: process.execPath, args: [tsx, source], cwd: root };
  throw new Error(`Synax Runtime server is missing. Build the package first with npm run build. Checked ${bundled}.`);
}

async function waitForRuntime(url: string, tokenFile: string, child: ReturnType<typeof spawn>): Promise<void> {
  let childError: Error | undefined;
  child.once('error', error => { childError = error; });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await synaxProtocol(url, tokenFile)) return;
    if (childError) throw new Error(`Synax Runtime could not start: ${childError.message}`);
    if (child.exitCode !== null) throw new Error(`Synax Runtime exited while starting (code ${child.exitCode}).`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Synax Runtime did not expose synax.runtime.v1 at ${url}. Another service may be using the port; set PORT to an available port.`);
}

export async function ensureRuntime(options: CliOptions): Promise<LocalRuntimeConnection> {
  const explicitUrl = options.url ?? process.env.SYNAX_API;
  if (explicitUrl) return { baseUrl: explicitUrl.replace(/\/+$/, ''), tokenFile: options.tokenFile ?? '', managed: false, port: 0 };
  const tokenFile = path.join(dataRoot(), 'runtime-access-token');
  const requested = requestedPort();
  const existingUrl = baseUrl(requested.port);
  if (await synaxProtocol(existingUrl, tokenFile)) return { baseUrl: existingUrl, tokenFile, managed: false, port: requested.port };
  const port = await selectPort();
  const url = baseUrl(port);
  const command = serverCommand();
  fs.mkdirSync(dataRoot(), { recursive: true, mode: 0o700 });
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: { ...process.env, DATA_ROOT: dataRoot(), PORT: String(port) },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  await waitForRuntime(url, tokenFile, child);
  return { baseUrl: url, tokenFile, managed: true, port };
}
