import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DATA_ROOT } from './env.js';
import { logger } from './logger.js';
import { RuntimeSidecarClient } from '../../modules/agent-runtime/sidecar/sidecar-client.js';

const READY_PREFIX = 'SYNAX_RUNTIME_READY:';
export type RustRuntimeStatus = 'starting' | 'ready' | 'backoff' | 'failed' | 'stopped';
export interface RustRuntimeSidecarHandle {
  binaryPath: string;
  socketPath: string;
  token: string;
  port: number;
  process: ChildProcess;
  generation: number;
  status: RustRuntimeStatus;
  waitUntilReady(): Promise<void>;
  stop(): Promise<void>;
}
export interface RustRuntimeReady {
  type: 'runtime_ready'; protocol: string; port: number; pid: number;
  socket: string | null; capabilities: string[];
}
interface SupervisorOptions {
  binaryPath?: string;
  args?: string[];
  dataRoot?: string;
  env?: NodeJS.ProcessEnv;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  restartDelaysMs?: number[];
  probe?: (socketPath: string, token: string) => Promise<void>;
}

export function resolveRustRuntimeSidecarBinary(): string {
  if (process.env.SYNAX_RUNTIME_SIDECAR_BIN) return process.env.SYNAX_RUNTIME_SIDECAR_BIN;
  const name = process.platform === 'win32' ? 'synax-runtime-sidecar.exe' : 'synax-runtime-sidecar';
  const candidates = [
    path.resolve(process.cwd(), 'runtime-sidecar', 'target', 'release', name),
    path.resolve(process.cwd(), 'runtime-sidecar', 'target', 'debug', name),
    process.argv[1] ? path.resolve(path.dirname(process.argv[1]), 'workers', name) : '',
  ].filter(Boolean);
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error(`Rust runtime sidecar binary not found. Build it with npm run runtime-sidecar:build. Tried: ${candidates.join(', ')}`);
  return found;
}
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null || !child.pid;

/** Socket/token remain stable within a host so already-running workers can reconnect. */
export class RustRuntimeSupervisor implements RustRuntimeSidecarHandle {
  readonly binaryPath: string;
  readonly socketPath: string;
  readonly token = randomBytes(32).toString('hex');
  readonly hotPath: string;
  readonly historyPath: string;
  process!: ChildProcess;
  port = 0;
  generation = 0;
  status: RustRuntimeStatus = 'starting';
  private wanted = true;
  private attempt = 0;
  private failures = 0;
  private readyAt = 0;
  private socketIdentity?: { ino: bigint; dev: bigint };
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private stopping?: Promise<void>;
  private failure?: Error;
  private readonly lifetime = new AbortController();
  private readonly waiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private readonly startTimeout: number;
  private readonly stopTimeout: number;
  private readonly delays: number[];

  constructor(private readonly options: SupervisorOptions = {}) {
    this.binaryPath = options.binaryPath ?? resolveRustRuntimeSidecarBinary();
    const root = path.resolve(options.dataRoot ?? DATA_ROOT);
    const key = createHash('sha256').update(root).digest('hex').slice(0, 12);
    this.socketPath = path.join(os.tmpdir(), `synax-runtime-${key}-${process.pid}.sock`);
    this.hotPath = path.join(root, 'runtime-sidecar', 'runtime-hot');
    this.historyPath = path.join(root, 'runtime-sidecar', 'runtime-history');
    this.startTimeout = options.startTimeoutMs ?? 30_000;
    this.stopTimeout = options.stopTimeoutMs ?? 5_000;
    this.delays = options.restartDelaysMs ?? [100, 500, 1500];
    mkdirSync(path.dirname(this.hotPath), { recursive: true });
  }

  start(): Promise<void> {
    if (!this.wanted) return Promise.reject(this.failure ?? new Error('Runtime supervisor stopped.'));
    if (this.pending) return this.status === 'ready' ? Promise.resolve() : this.waitUntilReady();
    this.pending = this.launch().catch(error => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    return this.pending;
  }

  waitUntilReady(): Promise<void> {
    if (this.status === 'ready' && !exited(this.process)) return Promise.resolve();
    if (this.status === 'failed' || this.status === 'stopped') return Promise.reject(this.failure ?? new Error('Runtime supervisor stopped.'));
    return new Promise((resolve, reject) => this.waiters.add({ resolve, reject }));
  }

  private async launch(): Promise<void> {
    const attempt = ++this.attempt;
    this.status = 'starting';
    const child = spawn(this.binaryPath, this.options.args ?? [], {
      cwd: process.cwd(),
      env: { ...process.env, ...this.options.env,
        SYNAX_RUNTIME_SIDECAR_PORT: '0', SYNAX_RUNTIME_SIDECAR_SOCKET: this.socketPath,
        SYNAX_RUNTIME_SIDECAR_TOKEN: this.token, SYNAX_RUNTIME_HOT_PATH: this.hotPath,
        SYNAX_RUNTIME_HISTORY_PATH: this.historyPath,
        SYNAX_RUNTIME_PARENT_WATCH: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    child.stdin?.on('error', () => {}); // Peer exit may race a graceful stdin.end().
    child.on('error', error => logger.debug({ error }, '[runtime-sidecar] process error'));
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
      logger.debug({ output: chunk.toString().trim() }, '[runtime-sidecar] stderr');
    });
    child.once('exit', (code, signal) => {
      if (this.wanted && attempt === this.attempt && this.status === 'ready') {
        if (Date.now() - this.readyAt >= 60_000) this.failures = 0;
        this.schedule(new Error(`Rust runtime exited (${code ?? signal ?? 'unknown'}).`));
      }
    });
    try {
      const ready = await new Promise<RustRuntimeReady>((resolve, reject) => {
        const lines = createInterface({ input: child.stdout! });
        const cleanup = () => { clearTimeout(timer); lines.close(); child.off('error', onError); child.off('exit', onExit); child.stdout?.resume(); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => onError(new Error(`Rust runtime exited before READY (${code ?? signal ?? 'unknown'}): ${stderr}`));
        const timer = setTimeout(() => onError(new Error(`Rust runtime startup timed out: ${stderr}`)), this.startTimeout);
        child.once('error', onError); child.once('exit', onExit);
        lines.on('line', line => {
          if (!line.startsWith(READY_PREFIX)) return;
          try {
            const value = JSON.parse(line.slice(READY_PREFIX.length)) as RustRuntimeReady;
            if (value.type !== 'runtime_ready' || value.protocol !== 'synax.runtime.v2' || value.pid !== child.pid ||
                value.socket !== this.socketPath || !Number.isInteger(value.port) || value.port <= 0 || value.port > 65535 ||
                !Array.isArray(value.capabilities) || !value.capabilities.includes('append_receipts'))
              throw new Error('Rust runtime returned an incompatible READY payload.');
            cleanup(); resolve(value);
          } catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
        });
      });
      const probe = this.options.probe ?? (async (socketPath: string, token: string) => {
        const client = new RuntimeSidecarClient({ socketPath, token, requestTimeoutMs: 1000, retryTimeoutMs: 1000 });
        const close = () => client.close();
        this.lifetime.signal.addEventListener('abort', close, { once: true });
        try { const response = await client.health(); if (!response.ok) throw new Error('Rust runtime health probe failed.'); }
        finally { this.lifetime.signal.removeEventListener('abort', close); client.close(); }
      });
      await new Promise<void>((resolve, reject) => {
        const abort = () => { cleanup(); reject(new Error('Runtime startup was cancelled.')); };
        const cleanup = () => { clearTimeout(timer); this.lifetime.signal.removeEventListener('abort', abort); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Runtime health probe timed out.')); }, this.startTimeout);
        this.lifetime.signal.addEventListener('abort', abort, { once: true });
        if (this.lifetime.signal.aborted) { abort(); return; }
        void probe(this.socketPath, this.token).then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
      });
      if (!this.wanted || attempt !== this.attempt || exited(child)) throw new Error('Runtime startup was cancelled.');
      try {
        const stat = lstatSync(this.socketPath, { bigint: true });
        if (stat.isSocket()) this.socketIdentity = { ino: stat.ino, dev: stat.dev };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.port = ready.port; this.generation++; this.status = 'ready'; this.readyAt = Date.now();
      Object.assign(process.env, { SYNAX_RUNTIME_SIDECAR_SOCKET: this.socketPath, SYNAX_RUNTIME_SIDECAR_TOKEN: this.token,
        SYNAX_RUNTIME_SIDECAR_PORT: String(this.port), SYNAX_RUNTIME_HOT_PATH: this.hotPath,
        SYNAX_RUNTIME_HISTORY_PATH: this.historyPath });
      for (const waiter of this.waiters) waiter.resolve(); this.waiters.clear();
      logger.info({ binaryPath: this.binaryPath, socketPath: this.socketPath, port: this.port, sidecarPid: child.pid, generation: this.generation, protocol: ready.protocol }, '[runtime-sidecar] started');
    } catch (error) {
      await this.terminate(child);
      throw error;
    }
  }

  private schedule(error: Error): void {
    if (!this.wanted) return;
    this.port = 0;
    if (process.env.SYNAX_RUNTIME_SIDECAR_TOKEN === this.token) delete process.env.SYNAX_RUNTIME_SIDECAR_PORT;
    if (this.failures >= this.delays.length) { this.fail(error); return; }
    this.status = 'backoff';
    const delay = this.delays[this.failures++];
    logger.warn({ error: error.message, delay, attempt: this.failures }, '[runtime-sidecar] restarting');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.wanted) return;
      this.pending = this.launch().catch(error => this.schedule(error instanceof Error ? error : new Error(String(error))));
    }, delay);
  }

  private fail(error: Error): void {
    this.failure = error; this.wanted = false; this.lifetime.abort();
    if (this.status !== 'stopped') this.status = 'failed';
    clearTimeout(this.retryTimer); this.retryTimer = undefined;
    for (const waiter of this.waiters) waiter.reject(error); this.waiters.clear();
  }

  private terminate(child: ChildProcess): Promise<void> {
    if (exited(child)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let confirmation: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { clearTimeout(force); clearTimeout(confirmation); child.off('exit', done); };
      const done = () => { cleanup(); resolve(); };
      child.once('exit', done);
      const force = setTimeout(() => {
        if (exited(child)) { done(); return; }
        child.kill('SIGKILL');
        confirmation = setTimeout(() => { cleanup(); reject(new Error('Rust runtime shutdown could not be confirmed.')); }, 2000);
      }, this.stopTimeout);
      child.stdin?.end();
      child.kill('SIGINT');
    });
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.wanted = false; this.status = 'stopped'; this.lifetime.abort();
    clearTimeout(this.retryTimer); this.retryTimer = undefined;
    for (const waiter of this.waiters) waiter.reject(new Error('Runtime supervisor stopped.')); this.waiters.clear();
    this.stopping = (async () => {
      if (this.process) await this.terminate(this.process);
      await this.pending?.catch(() => {});
      if (process.env.SYNAX_RUNTIME_SIDECAR_TOKEN === this.token) {
        delete process.env.SYNAX_RUNTIME_SIDECAR_TOKEN; delete process.env.SYNAX_RUNTIME_SIDECAR_SOCKET;
        delete process.env.SYNAX_RUNTIME_SIDECAR_PORT; delete process.env.SYNAX_RUNTIME_HOT_PATH;
        delete process.env.SYNAX_RUNTIME_HISTORY_PATH;
      }
      if (this.socketIdentity) {
        try {
          const current = lstatSync(this.socketPath, { bigint: true });
          if (current.ino === this.socketIdentity.ino && current.dev === this.socketIdentity.dev) unlinkSync(this.socketPath);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    })();
    return this.stopping;
  }
}

export async function startRustRuntimeSidecar(): Promise<RustRuntimeSidecarHandle | null> {
  if (process.env.SYNAX_RUNTIME_SIDECAR_SUPERVISOR !== '1') return null;
  if (process.platform === 'win32') throw new Error('Rust runtime supervisor currently requires Unix transport.');
  const supervisor = new RustRuntimeSupervisor();
  try { await supervisor.start(); return supervisor; }
  catch (error) { await supervisor.stop(); throw error; }
}
export async function stopRustRuntimeSidecar(handle: RustRuntimeSidecarHandle | null | undefined): Promise<void> {
  await handle?.stop();
}
