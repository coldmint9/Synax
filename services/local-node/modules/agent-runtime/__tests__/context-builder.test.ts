import { beforeEach, describe, expect, it } from 'vitest';
import { agentContextBuilder } from '../context-builder.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('agentContextBuilder', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('builds context blocks with warnings and citations', () => {
    const bundle = agentContextBuilder.build('project-alpha', {
      nodeId: 'node-1',
      profileId: 'explorer',
      include: ['coord', 'memory', 'graph', 'review'],
    });

    expect(bundle.profileId).toBe('explorer');
    expect(bundle.blocks.map((block) => block.kind)).toEqual(expect.arrayContaining(['goal', 'memory', 'code', 'review']));
    expect(bundle.citations[0].nodeId).toBe('node-1');
  });
});
