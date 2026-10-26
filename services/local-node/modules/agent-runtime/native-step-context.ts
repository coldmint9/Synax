import * as z from "zod/v4";
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
import { workRuntime } from "./work-runtime.js";
import { goalEvidenceSection } from "./control-runtime.js";
import { conversationGitContextMessage } from "./conversation-git/context.js";
import { subagentContextMessage } from "./subagent-context.js";

const toolSchema = (value: unknown) => z.toJSONSchema(value as z.ZodTypeAny, { unrepresentable: "any" }) as Record<string, unknown>;

/** One capability/system projection for automatic and manual checkpoints. */
export function buildNativeStepContext(sessionId: string, input: StreamTurnRequest, prompt: string, stepIndex: number) {
  const session = store.getSession(sessionId);
  const currentSession = session;
  const profile = profileService.getForSession(currentSession);
  const allowed = toolRegistry.listForSession(sessionId).filter(tool => modelCanUseTool(profile, tool) &&
    !(tool.id === "webSearch" && getGlobalConfigForRuntime().webSearch.routing === "disabled"));
  const capabilities = toolRegistry.capabilities.project(sessionId, allowed);
  const definitions = capabilities.tools.filter(tool => !["code.run", "code.tools"].includes(tool.id));
  const names = buildLoopToolSet(definitions, undefined, { stableNames: true });
  const tools = definitions.map(tool => ({ name: names.resolveModelToolName(tool.id)!, runtimeName: tool.id,
    description: [tool.description, tool.progressiveDetails].filter(Boolean).join(" "), inputSchema: toolSchema(tool.inputSchema) }));
  const memories = memoryManager.getRelevantMemories(session.projectId, prompt, 5);
  const skills = skillAgentBridge.listForPrompt({ profileId: profile.id, projectId: session.projectId,
    activeSkillIds: [...new Set([...session.skillIds, ...input.referenceContext?.skillIds ?? []])] });
  const rules = session.profileId === "git-manager" ? null : loadProjectRulesSection(resolveSessionWorkDir(sessionId, session.projectId));
  const messages = store.listMessages(sessionId);
  const evidence = !currentSession.parentSessionId && currentSession.sessionMetadata?.mode === "goal"
    ? goalEvidenceSection(currentSession, store.listToolCalls(sessionId)) : "";
  const systemPrompt = [buildLoopSystemPrompt({
    profile, context: session.contextSnapshotId ? store.getContextBundle(session.contextSnapshotId) : null,
    availableToolIds: tools.map(tool => tool.runtimeName),
    effectivePermissionRules: currentSession.permissionRules, permissionTier: readSessionPermissionConfig(currentSession.sessionMetadata).permissionTier,
    isSubSession: Boolean(session.parentSessionId), locale: input.locale,
    modePromptSection: synaxAgent.buildModePromptSection(currentSession),
    variantPromptSection: synaxAgent.buildVariantPromptSection(currentSession),
    intentPromptSection: synaxAgent.isSynaxSession(currentSession) ? synaxAgent.buildIntentPromptSection(currentSession, prompt, stepIndex) : null,
    loopHintsOverride: synaxAgent.isSynaxSession(currentSession) ? synaxAgent.buildEffectiveLoopHints(currentSession) : null,
    projectRulesSection: rules,
    projectMemoriesSection: memories.length ? memories.map(memory => `${memory.title}: ${memory.content.slice(0, 400)}`).join("\n") : null,
    skillsSection: skills.length ? "Available skills; load selected skills before using their instructions:\n" + skills.map(skill => JSON.stringify({ id: skill.id, name: skill.label, description: skill.description })).join("\n") : null,
    selectedReferencesSection: input.referenceContext?.content,
  }), capabilities.prompt, buildRuntimeEnvironment(sessionId, session.projectId), workRuntime.prompt(sessionId), synaxAgent.buildRuntimeStateSection(currentSession), evidence, conversationGitContextMessage(messages, sessionId), subagentContextMessage(messages, sessionId)].filter(Boolean).join("\n\n");
  if (currentSession.sessionMetadata?.latestSystemPrompt !== systemPrompt) store.updateSessionMetadata(sessionId, { latestSystemPrompt: systemPrompt });
  return { systemPrompt, tools };
}
