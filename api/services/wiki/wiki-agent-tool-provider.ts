import type { AgentProfile, RegisteredTool, SessionToolProvider } from '../agent-runtime/contracts.js';
import { profileService } from '../agent-runtime/profile-service.js';
import { agentRuntimeStore } from '../agent-runtime/session-store.js';
import { createWikiAgentTools } from './tools/agent-tools.js';

export const WIKI_AGENT_TOOL_PROVIDER_ID = 'wiki-agent-tools';

export const WIKI_AGENT_READ_TOOL_IDS = [
  'wiki.get_snapshot',
  'wiki.get_tree',
  'wiki.list_documents',
  'wiki.read_document',
  'wiki.read_section',
  'wiki.get_references',
  'wiki.search_content',
  'wiki.search_batch',
] as const;

export type WikiAgentReadToolId = (typeof WIKI_AGENT_READ_TOOL_IDS)[number];

export function profileHasWikiAgentReadTools(profile: AgentProfile): boolean {
  return profile.allowedCapabilities.some((cap) =>
    (WIKI_AGENT_READ_TOOL_IDS as readonly string[]).includes(cap),
  );
}

/**
 * Lazily supplies wiki read tools per project via SessionToolProvider
 * instead of registering them globally on the tool registry.
 */
class WikiAgentToolProvider implements SessionToolProvider {
  id = WIKI_AGENT_TOOL_PROVIDER_ID;
  private readonly projectTools = new Map<string, RegisteredTool[]>();

  getTools(sessionId: string): RegisteredTool[] {
    const session = agentRuntimeStore.tryGetSession(sessionId);
    if (!session?.projectId) return [];

    const profile = profileService.maybeGet(session.profileId);
    if (!profile || !profileHasWikiAgentReadTools(profile)) return [];

    let tools = this.projectTools.get(session.projectId);
    if (!tools) {
      tools = createWikiAgentTools();
      this.projectTools.set(session.projectId, tools);
    }
    return tools;
  }

  getHooks(_sessionId: string): [] {
    return [];
  }

  /** Test helper — clear cached tool instances for a project. */
  clearProjectTools(projectId: string): void {
    this.projectTools.delete(projectId);
  }

  resetForTests(): void {
    this.projectTools.clear();
  }
}

export const wikiAgentToolProvider = new WikiAgentToolProvider();
