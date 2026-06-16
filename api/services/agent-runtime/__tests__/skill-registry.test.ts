import { beforeEach, describe, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { skillRegistry } from '../skill-registry.js';
import { plannerSessionInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

describe('skillRegistry', () => {
  beforeEach(resetAgentRuntimeFixtures);

  it('returns empty list for unknown profile ids', () => {
    expect(skillRegistry.listSummaries({ profileId: 'plan-generator' })).toEqual([]);
  });

  it('discloses summaries without full skill content', () => {
    const skills = skillRegistry.listSummaries({ profileId: 'planner' });

    expect(skills.some((skill) => skill.id === 'coord-planner')).toBe(true);
    expect(skills[0]).not.toHaveProperty('content');
  });

  it('loads full content only through the gated runtime path', () => {
    const session = agentSessionRuntime.create(plannerSessionInput);
    const skill = skillRegistry.loadFull({ sessionId: session.id, skillId: 'coord-planner', profileKind: 'planner' });

    expect(skill.content).toContain('CoordForest');
  });
});
