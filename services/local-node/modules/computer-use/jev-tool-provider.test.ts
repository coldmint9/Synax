import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolExecutionInput } from '../agent-runtime/contracts.js';
const fixture = fileURLToPath(new URL('../../infrastructure/mcp/__tests__/fixtures/fake-mcp-server.mjs', import.meta.url));
const saved = { root: process.env.DATA_ROOT, mock: process.env.SYNAX_JEV_MOCK, key: process.env.TYPESAFE_API_KEY };
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-jev-tool-'));
  process.env.DATA_ROOT = root; process.env.SYNAX_JEV_MOCK = '1'; delete process.env.TYPESAFE_API_KEY;
  vi.resetModules();
});
afterEach(() => {
  process.env.DATA_ROOT = saved.root; process.env.SYNAX_JEV_MOCK = saved.mock; process.env.TYPESAFE_API_KEY = saved.key;
  fs.rmSync(root, { recursive: true, force: true }); vi.resetModules();
});

it('reports degraded CUA observations instead of hiding them as abstain', async () => {
  const { describeCuaObservationFailure } = await import('./jev-tool-provider.js');
  expect(describeCuaObservationFailure({ degraded: true, reason: 'ax_window_unresolved' }))
    .toContain('ax_window_unresolved');
  expect(describeCuaObservationFailure({ degraded: false, elements: [] })).toBeNull();
});

it('mock Jev runs one immutable action without API credentials and reobserves', async () => {
  const { resetAgentRuntimeFixtures } = await import('../agent-runtime/__tests__/agent-runtime-fixtures.js');
  const { agentSessionRuntime } = await import('../agent-runtime/session-runtime.js');
  const { updateProjectSettings } = await import('../../infrastructure/runtime/config/project-settings-store.js');
  const { jevSessionToolProvider } = await import('./jev-tool-provider.js');
  const { mcpClientManager } = await import('../../infrastructure/mcp/mcp-client-manager.js');
  const { setRuntimeCuaConnection } = await import('../../infrastructure/mcp/runtime-cua-config.js');
  resetAgentRuntimeFixtures();
  const session = agentSessionRuntime.create({ projectId: 'project-alpha', profileId: 'explorer', prompt: 'Press OK.' });
  updateProjectSettings(session.projectId, { computerUse: { strategy: 'jev', jev: { enabled: true, fallback: 'fail_closed' } } }, 'test');
  setRuntimeCuaConnection({ generation: 'test', command: process.execPath, args: [fixture], environment: [] });
  try {
    const tool = jevSessionToolProvider.getTools(session.id)[0];
    expect(tool?.id).toBe('computer.use');
    const result = await tool.execute({ sessionId: session.id, toolId: 'computer.use', args: { goal: 'Press OK', pid: 42, windowId: 123 } } as ToolExecutionInput);
    expect(result.result).toMatchObject({ acted: true, selected: 'click_1', verification: 'fresh_observation' });
  } finally { mcpClientManager.closeAll(); setRuntimeCuaConnection(null); }
}, 20_000);
