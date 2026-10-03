import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('../../infrastructure/mcp/__tests__/fixtures/fake-mcp-server.mjs', import.meta.url));
const original = process.env.DATA_ROOT;
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-cua-exposure-')); process.env.DATA_ROOT = root; vi.resetModules(); });
afterEach(() => { process.env.DATA_ROOT = original; fs.rmSync(root, { recursive: true, force: true }); vi.resetModules(); });

it('Jev mode exposes observations but not actions until configured fallback actually activates', async () => {
  const { resetAgentRuntimeFixtures } = await import('../agent-runtime/__tests__/agent-runtime-fixtures.js');
  const { agentSessionRuntime } = await import('../agent-runtime/session-runtime.js');
  const { updateProjectSettings } = await import('../../infrastructure/runtime/config/project-settings-store.js');
  const { mcpSessionToolProvider, warmupMcpForSession } = await import('../../infrastructure/mcp/mcp-session-tool-provider.js');
  const { mcpClientManager } = await import('../../infrastructure/mcp/mcp-client-manager.js');
  const { setRuntimeCuaConnection } = await import('../../infrastructure/mcp/runtime-cua-config.js');
  const { enableDirectFallback } = await import('./fallback.js');
  resetAgentRuntimeFixtures();
  const session = agentSessionRuntime.create({ projectId: 'project-alpha', profileId: 'explorer', prompt: 'Observe a window.' });
  updateProjectSettings(session.projectId, { computerUse: { strategy: 'jev', jev: { enabled: true, fallback: 'direct' } } }, 'test');
  setRuntimeCuaConnection({ generation: 'test', command: process.execPath, args: [fixture], environment: [] });
  try {
    await warmupMcpForSession(session.id);
    const initial = mcpSessionToolProvider.getTools(session.id).map(tool => tool.id);
    expect(initial).toContain('mcp.builtin-cua-driver.list_windows');
    expect(initial).not.toContain('mcp.builtin-cua-driver.danger');
    enableDirectFallback(session.id);
    expect(mcpSessionToolProvider.getTools(session.id).map(tool => tool.id)).toContain('mcp.builtin-cua-driver.danger');
  } finally { mcpClientManager.closeAll(); setRuntimeCuaConnection(null); }
}, 20_000);

it('recovers observation tools on the next warm-up after a late connection or restart', async () => {
  const { resetAgentRuntimeFixtures } = await import('../agent-runtime/__tests__/agent-runtime-fixtures.js');
  const { agentSessionRuntime } = await import('../agent-runtime/session-runtime.js');
  const { updateProjectSettings } = await import('../../infrastructure/runtime/config/project-settings-store.js');
  const { mcpSessionToolProvider, warmupMcpForSession } = await import('../../infrastructure/mcp/mcp-session-tool-provider.js');
  const { mcpClientManager } = await import('../../infrastructure/mcp/mcp-client-manager.js');
  const { setRuntimeCuaConnection } = await import('../../infrastructure/mcp/runtime-cua-config.js');
  resetAgentRuntimeFixtures();
  const session = agentSessionRuntime.create({ projectId: 'project-alpha', profileId: 'explorer', prompt: 'Observe a window.' });
  updateProjectSettings(session.projectId, { computerUse: { strategy: 'jev', jev: { enabled: true, fallback: 'fail_closed' } } }, 'test');
  const ids = () => mcpSessionToolProvider.getTools(session.id).map(tool => tool.id);
  try {
    await warmupMcpForSession(session.id);
    expect(ids()).not.toContain('mcp.builtin-cua-driver.list_windows');
    for (const generation of ['late', 'restart']) {
      setRuntimeCuaConnection({ generation, command: process.execPath, args: [fixture], environment: [] });
      mcpClientManager.closeCua();
      await warmupMcpForSession(session.id);
      expect(ids()).toContain('mcp.builtin-cua-driver.list_windows');
      expect(ids()).not.toContain('mcp.builtin-cua-driver.danger');
      setRuntimeCuaConnection(null);
      mcpClientManager.closeCua();
      expect(ids()).not.toContain('mcp.builtin-cua-driver.list_windows');
    }
  } finally { mcpClientManager.closeAll(); setRuntimeCuaConnection(null); }
}, 20_000);


it('hides Cua and Jev tools when globally disabled and restores them when enabled', async () => {
  const { resetAgentRuntimeFixtures } = await import('../agent-runtime/__tests__/agent-runtime-fixtures.js');
  const { agentSessionRuntime } = await import('../agent-runtime/session-runtime.js');
  const { updateGlobalConfig } = await import('../../infrastructure/runtime/config/config-store.js');
  const { updateProjectSettings } = await import('../../infrastructure/runtime/config/project-settings-store.js');
  const { mcpSessionToolProvider, warmupMcpForSession } = await import('../../infrastructure/mcp/mcp-session-tool-provider.js');
  const { jevSessionToolProvider } = await import('./jev-tool-provider.js');
  const { mcpClientManager } = await import('../../infrastructure/mcp/mcp-client-manager.js');
  const { setRuntimeCuaConnection } = await import('../../infrastructure/mcp/runtime-cua-config.js');
  resetAgentRuntimeFixtures();
  const session = agentSessionRuntime.create({ projectId: 'project-alpha', profileId: 'explorer', prompt: 'Observe a window.' });
  updateGlobalConfig({ computerUse: { enabled: true, strategy: 'jev', jev: { enabled: true, fallback: 'fail_closed' } } }, 'test');
  setRuntimeCuaConnection({ generation: 'toggle', command: process.execPath, args: [fixture], environment: [] });
  const ids = () => [...mcpSessionToolProvider.getTools(session.id), ...jevSessionToolProvider.getTools(session.id)].map(tool => tool.id);
  try {
    await warmupMcpForSession(session.id);
    expect(ids()).toEqual(expect.arrayContaining(['mcp.builtin-cua-driver.list_windows', 'computer.use']));
    updateGlobalConfig({ computerUse: { enabled: false } }, 'test');
    expect(ids()).toEqual([]);
    updateGlobalConfig({ computerUse: { enabled: true } }, 'test');
    await warmupMcpForSession(session.id);
    expect(ids()).toEqual(expect.arrayContaining(['mcp.builtin-cua-driver.list_windows', 'computer.use']));
    updateProjectSettings(session.projectId, { computerUse: { enabled: false } }, 'test');
    expect(ids()).toEqual([]);
  } finally { mcpClientManager.closeAll(); setRuntimeCuaConnection(null); }
}, 20_000);
