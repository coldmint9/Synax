import { describe, expect, it } from 'vitest';
import { skillRegistry } from '../skill-registry.js';
import { skillAgentBridge } from '../agent-bridge.js';
import { agentSessionRuntime } from '../../agent-runtime/session-runtime.js';
import { resetAgentRuntimeFixtures, explorerSessionInput } from '../../agent-runtime/__tests__/agent-runtime-fixtures.js';

describe('skillRegistry', () => {
  it('lists builtin skills for explorer profile', () => {
    const skills = skillRegistry.listSummaries({ profileId: 'explorer', projectId: 'project-alpha' });
    expect(skills.some((skill) => skill.id === 'synax-builtin/synax-explore')).toBe(true);
    expect(skills.some((skill) => skill.id === 'synax-builtin/code-review')).toBe(false);
  });

  it('loads skill content through the agent bridge', () => {
    resetAgentRuntimeFixtures();
    const session = agentSessionRuntime.create(explorerSessionInput);
    const skill = skillAgentBridge.loadForTool({
      sessionId: session.id,
      skillId: 'synax-builtin/synax-explore',
      profileKind: 'explorer',
    });

    expect(skill.content).toContain('Investigate architecture');
  });
});
