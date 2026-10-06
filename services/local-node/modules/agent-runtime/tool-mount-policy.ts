import { CODE_TOOL_IDS, codeModeEnabled } from "./code-mode/policy.js";
import { NATIVE_PROTOCOL_IDS, nativeCapabilitiesEnabled } from "./native-capabilities/policy.js";
import { assertGitMrBinding } from './git/binding.js';
import { GIT_MANAGER_TOOL_IDS } from './git/constants.js';
import type { AgentProfile, AgentSession } from './contracts.js';
import { controlRoot, workflowMode } from './workflow-mode.js';
import { getStoredPlan } from './plan-execution.js';

/**
 * Decide whether a profile may see/execute a tool.
 *
 * Profiles keep their explicit `allowedCapabilities` list. A profile with
 * `mountAllTools` (the primary Synax agent) mounts every registered tool without
 * progressive disclosure.
 */
export function profileCanUseTool(profile: AgentProfile, tool: { id: string }): boolean {
  if (NATIVE_PROTOCOL_IDS.has(tool.id) && profile.id !== 'git-manager') return true;
  if (profile.allowedCapabilities.includes(tool.id)) return true;
  if (!profile.mountAllTools) return false;
  return true;
}

/** Shared model/discovery eligibility; does not replace execution checks. */
export function modelCanUseTool(profile: AgentProfile, tool: { id: string; category: string }): boolean {
  return profileCanUseTool(profile, tool) ||
    ["work.checkpoint", "context.read", "tools.invalid"].includes(tool.id) ||
    (tool.id === "verification.run" && profileCanUseTool(profile, { id: "bash" })) ||
    tool.category === "skill" || tool.category === "mcp";
}

/**
 * Some registered tools are workflow controls rather than general-purpose
 * capabilities. Keep them out of the mounted tool set unless the session is
 * explicitly in the workflow that owns them. This is deliberately separate
 * from `controlToolError`: a gated tool may be shown as unavailable, while an
 * unmounted tool must not be advertised to the model or capability UI at all.
 */
const PLAN_TOOLS = new Set([
  'agent.discover', 'agent.execute',
  'code.run', 'code.tools', 'context.read', 'file.read', 'file.list', 'rg', 'diff.read',
  'webSearch',
  'task.create', 'task.update', 'task.get', 'task.list', 'skill.load', 'agent.adapt',
  'subagent.delegate', 'human.ask', 'plan.propose', 'plan.execute', 'mode.switch',
  'work.checkpoint', 'goal.finish', 'tools.invalid',
  'design.read', 'design.write', 'design.preview', 'design.transition', 'design.implement',
]);
export function isPlanningReadTool(toolId: string): boolean {
  return PLAN_TOOLS.has(toolId);
}

export function isToolMountedForSession(session: AgentSession, tool: { id: string }): boolean {
  if (NATIVE_PROTOCOL_IDS.has(tool.id) && !nativeCapabilitiesEnabled(session)) return false;
  if (session.profileId === 'git-manager') {
    try { assertGitMrBinding(session.id); } catch { return false; }
    return (GIT_MANAGER_TOOL_IDS as readonly string[]).includes(tool.id);
  }
  const root = controlRoot(session);
  const mode = workflowMode(session);
  if (['work.checkpoint', 'goal.finish', 'verification.run'].includes(tool.id)) {
    return mode === 'goal';
  }
  // Planning is a base Chat capability; proposing a plan is safe because it
  // creates a read-only approval checkpoint rather than mutating the workspace.
  if (tool.id === 'plan.propose') return mode === 'chat' || mode === 'plan' || mode === 'goal';
  if (tool.id === 'plan.execute') {
    const plan = getStoredPlan(root.id);
    return mode === 'plan' || mode === 'goal' || (mode === 'chat' && plan?.status === 'saved');
  }
  if (mode === 'plan') return isPlanningReadTool(tool.id);
  return true;
}
