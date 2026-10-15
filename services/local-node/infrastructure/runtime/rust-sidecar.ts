import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DATA_ROOT } from './env.js';
import { logger } from './logger.js';

const READY_PREFIX = 'SYNAX_RUNTIME_READY:';
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

export interface RustRuntimeSidecarHandle {
  binaryPath: string;
  socketPath: string;
  token: string;
  port: number;
  process: ChildProcess;
}

export interface RustRuntimeReady {
  type: 'runtime_ready';
  protocol: string;
  port: number;
  socket: string | null;
  capabilities: string[];
}

function binaryName(): string {
  return process.platform === 'win32'
    ? 'synax-runtime-sidecar.exe'
    : 'synax-runtime-sidecar';
}

export function resolveRustRuntimeSidecarBinary(): string {
  const explicit = process.env.SYNAX_RUNTIME_SIDECAR_BIN;
  if (explicit) return explicit;
  const name = binaryName();
  const candidates = [
    path.resolve(process.cwd(), 'runtime-sidecar', 'target', 'release', name),
    path.resolve(process.cwd(), 'runtime-sidecar', 'target', 'debug', name),
    process.argv[1]
      ? path.resolve(path.dirname(process.argv[1]), 'workers', name)
      : '',
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found)
    throw new Error(
      `Rust runtime sidecar binary not found. Build it with npm run runtime-sidecar:build or set SYNAX_RUNTIME_SIDECAR_BIN. Tried: ${candidates.join(', ')}`,
    );
  return found;
}

function parseReady(line: string): RustRuntimeReady | null {
  if (!line.startsWith(READY_PREFIX)) return null;
  const value = JSON.parse(line.slice(READY_PREFIX.length)) as RustRuntimeReady;
  if (
    value.type !== 'runtime_ready' ||
    !value.protocol ||
    !Number.isInteger(value.port) ||
    value.port <= 0 ||
    value.port > 65535
  )
    throw new Error('Rust runtime sidecar returned an invalid READY payload.');
  return value;
}

export async function startRustRuntimeSidecar(): Promise<RustRuntimeSidecarHandle | null> {
  if (process.env.SYNAX_RUNTIME_SIDECAR_SUPERVISOR !== '1') return null;
  if (process.platform === 'win32')
    throw new Error('Rust runtime sidecar supervisor currently requires the Unix transport.');

  const binaryPath = resolveRustRuntimeSidecarBinary();
  const runtimeDir = path.join(DATA_ROOT, 'runtime-sidecar');
  mkdirSync(runtimeDir, { recursive: true });
  const socketPath = path.join(runtimeDir, 'runtime.sock');
  const token = randomBytes(32).toString('hex');
  const hotPath = path.join(runtimeDir, 'runtime-hot');
  const child = spawn(binaryPath, [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SYNAX_RUNTIME_SIDECAR_SOCKET: socketPath,
      SYNAX_RUNTIME_SIDECAR_TOKEN: token,
      SYNAX_RUNTIME_HOT_PATH: hotPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) =>
    logger.debug({ output: chunk.toString().trim() }, '[runtime-sidecar] stderr'),
  );

  const ready = await new Promise<RustRuntimeReady>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Rust runtime sidecar startup timed out.')),
      START_TIMEOUT_MS,
    );
    const lines = createInterface({ input: child.stdout! });
    const cleanup = () => {
      clearTimeout(timer);
      lines.close();
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Rust runtime sidecar exited before READY (${code ?? signal ?? 'unknown'}).`));
    };
    child.on('error', onError);
    child.once('exit', onExit);
    lines.on('line', (line) => {
      try {
        const parsed = parseReady(line);
        if (!parsed) return;
        cleanup();
        resolve(parsed);
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  process.env.SYNAX_RUNTIME_SIDECAR_SOCKET = socketPath;
  process.env.SYNAX_RUNTIME_SIDECAR_TOKEN = token;
  process.env.SYNAX_RUNTIME_HOT_PATH = hotPath;
  const handle: RustRuntimeSidecarHandle = {
    binaryPath,
    socketPath,
    token,
    port: ready.port,
    process: child,
  };
  logger.info(
    { binaryPath, socketPath, port: ready.port, protocol: ready.protocol },
    '[runtime-sidecar] started',
  );
  return handle;
}

export async function stopRustRuntimeSidecar(
  handle: RustRuntimeSidecarHandle | null | undefined,
): Promise<void> {
  if (!handle || handle.process.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (handle.process.exitCode === null) handle.process.kill('SIGKILL');
      resolve();
    }, STOP_TIMEOUT_MS);
    timer.unref?.();
    handle.process.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    handle.process.kill('SIGINT');
  });
  if (process.env.SYNAX_RUNTIME_SIDECAR_SOCKET === handle.socketPath)
    delete process.env.SYNAX_RUNTIME_SIDECAR_SOCKET;
  if (process.env.SYNAX_RUNTIME_SIDECAR_TOKEN === handle.token)
    delete process.env.SYNAX_RUNTIME_SIDECAR_TOKEN;
  delete process.env.SYNAX_RUNTIME_HOT_PATH;
}
