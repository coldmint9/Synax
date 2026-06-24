import { beforeEach, describe, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { toolRegistry } from '../tool-registry.js';
import { explorerSessionInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('toolRegistry', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('registers progressively described core tools', () => {
    const tools = toolRegistry.list();
    expect(tools.map((tool) => tool.id)).toEqual(expect.arrayContaining(['file.list', 'file.read', 'grep.search']));
    for (const id of ['file.read', 'file.list', 'grep.search', 'bash', 'file.write', 'edit']) {
      const tool = tools.find((candidate) => candidate.id === id);
      expect(typeof tool?.progressiveDetails).toBe('string');
    }
  });

  it('executes allowed read tools and records calls', async () => {
    const session = agentSessionRuntime.create(explorerSessionInput);
    const call = await toolRegistry.execute(session.id, 'file.glob', { pattern: 'package.json', limit: 5 });

    expect(['completed', 'compacted']).toContain(call.record.status);
    expect(agentRuntimeStore.listToolCalls(session.id)).toHaveLength(1);
  });
});
