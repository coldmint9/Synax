import fs, { constants } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { app } from 'electron';
import type { EmbeddedCuaDriverHost, EmbeddedDriverConnection } from '@trycua/cua-driver';

export const CUA_SDK_VERSION = '0.30.2';

export type CuaRuntimeStatus = 'idle' | 'starting' | 'ready' | 'restarting' | 'unavailable' | 'stopped';
export type CuaRuntimeConnection = Pick<EmbeddedDriverConnection, 'generation' | 'mcp'>;

/** Electron owns the permission chain; slow desktop work runs in the Driver child. */
export class CuaRuntimeManager {
  private host: EmbeddedCuaDriverHost | null = null;
  private connection: CuaRuntimeConnection | null = null;
  private pending: Promise<CuaRuntimeConnection | null> | null = null;
  private currentStatus: CuaRuntimeStatus = 'idle';
  private lastError: string | null = null;
  private stopped = false;
  constructor(private readonly onConnection: (connection: CuaRuntimeConnection | null) => void) {}

  status(): { state: CuaRuntimeStatus; error: string | null } {
    return { state: this.currentStatus, error: this.lastError };
  }

  start(): Promise<CuaRuntimeConnection | null> {
    if (this.stopped) return Promise.resolve(null);
    if (this.connection) return Promise.resolve(this.connection);
    if (this.pending) return this.pending;
    this.currentStatus = 'starting';
    this.pending = this.startHost().catch((error: unknown) => {
      this.currentStatus = 'unavailable';
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn('[cua] runtime unavailable:', this.lastError);
      return null;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async resolveExecutable(): Promise<string> {
    const override = process.env.SYNAX_CUA_DRIVER_PATH?.trim();
    const packaged = override ? '' : path.join(process.resourcesPath, 'cua-driver', process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
    if (override && !path.isAbsolute(override)) throw new Error('SYNAX_CUA_DRIVER_PATH must be absolute');
    let executable = override ?? packaged;
    if (!override && !app.isPackaged) {
      try {
        const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'where.exe' : 'which', ['cua-driver'], { timeout: 1_500 });
        executable = stdout.trim().split(/\r?\n/)[0];
      } catch { /* Use the packaged-resource lookup for a clear error. */ }
    }
    await fs.access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 3_000 });
    const found = /\bcua-driver\s+(\d+\.\d+\.\d+)\b/.exec(stdout)?.[1];
    if (found !== CUA_SDK_VERSION)
      throw new Error(`Cua Driver ${found ?? 'unknown'} is incompatible with Synax SDK ${CUA_SDK_VERSION}; install a matching executable or set SYNAX_CUA_DRIVER_PATH.`);
    return executable;
  }

  private async startHost(): Promise<CuaRuntimeConnection> {
    const executable = await this.resolveExecutable();
    // Import only after the window is painted; native library initialization must
    // not delay Electron startup. The native host's start() is asynchronous.
    const sdkEntry = app.isPackaged
      ? pathToFileURL(path.join(process.resourcesPath, 'server-dist', 'node_modules', '@trycua', 'cua-driver', 'dist', 'index.js')).href
      : '@trycua/cua-driver';
    const { EmbeddedCuaDriverHost, requestMacOsPermissions } = await import(sdkEntry) as typeof import('@trycua/cua-driver');
    if (process.platform === 'darwin') {
      // Request from the Electron host before checking status so macOS registers
      // Synax in its Screen Recording permission list.
      const permissions = requestMacOsPermissions();
      if (!permissions.accessibility || !permissions.screenRecording)
        throw new Error('Grant Synax Accessibility and Screen Recording in macOS System Settings, then relaunch Synax.');
    }
    if (this.stopped) throw new Error('Cua runtime stopped during startup');
    this.host ??= new EmbeddedCuaDriverHost(executable, 'com.Synax.desktop');
    const started = await this.host.start();
    if (this.stopped) {
      await this.host.stop();
      throw new Error('Cua runtime stopped during startup');
    }
    this.connection = { generation: started.generation, mcp: started.mcp };
    this.currentStatus = 'ready';
    this.lastError = null;
    this.onConnection(this.connection);
    void this.host.waitForExit(started.generation).then(() => {
      if (this.connection?.generation !== started.generation || this.stopped) return;
      this.connection = null;
      this.currentStatus = 'unavailable';
      this.lastError = 'Cua Driver exited unexpectedly';
      this.onConnection(null);
    }).catch((error: unknown) => console.warn('[cua] exit monitor:', error));
    return this.connection;
  }

  async restart(): Promise<CuaRuntimeConnection | null> {
    if (this.stopped) return null;
    this.currentStatus = 'restarting';
    this.connection = null;
    this.onConnection(null);
    await this.pending;
    if (!this.host) return this.start();
    try {
      const started = await this.host.restart();
      if (this.stopped) { await this.host.stop(); return null; }
      this.connection = { generation: started.generation, mcp: started.mcp };
      this.currentStatus = 'ready';
      this.lastError = null;
      this.onConnection(this.connection);
      return this.connection;
    } catch (error) {
      this.currentStatus = 'unavailable';
      this.lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.connection = null;
    this.onConnection(null);
    await this.pending;
    try { await this.host?.stop(); }
    finally {
      this.host?.uniffiDestroy();
      this.host = null;
      this.currentStatus = 'stopped';
    }
  }
}
