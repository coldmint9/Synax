import { asSchema } from "../../infrastructure/llm-runtime/tool-schema.js";
import type { StreamTurnRequest } from "./contracts.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { profileService } from "./profile-service.js";
import { toolRegistry } from "./tool-registry.js";
import { modelCanUseTool } from "./tool-mount-policy.js";
import { getGlobalConfigForRuntime } from "../../infrastructure/runtime/config/config-store.js";
import { buildLoopToolSet } from "./loop-ai-tools.js";
import { memoryManager } from "../context/memory-manager.js";
import { skillAgentBridge } from "../skills/agent-bridge.js";
import { loadProjectRulesSection } from "./synax/synax-instructions.js";
import { resolveSessionWorkDir } from "./tools/workspace.js";
import { buildLoopSystemPrompt } from "./loop-prompt.js";
import { readSessionPermissionConfig } from "./session-permissions.js";
import { synaxAgent } from "./synax/index.js";
import { buildRuntimeEnvironment } from "./prompt-environment.js";
import { ensureHostFacts } from "./host-facts.js";
import { workRuntime } from "./work-runtime.js";
import { conversationGitContextMessage } from "./conversation-git/context.js";
import { subagentContextMessage } from "./subagent-context.js";
import { subagentModelGuidance } from "./subagent-models.js";
import { buildProjectBuildInstructions } from "./project-build-instructions.js";
import { activeTurnReferences, pendingTurnReferenceSkillLoads } from "./turn-reference-state.js";
import { presentationDecision, pendingPresentationSkillLoads } from "./presentation-runtime.js";
import { loadedSkillContext } from "./skill-context.js";
import { measureContextPrompt } from "./context-measure.js";
import { signedInAccountTags } from "./signed-in-accounts.js";

/** Tools whose `profile.model` must name a configured ref, not a guess. */
const SUBAGENT_DELEGATION_TOOL_IDS = new Set(["subagent.delegate", "subagent.lifecycle"]);

async function nativeTools(sessionId: string) {
  const session = store.getSession(sessionId);
  const profile = profileService.getForSession(session);
  const allowed = toolRegistry.listForSession(sessionId).filter(tool => modelCanUseTool(profile, tool) &&
    !(tool.id === "webSearch" && getGlobalConfigForRuntime().webSearch.routing === "disabled"));
  const capabilities = await toolRegistry.capabilities.project(sessionId, allowed);
  const definitions = capabilities.tools.filter(tool => !["code.run", "code.tools"].includes(tool.id));
  const names = buildLoopToolSet(definitions, undefined, { stableNames: true });
  // Configured model refs ride on the delegation schema itself: the delegating
  // agent reads the exact accepted values instead of inventing one.
  const subagentModels = definitions.some(tool => SUBAGENT_DELEGATION_TOOL_IDS.has(tool.id))
    ? await subagentModelGuidance(session.projectId)
    : null;
  const tools = await Promise.all(definitions.map(async tool => {
    const name = names.resolveModelToolName(tool.id)!;
    return { name, runtimeName: tool.id,
      description: [tool.description, tool.progressiveDetails,
        SUBAGENT_DELEGATION_TOOL_IDS.has(tool.id) ? subagentModels : null].filter(Boolean).join(" "),
      inputSchema: await asSchema(names.tools[name].inputSchema).jsonSchema };
  }));
  return { tools, capabilities, availableToolIds: allowed.map(tool => tool.id) };
}

/** Warm immutable schema conversions and the tokenizer without a model call. */
export async function warmupNativeStepContext(sessionId: string): Promise<void> {
  const { tools } = await nativeTools(sessionId);
  // Version probes cost a process spawn each; warm them off the turn path so the
  // first step already renders the host toolchain instead of the agent
  // discovering it with extra commands.
  await ensureHostFacts();
  await measureContextPrompt({ sessionId, tools, systemPrompt: "", prompt: [] });
}

/** One capability/system projection for automatic and manual checkpoints. */
export async function buildNativeStepContext(sessionId: string, input: StreamTurnRequest, prompt: string, stepIndex: number) {
  // Non-blocking: a cold process renders without toolchain facts for one step
  // rather than delaying the turn on a slow `mvn -version`.
  void ensureHostFacts();
  const session = store.getSession(sessionId);
  const currentSession = session;
  const profile = profileService.getForSession(currentSession);
  const { tools, capabilities, availableToolIds } = await nativeTools(sessionId);
  const memories = memoryManager.getRelevantMemories(session.projectId, prompt, 5);
  const references = activeTurnReferences(sessionId) ?? input.referenceContext;
  const presentation = presentationDecision(sessionId);
  const selectedSkillIds = [...new Set([...session.skillIds, ...references?.skillIds ?? [],
    ...(presentation?.skillId ? [presentation.skillId] : [])])];
  const signedInAccounts = signedInAccountTags();
  const skills = skillAgentBridge.listForPrompt({ profileId: profile.id, projectId: session.projectId,
    activeSkillIds: selectedSkillIds, signedInAccounts });
  const workDir = resolveSessionWorkDir(sessionId, session.projectId);
  const rules = session.profileId === "git-manager" ? null : loadProjectRulesSection(workDir);
  const projectBuildInstructionsSection = buildProjectBuildInstructions(workDir);
  const messages = store.listMessages(sessionId);
  const commandContext = toolRegistry.commandTasks.stepContext(sessionId, session.activeRunId, stepIndex);
  const systemPrompt = [buildLoopSystemPrompt({
    profile, context: session.contextSnapshotId ? store.getContextBundle(session.contextSnapshotId) : null,
    availableToolIds: tools.map(tool => tool.runtimeName),
    effectivePermissionRules: currentSession.permissionRules, permissionTier: readSessionPermissionConfig(currentSession.sessionMetadata).permissionTier,
    isSubSession: Boolean(session.parentSessionId), locale: input.locale,
    modePromptSection: synaxAgent.buildModePromptSection(currentSession),
    variantPromptSection: synaxAgent.buildVariantPromptSection(currentSession),
    loopHintsOverride: synaxAgent.isSynaxSession(currentSession) ? synaxAgent.buildEffectiveLoopHints(currentSession) : null,
    projectRulesSection: rules,
    projectBuildInstructionsSection,
    projectMemoriesSection: memories.length ? memories.map(memory => JSON.stringify({
      id: memory.id, title: memory.title, type: memory.memoryType,
      sourceSessionId: memory.sourceSessionId, sourceEntryId: memory.sourceEntryId,
      updatedAt: memory.updatedAt, status: memory.status, references: memory.references,
      content: memory.content.slice(0, 400), truncated: memory.content.length > 400,
    })).join("\n") : null,
    skillsSection: skills.length ? "Available skills; selected skills are prepared through skill.load. Inspect the load receipt before using their instructions:\n" + skills.map(skill => JSON.stringify({ id: skill.id, name: skill.label, description: skill.description, ...(selectedSkillIds.includes(skill.id) ? { selected: true } : {}) })).join("\n") : null,
    selectedReferencesSection: references?.content,
    visualizationIntent: presentation?.mode === "inline_visualization",
  }), loadedSkillContext(sessionId, selectedSkillIds), capabilities.prompt].filter(Boolean).join("\n\n");
  // Mutable state must be appended to durable history before projection. Putting
  // it in systemPrompt invalidates the provider's entire conversation prefix.
  const runtimeSections = [
    buildRuntimeEnvironment(sessionId, session.projectId),
    workRuntime.prompt(sessionId),
    synaxAgent.buildRuntimeStateSection(currentSession),
    conversationGitContextMessage(messages, sessionId),
    subagentContextMessage(messages, sessionId),
    commandContext,
    presentation?.repairMessage,
  ].filter((section): section is string => Boolean(section));
  if (currentSession.sessionMetadata?.latestSystemPrompt !== systemPrompt) store.updateSessionMetadata(sessionId, { latestSystemPrompt: systemPrompt });
  const pendingLoads = [...pendingTurnReferenceSkillLoads(sessionId), ...pendingPresentationSkillLoads(sessionId)];
  const beforeModelTools = [...new Map(pendingLoads.map(call => [String(call.args.skillId), call])).values()]
    .map(call => ({ id: call.id, name: call.toolId, input: call.args }));
  return { systemPrompt, runtimeSections, tools, beforeModelTools, completionCheck: Boolean(presentation) };
}
