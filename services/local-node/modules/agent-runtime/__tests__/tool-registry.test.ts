import { beforeEach, describe, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { toolRegistry } from '../tool-registry.js';
import { executorInput, explorerSessionInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('toolRegistry', () => {
  beforeEach(async () => { await resetAgentRuntimeFixtures(); });

  it('registers progressively described core tools', () => {
    const tools = toolRegistry.list();
    expect(tools.map((tool) => tool.id)).toEqual(expect.arrayContaining(['file.list', 'file.read', 'rg']));
    expect(tools.some((tool) => ['file.glob', 'grep.search'].includes(tool.id))).toBe(false);
    for (const id of ['file.read', 'file.list', 'rg', 'bash', 'file.write', 'file.patch']) {
      const tool = tools.find((candidate) => candidate.id === id);
      expect(typeof tool?.progressiveDetails).toBe('string');
    }
  });

  it('executes allowed read tools and records calls', async () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const call = await toolRegistry.execute(session.id, 'rg', { mode: 'files', pattern: 'package.json', limit: 5 });

    expect(['completed', 'compacted']).toContain(call.record.status);
    expect(agentRuntimeStore.listToolCalls(session.id)).toHaveLength(1);
  });

  it('accepts oversized read budgets through the real registry entry point', async () => {
    const session = agentSessionRuntime.create(executorInput);
    const call = await toolRegistry.execute(session.id, 'file.read', { path: 'package.json', maxBytes: 100_000 });
    expect(call.record.status, call.record.error ?? '').toBe('completed');
    expect(call.record.outputRef).toMatchObject({ effectiveMaxBytes: 64_000 });
    expect(call.record.inputRef).toMatchObject({ maxBytes: 100_000 });
    expect(call.record.error).toBeNull();
  });

  it('returns a recoverable parameter diagnostic, without executing or replaying the tool', async () => {
    const session = agentSessionRuntime.create(executorInput);
    const call = await toolRegistry.execute(session.id, 'file.read', { path: 'package.json', maxBytes: -1 });
    expect(call.record.status).toBe('failed');
    expect(call.record.error).toContain('Tool input rejected for file.read');
    expect(call.record.error).toContain('maxBytes');
    expect(call.record.error).toContain('too_small');
    expect(call.record.error).toContain('received -1');
    expect(call.record.outputRef).toBeNull();
    expect(agentRuntimeStore.listToolCalls(session.id)).toHaveLength(1);
  });

  it.each([
    ['rg', { query: 'completedAt:', path: '__missing_read_probe__/agent-session', limit: 30, contextLines: 3 }],
    ['rg', { mode: 'files', pattern: '*.ts', path: '__missing_read_probe__' }],
    ['file.list', { path: '__missing_read_probe__' }],
    ['file.read', { path: '__missing_read_probe__/session.ts' }],
  ])('records a %s path miss without emitting a tool failure', async (toolId, args) => {
    const session = agentSessionRuntime.create(toolId === 'file.read' ? executorInput : explorerSessionInput);
    const call = await toolRegistry.execute(session.id, toolId, args);
    expect(call.record.status, call.record.error ?? '').toBe('completed');
    expect(call.record.error).toBeNull();
    expect(call.record.outputRef).toMatchObject({
      status: 'not_found', code: 'READ_PATH_NOT_FOUND', recoverable: true,
    });
    expect(agentRuntimeStore.listToolCalls(session.id)).toHaveLength(1);
  });
});
