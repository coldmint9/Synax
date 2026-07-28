import type { AgentProfileKind } from '../agent-runtime/contracts.js';
import { permissionPolicy } from '../agent-runtime/permission-policy.js';
import { AgentPermissionError } from '../agent-runtime/runtime-errors.js';
import { agentSessionRuntime } from '../agent-runtime/session-runtime.js';
import { skillRegistry } from './skill-registry.js';
import type { SkillDetail, SkillSummary } from './types.js';

export const skillAgentBridge = {
  listForPrompt(input: {
    profileId: string;
    projectId: string;
    activeSkillIds: string[];
  }): SkillSummary[] {
    return skillRegistry
      .listSummaries({
        profileId: input.profileId,
        projectId: input.projectId,
      })
      .filter((skill) => skill.injection !== 'deterministic');
  },

  loadForTool(input: {
    sessionId: string;
    skillId: string;
    profileKind: AgentProfileKind;
  }): SkillDetail {
    const session = agentSessionRuntime.get(input.sessionId);
    const summary = skillRegistry.getSummary(input.skillId, session.projectId);
    if (summary.appliesTo.length > 0 && !summary.appliesTo.includes(input.profileKind)) {
      throw new AgentPermissionError(`Skill ${summary.id} does not apply to ${input.profileKind}.`);
    }

    const decision = permissionPolicy.evaluate({
      sessionId: input.sessionId,
      category: 'skill',
      internalGate: 'skill',
      pattern: input.skillId,
    });
    if (decision.action === 'deny') throw new AgentPermissionError(decision.reason);
    if (decision.action === 'ask') throw new AgentPermissionError('Skill content requires permission.', 409);

    return skillRegistry.loadDetail({ skillId: input.skillId, projectId: session.projectId });
  },
};

export function getSkillRegistry() {
  return skillRegistry;
}
