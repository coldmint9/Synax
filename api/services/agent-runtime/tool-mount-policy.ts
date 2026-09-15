import type { AgentProfile } from './contracts.js';
import { WIKI_AGENT_READ_TOOL_IDS } from '../wiki/wiki-agent-tool-provider.js';

const WIKI_AGENT_READ_TOOLS = new Set<string>(WIKI_AGENT_READ_TOOL_IDS);

/**
 * WIKI.md generation tools (`wiki.submit_outline`, `wiki.commit_document`, …) are
 * registered globally only while a wiki job runs, so they must never be mounted
 * just because a profile mounts all tools. The wiki read tools reach a session
 * exclusively through the wiki session provider, which supplies them only after a
 * wiki has been generated for the project.
 */
function isWikiReadTool(toolId: string): boolean {
  return WIKI_AGENT_READ_TOOLS.has(toolId);
}

/**
 * Decide whether a profile may see/execute a tool.
 *
 * Profiles keep their explicit `allowedCapabilities` list. A profile with
 * `mountAllTools` (the primary Synax agent) mounts every registered tool without
 * progressive disclosure, except the transient wiki generation tools above.
 */
export function profileCanUseTool(profile: AgentProfile, tool: { id: string }): boolean {
  if (profile.allowedCapabilities.includes(tool.id)) return true;
  if (!profile.mountAllTools) return false;
  if (tool.id.startsWith('wiki.')) return isWikiReadTool(tool.id);
  return true;
}
