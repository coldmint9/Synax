import type { AgentProfile, RegisteredTool } from './contracts.js';
import { profileService } from './profile-service.js';
import { agentSessionRuntime } from './session-runtime.js';
import { skillAgentBridge, resolveActiveSkillSummaries } from '../skills/index.js';
import { toolRegistry } from './tool-registry.js';
import type { SkillSummary } from '../skills/types.js';

export type ToolSummary = Omit<RegisteredTool, 'execute'>;

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

export function resolveSessionCapabilities(sessionId: string): SessionCapabilities {
  const session = agentSessionRuntime.get(sessionId);
  const profile = profileService.get(session.profileId);
  const available = filterAvailableTools(toolRegistry.listForSession(sessionId), profile);

  return {
    profile: { id: profile.id, label: profile.label, kind: profile.kind },
    tools: { available, visible: available },
    skills: {
      active: resolveActiveSkillSummaries(session.skillIds, session.projectId),
      candidates: skillAgentBridge.listForPrompt({
        profileId: profile.id,
        projectId: session.projectId,
        activeSkillIds: session.skillIds,
      }),
    },
  };
}
