import type { AgentProfile, RegisteredTool } from './contracts.js';
import { profileService } from './profile-service.js';
import { agentSessionRuntime } from './session-runtime.js';
import { skillAgentBridge, resolveActiveSkillSummaries } from '../skills/index.js';
import { toolRegistry } from './tool-registry.js';
import { getProjectSettings } from '../../lib/config/project-settings-store.js';
import type { SkillSummary } from '../skills/types.js';

export type ToolSummary = Omit<RegisteredTool, 'execute'>;

/** An MCP server this session actually mounted, with its resolved tool count. */
export interface SessionMcpServerSummary {
  id: string;
  name: string;
  enabled: boolean;
  toolCount: number;
}

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
  mcp: {
    servers: SessionMcpServerSummary[];
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

/**
 * MCP is mounted per session (`session.mcpServerIds`) but configured per
 * project, so the name has to come from project settings while the tool count
 * comes from the registered tools (`mcp.<serverId>.<tool>`).
 */
function resolveMcpServers(
  session: { projectId: string; mcpServerIds?: string[] },
  tools: ToolSummary[],
): SessionMcpServerSummary[] {
  const mounted = new Set(session.mcpServerIds ?? []);
  if (mounted.size === 0) return [];

  let configured: Array<{ id: string; name?: string; enabled?: boolean }> = [];
  try {
    configured = getProjectSettings(session.projectId, true).mcpServers ?? [];
  } catch {
    // Project settings may not exist yet; fall back to the raw ids below.
  }

  const describe = (id: string, name?: string, enabled = true): SessionMcpServerSummary => ({
    id,
    name: name?.trim() || id,
    enabled,
    toolCount: tools.filter((tool) => tool.category === 'mcp' && tool.id.startsWith(`mcp.${id}.`)).length,
  });

  const known = new Map(configured.map((server) => [server.id, server]));
  const servers: SessionMcpServerSummary[] = [];
  for (const id of mounted) {
    const config = known.get(id);
    servers.push(describe(id, config?.name, config?.enabled !== false));
  }
  return servers;
}

export function resolveSessionCapabilities(sessionId: string): SessionCapabilities {
  const session = agentSessionRuntime.get(sessionId);
  const profile = profileService.getForSession(session);
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
    mcp: { servers: resolveMcpServers(session, available) },
  };
}
