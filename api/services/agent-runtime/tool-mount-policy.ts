import type { AgentProfile, AgentSession } from './contracts.js';
import { WIKI_AGENT_READ_TOOL_IDS } from '../wiki/wiki-agent-tool-provider.js';
import { controlRoot, workflowMode } from './workflow-mode.js';

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

/**
 * Some registered tools are workflow controls rather than general-purpose
 * capabilities. Keep them out of the mounted tool set unless the session is
 * explicitly in the workflow that owns them. This is deliberately separate
 * from `controlToolError`: a gated tool may be shown as unavailable, while an
 * unmounted tool must not be advertised to the model or capability UI at all.
 */
const PLAN_TOOLS = new Set([
  'context.read', 'file.read', 'file.list', 'file.glob', 'grep.search', 'diff.read',
  ...WIKI_AGENT_READ_TOOL_IDS,
  'task.create', 'task.update', 'task.get', 'task.list', 'skill.load', 'agent.adapt',
  'subagent.delegate', 'human.ask', 'plan.propose', 'plan.execute', 'mode.switch',
  'work.checkpoint', 'goal.finish', 'tools.invalid',
]);
export function isPlanningReadTool(toolId: string): boolean {
  return PLAN_TOOLS.has(toolId);
}

export function isToolMountedForSession(session: AgentSession, tool: { id: string }): boolean {
  const root = controlRoot(session);
  const mode = workflowMode(session);
  if (['work.checkpoint', 'goal.finish', 'verification.run'].includes(tool.id)) {
    return mode === 'goal';
  }
  if (tool.id === 'plan.propose') return mode === 'plan' || mode === 'goal';
  if (tool.id === 'plan.execute') {
    const plan = root.sessionMetadata?.plan as { status?: string } | undefined;
    return mode === 'plan' || mode === 'goal' || (mode === 'chat' && plan?.status === 'saved');
  }
  if (mode === 'plan') return isPlanningReadTool(tool.id);
  return true;
}
