import type { AgentProfile, AgentSkill, RegisteredTool } from './contracts.js';
import { profileService } from './profile-service.js';
import { agentSessionRuntime } from './session-runtime.js';
import { agentRuntimeStore } from './session-store.js';
import { skillRegistry } from './skill-registry.js';
import { toolRegistry } from './tool-registry.js';
import {
  filterByDisclosure,
  filterFallbackTools,
  getStrategyForProfile,
  rebuildFallbackState,
  rebuildState as rebuildDisclosureState,
} from './tool-disclosure.js';

export type ToolSummary = Omit<RegisteredTool, 'execute'>;
type SkillSummary = Omit<AgentSkill, 'content'>;

export interface SessionCapabilities {
  profile: { id: string; label: string; kind: string };
  tools: {
    available: ToolSummary[];
    visible: ToolSummary[];
  };
  skills: {
    active: SkillSummary[];
    candidates: SkillSummary[];
  };
}

function filterAvailableTools(tools: ToolSummary[], profile: AgentProfile): ToolSummary[] {
  return tools.filter(
    (tool) =>
      profile.allowedCapabilities.includes(tool.id) ||
      tool.category === 'skill' ||
      tool.id === 'tools.invalid',
  );
}

function resolveActiveSkills(skillIds: string[]): SkillSummary[] {
  return skillIds.map((skillId) => {
    try {
      return skillRegistry.getSummary(skillId);
    } catch {
      return {
        id: skillId,
        label: skillId,
        description: '',
        source: 'system',
        version: '',
        appliesTo: [],
        requiredCapabilities: [],
        permissionHints: [],
        contentRef: '',
        status: 'unavailable',
      };
    }
  });
}

export function resolveSessionCapabilities(sessionId: string): SessionCapabilities {
  const session = agentSessionRuntime.get(sessionId);
  const profile = profileService.get(session.profileId);
  const available = filterAvailableTools(toolRegistry.listForSession(sessionId), profile);

  const disclosureStrategy = getStrategyForProfile(profile.kind);
  const toolCalls = agentRuntimeStore.listToolCalls(sessionId);

  let visible = available;
  if (disclosureStrategy) {
    const disclosureState = rebuildDisclosureState(toolCalls, disclosureStrategy.escalationToolId);
    visible = filterByDisclosure(available, disclosureState, disclosureStrategy);
  }
  if (profile.fallbackDisclosure) {
    const fallbackState = rebuildFallbackState(toolCalls, profile.fallbackDisclosure);
    visible = filterFallbackTools(visible, fallbackState, profile.fallbackDisclosure);
  }

  return {
    profile: { id: profile.id, label: profile.label, kind: profile.kind },
    tools: { available, visible },
    skills: {
      active: resolveActiveSkills(session.skillIds),
      candidates: skillRegistry.listSummaries({ profileId: profile.id }),
    },
  };
}
