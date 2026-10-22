import * as z from "zod/v4";
import type { ToolExecutionInput, ToolExecutionResult } from "./contracts.js";
import { contentPartsSchema, type RuntimeContentPart } from "./content-parts.js";
import { subagentStartFields, type SubagentProfileConfig } from "./subagent-config.js";
import { subagentTemplates } from "./subagent-templates.js";
import { activeTurnReferences } from "./turn-reference-state.js";
import { buildSubagentChildInput } from "./subagent-profile.js";
import { agentRuntimeStore } from "./session-store.js";
import { agentSessionRuntime } from "./session-runtime.js";
import { profileService } from "./profile-service.js";
import { AgentPermissionError, AgentValidationError } from "./runtime-errors.js";
import { bindAssets, sessionHasAsset, validateAssets } from "./media-assets.js";
import { runChildToCompletion, type SubagentSpec } from "./subagent-orchestrator.js";

export const delegateArgsSchema = z.object({ ...subagentStartFields, contentParts: contentPartsSchema.optional() }).strict();
export type DelegateArgs = z.infer<typeof delegateArgsSchema>;

function resolveConfig(parentId: string, args: DelegateArgs): { profile: SubagentProfileConfig; templateId?: string } {
  const selected = activeTurnReferences(parentId)?.subagentProfiles ?? [];
  if (selected.length && args.templateId && !selected.some(item => item.id === args.templateId))
    throw new AgentValidationError("Use one of the user-selected subagent templateId values for this turn.");
  if (!args.templateId && selected.length > 1)
    throw new AgentValidationError("Choose templateId from the user-selected subagents for this task.");
  const template = args.templateId
    ? selected.find(item => item.id === args.templateId) ?? subagentTemplates.get(args.templateId)
    : selected[0];
  if (template?.enabled === false) throw new AgentValidationError("This custom subagent is disabled.");
  const { id: _id, createdAt: _created, updatedAt: _updated, enabled: _enabled, ...base } = template ?? {};
  const requested = args.profile ?? {};
  if (base.access === "read-only" && requested.access === "inherit")
    throw new AgentPermissionError("A custom read-only subagent cannot be expanded to write access.");
  for (const key of ["capabilities", "skillIds", "mcpServerIds"] as const)
    if (base[key] && requested[key]?.some(id => !base[key]!.includes(id)))
      throw new AgentPermissionError(`Custom subagent ${key} cannot be expanded by delegation.`);
  if (base.writeScope && requested.writeScope?.some(scope => !base.writeScope!.some(allowed => scope === allowed || scope.startsWith(allowed.replace(/\/$/, "") + "/"))))
    throw new AgentPermissionError("Custom subagent writeScope cannot be expanded by delegation.");
  return { templateId: template?.id, profile: { ...base, ...requested,
    name: args.name ?? base.name ?? requested.name ?? "Subagent",
    description: base.description ?? requested.description ?? "Complete the assigned task",
    instructions: [base.instructions, requested.instructions].filter(Boolean).join("\n\n") || "Complete the assigned task and report the result.",
  } };
}

export async function createConfiguredSubagent(input: ToolExecutionInput, raw: DelegateArgs) {
  // Resolve the cycle before checking admission. No await may split the child
  // count check and registration, or parallel delegations can exceed the cap.
  const { toolRegistry } = await import("./tool-registry.js");
  const args = delegateArgsSchema.parse(raw);
  const parent = agentRuntimeStore.getSession(input.sessionId);
  const active = parent.childSessionIds.map(id => agentRuntimeStore.tryGetSession(id))
    .filter(child => child && ["queued", "running", "waiting_permission", "waiting_input"].includes(child.status));
  if (active.length >= 5) throw new AgentValidationError("Maximum concurrent subagents (5) reached. Wait for a child to finish.");
  if (args.contentParts) {
    validateAssets(args.contentParts, parent.projectId);
    for (const part of args.contentParts)
      if (part.type !== "text" && !sessionHasAsset(parent.id, part.assetId))
        throw new AgentPermissionError("Only parent-attached assets may be delegated.");
  }
  const { profile, templateId } = resolveConfig(parent.id, args);
  const prompt = [args.prompt, args.deliverable && `Deliverable: ${args.deliverable}`,
    args.acceptanceCriteria?.length && `Acceptance criteria:\n${args.acceptanceCriteria.map(item => `- ${item}`).join("\n")}`].filter(Boolean).join("\n\n");
  const child = agentSessionRuntime.create(buildSubagentChildInput(parent, profile, prompt,
    profileService.getForSession(parent), toolRegistry.listForSession(parent.id), templateId));
  if (args.contentParts) {
    const parts: RuntimeContentPart[] = [{ type: "text", text: prompt }, ...args.contentParts];
    await bindAssets(child.id, parts);
    agentRuntimeStore.updateSessionMetadata(child.id, { initialContentParts: parts });
  }
  const spec: SubagentSpec = { profileId: "subagent", prompt, nodeId: child.nodeId, thinkingMode: child.thinkingMode, label: profile.name };
  return { child, spec };
}

export async function delegateSubagent(input: ToolExecutionInput): Promise<ToolExecutionResult> {
  const { child, spec } = await createConfiguredSubagent(input, input.args as DelegateArgs);
  const outcome = await runChildToCompletion(child.id, spec, { abortSignal: input.abortSignal, input: {
    contentParts: agentRuntimeStore.getSession(child.id).sessionMetadata?.initialContentParts as RuntimeContentPart[] | undefined,
  } });
  const status = agentRuntimeStore.getSession(child.id).status;
  const summary = outcome.summary ?? outcome.error ?? `Child session ended as ${status}.`;
  return { result: { taskId: child.id, childSessionId: child.id, childStatus: status,
    session: { id: child.id, profileId: "subagent", status }, status: outcome.status, summary, error: outcome.error },
    displaySummary: `Subtask ${child.id} ${outcome.status}: ${summary}`,
    outcome: outcome.status === "completed" ? undefined : "failed",
    artifacts: [{ kind: "decision", title: "Subtask result", summary, risk: "low" }],
    followUpHints: ["Inspect the child result and continue the parent task."],
  };
}
