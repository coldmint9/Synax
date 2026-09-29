import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));
let finishStart: ((value: unknown) => void) | undefined;
const host = {
  start: vi.fn(() => new Promise(resolve => { finishStart = resolve })),
  restart: vi.fn(), stop: vi.fn(async () => {}),
  waitForExit: vi.fn(() => new Promise(() => {})),
  uniffiDestroy: vi.fn(),
};
vi.mock('@trycua/cua-driver', () => ({ requestMacOsPermissions: vi.fn(() => ({ accessibility: true, screenRecording: true })), EmbeddedCuaDriverHost: class { constructor() { return host } } }));
const oldPath = process.env.SYNAX_CUA_DRIVER_PATH;
afterEach(() => { process.env.SYNAX_CUA_DRIVER_PATH = oldPath; vi.clearAllMocks() });

describe('non-blocking Cua host lifecycle', () => {
  it('keeps the event loop responsive while native start is pending', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-cua-electron-'));
    const binary = path.join(dir, 'cua-driver');
    fs.writeFileSync(binary, '#!/bin/sh\necho cua-driver 0.30.2\n'); fs.chmodSync(binary, 0o755);
    process.env.SYNAX_CUA_DRIVER_PATH = binary;
    try {
      const { CuaRuntimeManager } = await import('./cua-runtime.js');
      const { requestMacOsPermissions } = await import('@trycua/cua-driver');
      const emitted = vi.fn();
      const runtime = new CuaRuntimeManager(emitted);
      const pending = runtime.start();
      expect(runtime.start()).toBe(pending);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(runtime.status().state).toBe('starting');
      await vi.waitFor(() => expect(finishStart).toBeDefined(), { timeout: 5_000, interval: 10 });
      finishStart?.({ generation: 'g1', mcp: { command: binary, args: ['mcp'], environment: [] } });
      expect((await pending)?.generation).toBe('g1');
      expect(requestMacOsPermissions).toHaveBeenCalledOnce();
      expect(emitted).toHaveBeenCalledWith(expect.objectContaining({ generation: 'g1' }));
      await runtime.stop();
      expect(host.stop).toHaveBeenCalledOnce();
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  });
});
