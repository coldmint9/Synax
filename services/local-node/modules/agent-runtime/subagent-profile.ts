import fs from "node:fs";
import path from "node:path";
import type { AgentProfile, AgentSession, CreateSessionRequest, PermissionRule, RegisteredTool } from "./contracts.js";
import { subagentProfileSchema, type SubagentProfileConfig } from "./subagent-config.js";
import { AgentPermissionError, AgentValidationError } from "./runtime-errors.js";
import { agentRuntimeStore } from "./session-store.js";
import { resolveSessionWorkDir, resolveWorkspacePath, setSessionWorkspaceRoot } from "./tools/workspace.js";
import { parseApplyPatchEnvelope } from "./tools/patch-format.js";
import { permissionPolicy, resolvePermissionDecision, type PermissionRequestInput } from "./permission-policy.js";
import { profileCanUseTool } from "./tool-mount-policy.js";
import { activeTurnReferences, effectiveTurnMcpIds } from "./turn-reference-state.js";

export const SUBAGENT_PROFILE_ID = "subagent";
const controls = new Set(["human.ask", "plan.propose", "plan.execute", "mode.switch", "goal.finish", "work.checkpoint", "agent.adapt"]);
const wrappers = new Set(["agent.discover", "agent.execute", "code.run", "code.tools", "code.result", "tools.invalid"]);
const files = new Set(["file.write", "file.patch", "file.delete"]);
export const isSubagentControl = (id: string) => id.startsWith("subagent.") || controls.has(id);

interface Snapshot {
  version: 1;
  parentSessionId: string;
  workspaceRoot: string;
  profile: SubagentProfileConfig;
  capabilities: string[];
  templateId?: string;
}

export const subagentBaseProfile: AgentProfile = {
  id: SUBAGENT_PROFILE_ID, label: "Subagent", kind: "executor", mode: "subagent",
  description: "A general-purpose subagent configured and authorized by its parent for one task.",
  defaultThinkingMode: "standard", allowedCapabilities: [], permissionDefaults: [], maxSteps: 32,
  status: "active", allowsSubsessions: false,
  toolPolicy: { allowSubtasks: false, allowParallelReadTools: true, maxParallelReadTools: 4 },
};

function snapshot(session: AgentSession): Snapshot | undefined {
  if (session.profileId !== SUBAGENT_PROFILE_ID) return undefined;
  const value = session.sessionMetadata?.subagentProfile as Snapshot | undefined;
  if (!value || value.version !== 1 || value.parentSessionId !== session.parentSessionId || !session.parentSessionId ||
      !Array.isArray(value.capabilities) || !path.isAbsolute(value.workspaceRoot))
    throw new AgentPermissionError("Subagent requires a valid parent configuration snapshot.");
  return value;
}

export function subagentRestrictions(config: SubagentProfileConfig): PermissionRule[] {
  return [
    { gate: "task", pattern: "*", action: "deny", reason: "Subagents return delegation decisions to the primary agent." },
    ...(config.access === "read-only" ? (["write", "delete", "shell", "mcp", "external_execution"] as const)
      .map(gate => ({ gate, pattern: "*", action: "deny" as const, reason: "This subagent is configured as read-only." })) : []),
  ];
}

export function resolveSubagentProfile(base: AgentProfile, session: AgentSession): AgentProfile {
  const saved = snapshot(session);
  if (!saved) return base;
  return { ...subagentBaseProfile, label: saved.profile.name ?? "Subagent",
    description: saved.profile.description ?? base.description, allowedCapabilities: saved.capabilities,
    defaultThinkingMode: session.thinkingMode, loopHints: [
      "Complete the delegated task and report the result to the parent. Do not delegate or change the parent's workflow. Other agents share this checkout: respect assigned file ownership and preserve their edits.",
      saved.profile.instructions ?? "Choose an effective approach for the assigned task.",
      ...(saved.profile.writeScope ? [`Native file writes are limited to: ${saved.profile.writeScope.join(", ")}.`] : []),
      ...(saved.profile.access === "read-only" ? ["Read-only assignment: do not modify the workspace."] : []),
    ] };
}

const contains = (root: string, target: string) => target === root || target.startsWith(root + path.sep);

export function buildSubagentChildInput(parent: AgentSession, config: SubagentProfileConfig,
  prompt: string, parentProfile: AgentProfile, tools: Array<Omit<RegisteredTool, "execute">>, templateId?: string,
): CreateSessionRequest {
  if (parent.parentSessionId || parentProfile.mode === "subagent" || parentProfile.toolPolicy?.allowSubtasks === false)
    throw new AgentPermissionError("Only the primary agent can delegate.");
  if (["stopping", "paused", "interrupted", "cancelled", "failed"].includes(parent.status) || parent.sessionMetadata?.runtimeControl)
    throw new AgentValidationError("A stopped primary session cannot delegate.");
  const profile = subagentProfileSchema.parse(config);
  const root = fs.realpathSync(resolveSessionWorkDir(parent.id, parent.projectId));
  const available = tools.filter(tool => !isSubagentControl(tool.id) &&
    (profileCanUseTool(parentProfile, tool) || tool.category === "mcp" || tool.category === "skill") &&
    (profile.access !== "read-only" || (tool.mutability !== "write" && !["shell", "mcp", "external_execution"].includes(tool.category))) &&
    (!profile.writeScope || files.has(tool.id) || wrappers.has(tool.id) ||
      (tool.mutability !== "write" && !["shell", "mcp", "external_execution"].includes(tool.category))));
  const allowed = new Set(available.map(tool => tool.id));
  for (const id of profile.capabilities ?? [])
    if (!allowed.has(id)) throw new AgentPermissionError(`Capability ${id} is unavailable to this subagent or its parent.`);
  const capabilities = profile.capabilities ? [...new Set([...profile.capabilities, ...wrappers].filter(id => allowed.has(id)))] : [...allowed];
  const inheritedSkills = [...new Set([...parent.skillIds, ...(activeTurnReferences(parent.id)?.skillIds ?? [])])];
  const inheritedMcp = effectiveTurnMcpIds(parent.id);
  for (const [requested, inherited, label] of [[profile.skillIds, inheritedSkills, "Skill"], [profile.mcpServerIds, inheritedMcp, "MCP server"]] as const)
    for (const id of requested ?? []) if (!inherited.includes(id)) throw new AgentPermissionError(`${label} ${id} is not assigned to the parent.`);
  // Validate declared roots now; every write resolves again at execution time.
  for (const scope of profile.writeScope ?? [])
    if (!contains(root, resolveWorkspacePath(scope, parent.id))) throw new AgentPermissionError("writeScope must stay within the workspace.");
  const model = profile.model ?? (parent.activeRunId ? agentRuntimeStore.getRun(parent.activeRunId).model : null) ??
    (parent.sessionMetadata?.backend as { model?: string } | undefined)?.model;
  const saved: Snapshot = { version: 1, parentSessionId: parent.id, workspaceRoot: root, profile, capabilities, templateId };
  return {
    projectId: parent.projectId, nodeId: parent.nodeId, parentSessionId: parent.id, profileId: SUBAGENT_PROFILE_ID,
    backendId: "native", model: model ?? undefined, prompt, workDir: root,
    thinkingMode: profile.thinkingMode ?? parent.thinkingMode, reasoningEffort: parent.reasoningEffort ?? undefined,
    skillIds: profile.skillIds ?? inheritedSkills, mcpServerIds: profile.mcpServerIds ?? inheritedMcp,
    permissionTier: parent.sessionMetadata?.permissionTier as CreateSessionRequest["permissionTier"],
    sessionMetadata: { mode: parent.sessionMetadata?.mode ?? "chat", subagentProfile: saved,
      subagentName: profile.name ?? "Subagent", roleName: profile.description ?? "General-purpose subagent",
      roleDescription: profile.instructions ?? prompt, workspaceRoot: root },
  };
}

export function assertSubagentToolAllowed(session: AgentSession, tool: RegisteredTool, args: unknown): void {
  const saved = snapshot(session);
  if (!saved) return;
  const parent = agentRuntimeStore.getSession(saved.parentSessionId);
  if (!saved.capabilities.includes(tool.id) || isSubagentControl(tool.id))
    throw new AgentPermissionError(`Tool ${tool.id} is outside this subagent's configuration.`);
  setSessionWorkspaceRoot(session.id, saved.workspaceRoot);
  const permissionInput: PermissionRequestInput = { sessionId: parent.id, category: tool.category, internalGate: tool.internalGate,
    pattern: tool.getPattern?.(args) ?? tool.id, rules: parent.permissionRules,
    metadata: { toolId: tool.id, args, mutability: tool.mutability } };
  const decision = (tool.id === "bash" || tool.id === "verification.run") && typeof (args as { command?: unknown })?.command === "string"
    ? permissionPolicy.resolveShellCommand({ ...permissionInput, command: (args as { command: string }).command })
    : resolvePermissionDecision(permissionInput);
  if (decision.action !== "allow") throw new AgentPermissionError("Parent permissions no longer authorize this operation. Return the blocker to the primary agent.");
  if (tool.id === "skill.load" && (!session.skillIds.includes((args as { skillId: string }).skillId) ||
      ![...parent.skillIds, ...(activeTurnReferences(parent.id)?.skillIds ?? [])].includes((args as { skillId: string }).skillId)))
    throw new AgentPermissionError("Skill is outside the subagent assignment.");
  if (!saved.profile.writeScope || !files.has(tool.id)) return;
  const paths = tool.id === "file.patch"
    ? parseApplyPatchEnvelope((args as { patch: string }).patch).flatMap(hunk => [hunk.path, ...("movePath" in hunk && hunk.movePath ? [hunk.movePath] : [])])
    : [(args as { path: string }).path];
  for (const file of paths) {
    const target = resolveWorkspacePath(file, session.id);
    if (!saved.profile.writeScope.some(scope => contains(path.resolve(saved.workspaceRoot, scope), target)))
      throw new AgentPermissionError(`File ${file} is outside the subagent writeScope.`);
  }
}
