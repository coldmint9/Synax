import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let appPath = process.cwd();
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => appPath },
  systemPreferences: {
    isTrustedAccessibilityClient: vi.fn(() => true),
    getMediaAccessStatus: vi.fn(() => 'granted'),
  },
}));

const originalEnv = { ...process.env };

function writeExecutable(target: string, body: string): string {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  fs.chmodSync(target, 0o755);
  return target;
}

/** Helper contract: `--version` prints `synax-cua <sdk version>`. */
const VERSION_SCRIPT = [
  "if (process.argv.includes('--version')) {",
  "  process.stdout.write('synax-cua 0.30.2\\n');",
  '  process.exit(0);',
  '}',
  'process.exit(0);',
].join('\n');

describe('Synax CUA helper supervisor', () => {
  let dir = '';
  let helperPath = '';
  let driverPath = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-cua-helper-'));
    appPath = dir;
    helperPath = writeExecutable(
      path.join(dir, 'cua-helper-dist', 'cua-helper.cjs'),
      VERSION_SCRIPT,
    );
    driverPath = writeExecutable(
      path.join(dir, 'cua-driver', 'cua-driver'),
      '#!/bin/sh\nexit 0\n',
    );
    process.env.SYNAX_CUA_HELPER_PATH = helperPath;
    process.env.SYNAX_CUA_DRIVER_PATH = driverPath;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function supervisor() {
    vi.resetModules();
    const { CuaRuntimeManager } = await import('./cua-runtime.js');
    const emitted = vi.fn();
    return { runtime: new CuaRuntimeManager(emitted), emitted };
  }

  it('reads macOS permissions from the Electron host process', async () => {
    const electron = await import('electron');
    const accessibility = electron.systemPreferences.isTrustedAccessibilityClient as ReturnType<typeof vi.fn>;
    const screen = electron.systemPreferences.getMediaAccessStatus as ReturnType<typeof vi.fn>;
    accessibility.mockReturnValue(false);
    screen.mockReturnValue('denied');

    const { runtime } = await supervisor();
    await expect(runtime.permissions()).resolves.toEqual({
      accessibility: false,
      screenRecording: false,
      error: null,
    });
    expect(accessibility).toHaveBeenCalledWith(false);
    expect(screen).toHaveBeenCalledWith('screen');
  });

  it('resolves the helper as a separate process with its own bundle identity', async () => {
    const { runtime, emitted } = await supervisor();
    const pending = runtime.start();
    expect(runtime.start()).toBe(pending);
    expect(runtime.status().state).toBe('starting');
    const connection = await pending;
    expect(connection).not.toBeNull();
    expect(runtime.status()).toEqual({ state: 'ready', error: null });
    const env = Object.fromEntries(
      connection!.mcp.environment.map((entry) => [entry.name, entry.value]),
    );
    expect(env.SYNAX_CUA_BUNDLE_ID).toBe('com.Synax.cua');
    expect(env.SYNAX_CUA_DRIVER_PATH).toBe(driverPath);
    expect(connection!.mcp.args.join(' ')).toContain(
      `--generation ${connection!.generation}`,
    );
    expect(emitted).toHaveBeenCalledWith(
      expect.objectContaining({ generation: connection!.generation }),
    );
    await runtime.stop();
    expect(runtime.status().state).toBe('stopped');
    expect(emitted).toHaveBeenLastCalledWith(null);
  });

  it('resolves the packaged helper bundle shipped by Electron Forge', async () => {
    delete process.env.SYNAX_CUA_HELPER_PATH;
    delete process.env.SYNAX_CUA_DRIVER_PATH;
    const { resolveHelperLaunch } = await import('./cua-runtime.js');
    const launch = resolveHelperLaunch({
      platform: 'darwin',
      isPackaged: true,
      appPath: '/Applications/Synax.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/Synax.app/Contents/Resources',
      env: {},
    });
    expect(launch.helperRoot).toBe('/Applications/Synax.app/Contents/Resources/cua-helper-dist');
    expect(launch.command).toBe(process.execPath);
    expect(launch.baseArgs).toEqual([
      '/Applications/Synax.app/Contents/Resources/cua-helper-dist/cua-helper.cjs',
    ]);
    expect(launch.artifactPath).toBe(launch.baseArgs[0]);
  });

  it('refuses a helper that does not match the pinned SDK version', async () => {
    fs.writeFileSync(helperPath, "process.stdout.write('synax-cua 0.0.1\\n');");
    const { runtime } = await supervisor();
    expect(await runtime.start()).toBeNull();
    expect(runtime.status().state).toBe('unavailable');
    expect(runtime.status().error).toContain('incompatible');
  });

  it('reports a missing driver binary instead of starting degraded', async () => {
    fs.rmSync(driverPath);
    const { runtime } = await supervisor();
    expect(await runtime.start()).toBeNull();
    expect(runtime.status().error).toContain('Cua Driver binary is unavailable');
  });

  it('clears the connection when the helper MCP session ends', async () => {
    const { runtime, emitted } = await supervisor();
    await runtime.start();
    runtime.markUnavailable('Synax CUA helper exited');
    expect(runtime.status()).toEqual({
      state: 'unavailable',
      error: 'Synax CUA helper exited',
    });
    expect(emitted).toHaveBeenLastCalledWith(null);
  });

  it('issues a fresh generation on restart so the sidecar spawns a new helper', async () => {
    const { runtime } = await supervisor();
    const first = await runtime.start();
    const second = await runtime.restart();
    expect(second?.generation).toBeTruthy();
    expect(second?.generation).not.toBe(first?.generation);
  });

  it('stops emitting connections after shutdown', async () => {
    const { runtime, emitted } = await supervisor();
    await runtime.start();
    await runtime.stop();
    emitted.mockClear();
    expect(await runtime.start()).toBeNull();
    expect(emitted).not.toHaveBeenCalled();
  });
});
