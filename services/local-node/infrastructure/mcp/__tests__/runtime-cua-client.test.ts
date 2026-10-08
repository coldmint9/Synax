import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
let root: string;
const previousRoot = process.env.DATA_ROOT;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-cua-test-')); process.env.DATA_ROOT = root; });
afterEach(() => {
  process.env.DATA_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runtime Cua MCP', () => {
  it('spawns one child for concurrent warmups and reaps it on close', async () => {
    const { setRuntimeCuaConnection, CUA_SERVER_ID } = await import('../runtime-cua-config.js');
    const { mcpClientManager } = await import('../mcp-client-manager.js');
    const starts = path.join(root, 'starts.txt');
    setRuntimeCuaConnection({ generation: 'concurrent', command: process.execPath, args: [fixture], environment: [{ name: 'MCP_FIXTURE_START_LOG', value: starts }] });
    let pids: number[] = [];
    try {
      await Promise.all(Array.from({ length: 12 }, () =>
        mcpClientManager.warmup([CUA_SERVER_ID], 'project-concurrent', 'session-a')));
      pids = fs.readFileSync(starts, 'utf8').trim().split('\n').map(Number);
      expect(pids).toHaveLength(1);
      mcpClientManager.closeAll();
      await vi.waitFor(() => {
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      }, { timeout: 5_000 });
    } finally {
      mcpClientManager.closeAll();
      setRuntimeCuaConnection(null);
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already reaped */ }
      }
    }
  }, 20_000);

  it('preserves JSON schemas and structured results in isolated session clients', async () => {
    const { setRuntimeCuaConnection, CUA_SERVER_ID } = await import('../runtime-cua-config.js');
    const { mcpClientManager } = await import('../mcp-client-manager.js');
    setRuntimeCuaConnection({ generation: 'test-1', command: process.execPath, args: [fixture], environment: [] });
    try {
      await mcpClientManager.warmup([CUA_SERVER_ID], 'project-a', 'session-a');
      await mcpClientManager.warmup([CUA_SERVER_ID], 'project-a', 'session-b');
      expect(mcpClientManager.getCachedTools(CUA_SERVER_ID, 'project-a', 'session-a').find(t => t.name === 'danger')?.inputSchema).toMatchObject({ required: ['sideEffect'] });
      expect(mcpClientManager.getCachedTools(CUA_SERVER_ID, 'project-a', 'session-b').length).toBeGreaterThan(0);
      expect(mcpClientManager.getCachedTools(CUA_SERVER_ID, 'project-a', 'session-c')).toEqual([]);
      const result = await mcpClientManager.callTool(CUA_SERVER_ID, 'echo', { text: 'hello' }, 'project-a', 'session-a');
      expect(result.structuredContent).toMatchObject({ snapshot_id: 'fixture-snapshot' });
      const image = await mcpClientManager.callTool(CUA_SERVER_ID, 'screenshot', {}, 'project-a', 'session-a');
      expect(image.contentParts?.some(part => part.type === 'image')).toBe(true);
    } finally { mcpClientManager.closeAll(); setRuntimeCuaConnection(null); }
  }, 20_000);

  it('does not replay an action after the transport dies with unknown outcome', async () => {
    const { setRuntimeCuaConnection, CUA_SERVER_ID } = await import('../runtime-cua-config.js');
    const { mcpClientManager } = await import('../mcp-client-manager.js');
    const counter = path.join(root, 'actions.txt');
    setRuntimeCuaConnection({ generation: 'test-2', command: process.execPath, args: [fixture], environment: [{ name: 'MCP_FIXTURE_COUNTER', value: counter }] });
    try {
      await mcpClientManager.warmup([CUA_SERVER_ID], 'project-b', 'session-a');
      const result = await mcpClientManager.callTool(CUA_SERVER_ID, 'danger', { sideEffect: true }, 'project-b', 'session-a');
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('outcome unknown') });
      expect(fs.readFileSync(counter, 'utf8')).toBe('x');
    } finally { mcpClientManager.closeAll(); setRuntimeCuaConnection(null); }
  }, 20_000);
});
