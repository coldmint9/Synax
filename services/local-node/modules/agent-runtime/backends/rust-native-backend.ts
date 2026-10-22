import { toolEventStream, WORKER_PORTABLE_TOOLS } from "./tool-event-stream.js";
import { hasBackgroundProcesses } from "../process-ownership.js";
import { getBrowserSession } from "../tools/browser/browser-manager.js";
import { resolvePermissionDecision } from "../permission-policy.js";
import type { RustAgentLoopEvent } from "../rust-agent-loop-client.js";
import * as z from "zod/v4";
import { normalizeUsage } from "../../../infrastructure/llm-runtime/usage.js";
import { resolveGatewaySelection } from "../../../infrastructure/llm-runtime/gateway.js";
import { businessStore } from "../../../infrastructure/persistence/business-store.js";
import type { StreamTurnRequest, AgentRunStreamChunk, AgentRun, AgentRunStep, AgentRuntimeMessage } from "../contracts.js";
import type { BackendAdapter } from "./backend-contracts.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { toolRegistry, type ExecuteToolResult } from "../tool-registry.js";
import { makeRuntimeId, nowIso } from "../runtime-ids.js";
import { assertRustAgentLoopAvailable, streamRustAgentLoop, sendRustAgentToolResult, cancelRustAgentLoop, sendRustStepContext } from "../rust-agent-loop-client.js";
import { interactionService } from "../interaction-service.js";
import { loopResumeService } from "../loop-resume.js";
import { profileService } from "../profile-service.js";
import { buildLoopSystemPrompt } from "../loop-prompt.js";
import { readSessionPermissionConfig } from "../session-permissions.js";
import { emitSessionLive } from "../../../infrastructure/runtime/ipc/agent-session-protocol.js";
import { sessionHooks } from "../session-hooks.js";
import { goalEvidenceSection } from "../control-runtime.js";
import { workRuntime } from "../work-runtime.js";
import { synaxAgent } from "../synax/index.js";
import { buildRuntimeEnvironment } from "../prompt-environment.js";
import { loadProjectRulesSection } from "../synax/synax-instructions.js";
import { resolveSessionWorkDir } from "../tools/workspace.js";
import { memoryManager } from "../../context/memory-manager.js";
import { skillAgentBridge } from "../../skills/agent-bridge.js";
import { modelCanUseTool } from "../tool-mount-policy.js";
import { warmupMcpForSession } from "../../../infrastructure/mcp/mcp-session-tool-provider.js";
import { mapThinkingModeToReasoningEffort } from "../../../infrastructure/llm-runtime/thinking-mode-strategy.js";
import type { LlmGatewayRequest } from "../../../infrastructure/llm-runtime/types.js";
import { modelContentParts } from "../media-assets.js";
import { resolveMediaMessages } from "../media-capabilities.js";
import { buildLoopToolSet } from "../loop-ai-tools.js";
import { getGlobalConfigForRuntime } from "../../../infrastructure/runtime/config/config-store.js";
import { countTokens } from "../context-tokenizer.js";
import { logger } from "../../../infrastructure/runtime/logger.js";
import { toRuntimeError } from "../runtime-errors.js";
import { conversationGitContextMessage } from "../conversation-git/context.js";
import { contextUsageSnapshot } from "../analytics-projection.js";

function toolSchema(value: unknown): Record<string, unknown> {
  return z.toJSONSchema(value as z.ZodTypeAny, { unrepresentable: "any" }) as Record<string, unknown>;
}

/** Translates Rust decisions into host tool execution and public projections.
 * Step progression and model/tool context live in the current Rust process. */
export class RustNativeBackend implements BackendAdapter {
  private readonly activeLoops = new Map<string, string>();
  private readonly loopSequences = new Map<string, number>();
  private readonly preparedContexts = new Map<string, { contextId: string; systemPrompt: string; tools: unknown[] }>();

  async *stream(sessionId: string, mode: string, input: StreamTurnRequest, signal?: AbortSignal): AsyncGenerator<AgentRunStreamChunk> {
    const observation = new AbortController();
    const workSignal = signal ? AbortSignal.any([signal, observation.signal]) : observation.signal;
    await store.hydrateSession(sessionId);
    await businessStore.refresh();
    const resumed = mode === "resume" || input.resumeExecution === true;
    let completedWorkerStep = false;
    if (resumed) {
      const activeId = store.getSession(sessionId).activeRunId;
      const loopId = activeId ? store.getRun(activeId).metadata.rustLoopId : undefined;
      if (typeof loopId !== "string") throw new Error("RUN_INTERRUPTED: previous execution is unavailable.");
      await assertRustAgentLoopAvailable(loopId, input.executionContext, signal);
    }
    const readyInteraction = resumed && !input.resumeExecution ? interactionService.list(sessionId).find(item =>
      item.runId === store.getSession(sessionId).activeRunId && ["answered", "cancelled"].includes(item.status) && item.response && !item.consumedAt) : undefined;
    const resolvedInteraction = readyInteraction ? await interactionService.consumeAuthoritative(sessionId) : null;
    const pending = resumed && !input.resumeExecution && !resolvedInteraction ? await loopResumeService.resolvePendingRun(sessionId) : null;
    const session = store.getSession(sessionId);
    if (resumed && !session.activeRunId) throw new Error("Session has no active Rust run to resume.");
    const prompt = input.message?.trim() || session.prompt;
    const user = resumed ? null : store.appendMessage({
      id: makeRuntimeId("msg"), sessionId, runId: input.acceptedRunId ?? null, stepId: null,
      role: "user", content: prompt, contentParts: input.contentParts,
      metadata: { source: input.messageSource ?? "rust_loop" }, createdAt: nowIso(),
    });
    let run: AgentRun = input.acceptedRunId ? store.getRun(input.acceptedRunId)
      : resumed && session.activeRunId ? store.getRun(session.activeRunId)
      : store.appendRun({ id: makeRuntimeId("run"), sessionId, status: "running", startedAt: nowIso(),
          completedAt: null, triggerMessageId: user!.id, currentStep: 0, stopReason: null,
          model: input.model ?? null, metadata: {} });
    run = store.updateRun(run.id, { status: "running", triggerMessageId: user?.id ?? run.triggerMessageId, completedAt: null, stopReason: null,
      metadata: { ...run.metadata, engine: "rust", hostProcessId: process.pid } });
    let step: AgentRunStep | undefined = resumed ? store.listRunSteps(run.id).sort((a, b) => b.index - a.index)[0] : undefined;
    store.updateSession(sessionId, { status: "running", activeRunId: run.id, pendingResumeToken: null, blockedReason: null, updatedAt: nowIso() });
    if (!resumed) {
      workRuntime.attach(sessionId, run);
      if (input.referenceContext) store.updateRun(run.id, { metadata: { ...store.getRun(run.id).metadata,
        turnReferences: input.referenceContext, turnReferenceInputId: user?.id } });
      run = store.getRun(run.id);
      await sessionHooks.emit({ type: "run:started", sessionId, runId: run.id });
    }
    if (user) yield { type: "message", message: user };
    yield { type: resumed ? "run_resumed" : "run_started", run };
    let waiting = false;
    let terminal = false;
    let compacting = false;
    let text = "";
    let thought = "";
    let lastFinish = "stop";
    let disposition: import("../rust-agent-loop-client.js").RustAgentLoopEvent["disposition"];
    let assistant: AgentRuntimeMessage | undefined;
    try {
      if (resumed && typeof run.metadata.rustLoopId !== "string") throw new Error("RUN_INTERRUPTED: the previous execution is no longer available.");
      const selection = await resolveGatewaySelection({ projectId: session.projectId, purpose: input.purpose ?? "analyze", model: input.model });
      const contextLimit = Math.min(selection.modelDef.contextLimit ?? 200_000, selection.modelDef.inputLimit ?? Infinity);
      const outputReserve = input.maxTokens ?? selection.modelDef.maxTokens ?? 8192;
      const generationRequest: LlmGatewayRequest = { projectId: session.projectId, purpose: input.purpose ?? "agent", messages: [],
        temperature: input.temperature, reasoningEffort: input.reasoningEffort ?? mapThinkingModeToReasoningEffort(session.thinkingMode) };
      run = store.updateRun(run.id, { metadata: { ...store.getRun(run.id).metadata, contextLimit, outputReserve } });
      await warmupMcpForSession(sessionId);
      const prepareContext = (stepIndex: number) => {
      const currentSession = store.getSession(sessionId);
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
      }), capabilities.prompt, buildRuntimeEnvironment(sessionId, session.projectId), workRuntime.prompt(sessionId), synaxAgent.buildRuntimeStateSection(currentSession), goalEvidenceSection(currentSession, store.listToolCalls(sessionId)), conversationGitContextMessage(store.listMessages(sessionId), sessionId)].filter(Boolean).join("\n\n");
      if (currentSession.sessionMetadata?.latestSystemPrompt !== systemPrompt) store.updateSessionMetadata(sessionId, { latestSystemPrompt: systemPrompt });
      return { systemPrompt, tools };
      };
      const { systemPrompt, tools } = prepareContext(1);
      const promptMessages: unknown[] = [{ role: "system", content: [{ type: "text", text: systemPrompt }] }];
      for (const message of store.listMessages(sessionId)) {
        if (!["user", "assistant", "tool"].includes(message.role)) continue;
        const canonical = message.metadata?.rustMessage;
        if (canonical) promptMessages.push(canonical);
        else if (message.contentParts?.length && (message.role === "user" || message.role === "assistant")) {
          const media = await resolveMediaMessages([{ role: message.role,
            content: modelContentParts(message.contentParts) }], selection, session.projectId);
          promptMessages.push(...media);
        } else promptMessages.push({ role: message.role, content: [{ type: "text", text: message.content }] });
      }
      const resultFor = async (exec: ExecuteToolResult, toolCallId: string, loopId: string) => {
        let result = exec.toolResult?.result ?? exec.record.outputRef ?? { error: exec.record.error };
        if (exec.record.contentParts?.length) {
          const media = await resolveMediaMessages([{ role: "user", content: modelContentParts(exec.record.contentParts),
            providerOptions: { synax: { toolCallId } } }], selection, session.projectId);
          result = { type: "content", value: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) },
            ...media.flatMap<unknown>(message => Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }])] };
        }
        await store.flushSession(sessionId);
        await sendRustAgentToolResult({ loopId, toolCallId,
          result,
          executionContext: input.executionContext,
          isError: ["failed", "denied", "cancelled"].includes(exec.record.status), signal });
      };
      const delivery = { through: this.loopSequences.get(run.id) ?? Number(run.metadata.rustLoopSequence ?? 0) };
      const events = streamRustAgentLoop({
        requestId: `native-loop:${run.id}`,
        loopId: resumed ? run.metadata.rustLoopId as string : undefined,
        resumeLoop: resumed, after: resumed ? this.loopSequences.get(run.id) ?? Number(run.metadata.rustLoopSequence ?? 0) : 0,
        runtimeBinding: { sessionId, runId: run.id },
        contextPolicy: { contextLimit, outputReserve },
        executionContext: input.executionContext,
        apiFormat: selection.apiFormat, adapter: selection.provider.npm, baseUrl: selection.config.baseUrl ?? selection.provider.api,
        providerId: selection.providerId, providerOptions: selection.config.options?.providerOptions as LlmGatewayRequest["providerOptions"],
        purpose: generationRequest.purpose, reasoningEffort: generationRequest.reasoningEffort, reasoningCapable: selection.modelDef.reasoning, temperature: input.temperature,
        apiKey: selection.config.apiKey ?? selection.config.options?.apiKey as string | undefined
          ?? selection.provider.env.map(name => process.env[name]?.trim()).find(Boolean),
        headers: selection.config.options?.headers as Record<string, string> | undefined,
        model: selection.modelId, prompt: promptMessages, tools, maxOutputTokens: outputReserve,
        cachePolicy: { adapter: selection.provider.npm, mode: selection.config.options?.promptCaching, chatBreakpoints: selection.config.options?.chatCacheBreakpoints, sessionId, projectId: session.projectId },
      }, workSignal, async loopId => {
        this.activeLoops.set(sessionId, loopId);
        run = store.updateRun(run.id, { metadata: { ...store.getRun(run.id).metadata, rustLoopId: loopId } });
        await store.flushSession(sessionId);
      }, () => delivery.through);
      if (resolvedInteraction) {
        const call = store.getToolCall(sessionId, resolvedInteraction.toolCallId);
        if (!call.modelToolCallId) throw new Error("Human input has no provider call identity.");
        yield { type: "tool_result", runId: run.id, stepId: resolvedInteraction.stepId, toolCall: call };
        await resultFor({ record: call }, call.modelToolCallId, run.metadata.rustLoopId as string);
      }
      if (pending?.toolCall) {
        const call = pending.toolCall;
        if (!call.modelToolCallId) throw new Error("Pending tool has no provider call identity.");
        if (pending.permission.action === "ask") throw new Error("Permission has not been answered.");
        const exec = pending.permission.action === "allow"
          ? await toolRegistry.resumePending(sessionId, pending.permission, signal)
          : { record: store.updateToolCall(sessionId, call.id, { status: "denied", endedAt: nowIso(), error: pending.permission.reason }), permission: pending.permission };
        yield { type: "tool_result", runId: run.id, stepId: pending.step.id, toolCall: exec.record };
        await resultFor(exec, call.modelToolCallId, run.metadata.rustLoopId as string);
      }
      const executeRequestedTool = async (event: RustAgentLoopEvent, emit: (chunk: AgentRunStreamChunk) => void) => {
          if (!step || !event.loopId || !event.toolCallId) throw new Error("Invalid Rust tool request.");
          // The host executes one requested operation. Rust owns the ordered
          // program and its result receipts; never reuse a Node batch loop.
          if (store.getRun(run.id).execution?.phase !== "executing_tool") {
            run = store.updateRun(run.id, { execution: { phase: "executing_tool", startedAt: nowIso() } });
            emit({ type: "execution_status", runId: run.id, execution: run.execution! });
          }
          const previous = store.listToolCalls(sessionId).find(call => call.runId === run.id && call.modelToolCallId === event.toolCallId);
          let exec: ExecuteToolResult;
          if (previous) {
            if (previous.status === "running") throw new Error("Tool execution has no terminal receipt; inspect its effects before recovery.");
            exec = { record: previous, permission: previous.permissionDecisionId
              ? store.listPermissions(sessionId).find(permission => permission.id === previous.permissionDecisionId) : undefined };
          } else {
            exec = await toolRegistry.execute(sessionId, event.toolName ?? "", event.input ?? {}, {
              runId: run.id, stepId: step.id, modelToolCallId: event.toolCallId,
              resumeToken: `${run.id}:${step.id}:${event.toolCallId}`, abortSignal: workSignal,
              onProgress: toolCall => emit({ type: "tool_call", runId: run.id, stepId: toolCall.stepId!, toolCall }),
            });
          }
          if (exec.interactionId) {
            waiting = true;
            this.loopSequences.set(run.id, Math.max(this.loopSequences.get(run.id) ?? 0, event.sequence ?? 0));
            store.updateRun(run.id, { metadata: { ...store.getRun(run.id).metadata, rustLoopSequence: event.sequence } });
            emit({ type: "tool_call", runId: run.id, stepId: step.id, toolCall: exec.record });
            const requested = store.listEvents(sessionId).find(item => item.type === "interaction_requested" && item.payload?.interactionId === exec.interactionId);
            if (requested) emit({ type: "event", event: requested });
            emit({ type: "done", sessionId, runId: run.id });
            return;
          }
          if (exec.permission?.action === "ask") {
            run = store.updateRun(run.id, { status: "waiting_permission", stopReason: exec.permission.reason });
            store.updateRunStep(step.id, { status: "waiting_permission", finishReason: "permission_required" });
            store.updateSession(sessionId, { status: "waiting_permission", activeRunId: run.id,
              pendingResumeToken: exec.permission.resumeToken, blockedReason: exec.permission.reason, updatedAt: nowIso() });
            this.loopSequences.set(run.id, Math.max(this.loopSequences.get(run.id) ?? 0, event.sequence ?? 0));
            store.updateRun(run.id, { metadata: { ...store.getRun(run.id).metadata, rustLoopSequence: event.sequence } });
            waiting = true;
            emit({ type: "permission_requested", runId: run.id, stepId: step.id, permission: exec.permission, toolCall: exec.record });
            return;
          }
          emit({ type: "tool_call", runId: run.id, stepId: step.id, toolCall: exec.record });
          emit({ type: "tool_result", runId: run.id, stepId: step.id, toolCall: exec.record });
          await resultFor(exec, event.toolCallId, event.loopId);

        this.loopSequences.set(run.id, Math.max(this.loopSequences.get(run.id) ?? 0, event.sequence ?? 0));
      };
      for await (const item of toolEventStream(events, {
        progress: delivery, execute: executeRequestedTool, shouldStop: () => waiting, abort: () => observation.abort(),
        canParallel: event => {
          // An approval checkpoint is exclusive, including for read tools.
          // Execution still performs the authoritative permission review again.
          try {
            const tool = toolRegistry.getForSession(sessionId, event.toolName ?? "");
            const current = store.getSession(sessionId);
            return resolvePermissionDecision({ sessionId, category: tool.category, internalGate: tool.internalGate,
              pattern: tool.getPattern?.(event.input) ?? tool.id, rules: current.permissionRules,
              isSubSession: Boolean(current.parentSessionId),
              metadata: { toolId: tool.id, args: event.input, mutability: tool.mutability },
            }).action === "allow";
          } catch { return false; }
        },
      })) {
        if ("chunk" in item) { yield item.chunk; continue; }
        const event = item.event;
        if (event.type === "execution-status" && event.phase) {
          run = store.updateRun(run.id, { execution: { phase: event.phase, resource: event.resource,
            queuedAt: event.queuedAt ? new Date(event.queuedAt).toISOString() : undefined,
            startedAt: event.startedAt ? new Date(event.startedAt).toISOString() : undefined,
            deadline: event.deadline ? new Date(event.deadline).toISOString() : undefined } });
          yield { type: "execution_status", runId: run.id, execution: run.execution! };
        } else if (event.type === "context-request") {
          if (!event.loopId || !event.contextId || !event.step) throw new Error("Invalid Rust context request.");
          // Rust is parked at its context barrier: the previous tool receipts
          // are durable and no new provider request has started. Leave this
          // context event unacknowledged for the replacement worker to handle.
          if (completedWorkerStep && input.shouldYieldWorker?.() && this.activeLoops.size <= 1 && !getBrowserSession(sessionId) &&
              store.listToolCalls(sessionId).filter(call => call.runId === run.id).every(call => WORKER_PORTABLE_TOOLS.has(call.toolId)) &&
              !(await hasBackgroundProcesses(sessionId, true))) {
            waiting = true;
            const through = Math.max(0, (event.sequence ?? 1) - 1);
            this.loopSequences.set(run.id, through);
            store.updateRun(run.id, { metadata: { ...store.getRun(run.id).metadata, rustLoopSequence: through } });
            await store.flushSession(sessionId);
            yield { type: "worker_yield", runId: run.id };
            return;
          }
          step = store.listRunSteps(run.id).find(item => item.index === event.step) ?? store.appendRunStep({
            id: makeRuntimeId("stp"), sessionId, runId: run.id, index: event.step, status: "running",
            model: selection.modelId, startedAt: nowIso(), completedAt: null, finishReason: null, metadata: { engine: "rust" },
          });
          run = store.updateRun(run.id, { currentStep: step.index });
          if (!step.metadata.rustBeforeHook) {
            await sessionHooks.emit({ type: "step:before", sessionId, runId: run.id, stepIndex: step.index });
            step = store.updateRunStep(step.id, { metadata: { ...store.getRunStep(step.id).metadata, rustBeforeHook: true } });
          }
          // Card actions are handled by the API process while the native loop
          // may be parked in a worker. Refresh the durable session projection
          // before every context barrier so a newly persisted Git task anchor
          // or receipt is visible to the next model turn. The current run and
          // its durable tool receipts are merged by the Rust-backed store.
          this.preparedContexts.delete(run.id);
          await store.hydrateSession(sessionId, true);
          const savedContext = this.preparedContexts.get(run.id);
          const context = savedContext?.contextId === event.contextId ? savedContext : prepareContext(event.step);
          if (context !== savedContext) this.preparedContexts.set(run.id, { contextId: event.contextId, ...context });
          await store.flushSession(sessionId);
          await sendRustStepContext({ loopId: event.loopId, contextId: event.contextId, ...context, executionContext: input.executionContext }, signal);
        } else if (event.type === "context-compaction-started") {
          compacting = true;
          emitSessionLive(sessionId, { type: "context_compaction_started" });
        } else if (event.type === "compaction-call-started") {
          if (!event.requestId) throw new Error("Compaction request has no identity.");
          if (!store.getRecord("aux_usage", event.requestId)) store.saveRecord("aux_usage", {
            id: event.requestId, sessionId, runId: run.id, purpose: "context-compaction",
            startedAt: event.startedAt ?? nowIso(), completedAt: null, usage: null,
          });
        } else if (event.type === "compaction-usage" || event.type === "compaction-call-finished") {
          if (!event.requestId) throw new Error("Compaction usage has no identity.");
          const previous = store.getRecord<{ id: string; sessionId: string; startedAt: string; usage: unknown }>("aux_usage", event.requestId);
          if (!previous) throw new Error("Compaction request was not recorded.");
          store.saveRecord("aux_usage", { ...previous, usage: event.usage ? normalizeUsage(event.usage) : previous.usage,
            ...(event.type === "compaction-call-finished" ? { completedAt: nowIso() } : {}) });
          if (step && event.usage) store.updateRunStep(step.id, { metadata: { ...store.getRunStep(step.id).metadata,
            compactionUsage: { ...(store.getRunStep(step.id).metadata.compactionUsage as Record<string, unknown> | undefined),
              [String(event.chunk)]: event.usage } } });
        } else if (event.type === "context-compacted") {
          compacting = false;
          const recordId = `cmp_${event.loopId}_${event.step}`;
          store.saveCompactionRecord({ id: recordId, sessionId, runId: run.id,
            summaryText: event.summary ?? "", compressedMessageCount: event.messageCount ?? 0,
            originalTokenCount: event.originalTokens ?? 0, compressedTokenCount: event.compressedTokens ?? 0, createdAt: nowIso() });
          emitSessionLive(sessionId, { type: "context_compacted", stepId: step?.id ?? "",
            originalTokens: event.originalTokens ?? 0, compressedTokens: event.compressedTokens ?? 0, messageCount: event.messageCount ?? 0 });
        } else if (event.type === "context-composition") {
          if (step && event.composition) {
            store.updateRunStep(step.id, { metadata: { ...store.getRunStep(step.id).metadata,
              contextComposition: event.composition } });
            // Incremental, persisted context usage for the composer ring and
            // analytics; the request composition is measured only once here.
            const usageSnapshot = contextUsageSnapshot(event.composition, step.id, contextLimit);
            if (usageSnapshot) store.updateSessionMetadata(sessionId, { contextUsage: usageSnapshot });
          }
        } else if (event.type === "step-started") {
          const existing = store.listRunSteps(run.id).find(item => item.index === event.step);
          step = existing ?? store.appendRunStep({ id: makeRuntimeId("stp"), sessionId, runId: run.id, index: event.step!,
            status: "running", model: selection.modelId, startedAt: nowIso(), completedAt: null,
            finishReason: null, metadata: { engine: "rust" } });
          run = store.updateRun(run.id, { currentStep: step.index, model: selection.modelId });
          text = ""; thought = ""; assistant = undefined;
          yield { type: "step_started", step };
        } else if (event.type === "retry_status" && event.retry) {
          if (!step) throw new Error("Rust retry has no persisted step.");
          yield { type: "retry_status", runId: run.id, stepId: step.id, retry: event.retry };
        } else if (event.type === "step-restarted") {
          if (!step) throw new Error("Rust restart has no persisted step.");
          text = ""; thought = ""; assistant = undefined;
          const correctingArguments = event.reason === "invalid_tool_arguments";
          const reason = correctingArguments ? "upstream"
            : event.reason === "rate_limit" ? "rate_limit"
              : event.reason === "upstream" ? "upstream"
                : "network";
          yield { type: "retry_status", runId: run.id, stepId: step.id, retry: {
            reason, phase: "waiting", group: 1, attempt: event.attempt ?? 1,
            maxRetries: event.maxRetries ?? 0, nextRetryAt: null,
            error: event.error ?? "Rust runtime recovered an interrupted model request.",
          } };
        } else if (event.type === "text-delta" || event.type === "reasoning-delta") {
          if (!step) throw new Error("Rust output has no step.");
          if (store.getRun(run.id).execution?.phase !== "generating") {
            run = store.updateRun(run.id, { execution: { phase: "generating", lastProgressAt: nowIso() } });
            yield { type: "execution_status", runId: run.id, execution: run.execution! };
          }
          if (event.type === "text-delta") text += event.delta ?? ""; else thought += event.delta ?? "";
          const reportedTokens = event.type === "text-delta" ? event.outputTokens : event.thinkingTokens;
          // Older sidecars/checkpoints may not carry live token telemetry.
          const telemetry = typeof reportedTokens === "number" && Number.isSafeInteger(reportedTokens) && reportedTokens >= 0
            ? reportedTokens
            : countTokens(event.type === "text-delta" ? text : thought, selection.modelId);
          yield event.type === "text-delta"
            ? { type: "message_delta", runId: run.id, stepId: step.id, delta: event.delta ?? "", outputTokens: telemetry }
            : { type: "thought_delta", runId: run.id, stepId: step.id, delta: event.delta ?? "", thinkingTokens: telemetry };
        } else if (event.type === "usage") {
          if (!step) throw new Error("Rust usage has no step.");
          store.updateRunStep(step.id, { metadata: { ...store.getRunStep(step.id).metadata, usage: event.usage } });
        } else if (event.type === "assistant-message") {
          if (!step || !event.message) throw new Error("Rust assistant output has no step or content.");
          const parts = event.message.content as Array<Record<string, unknown>>;
          text = parts.filter(part => part.type === "text").map(part => part.text ?? "").join("");
          assistant = store.listMessages(sessionId).find(message => message.stepId === step!.id && message.role === "assistant");
          if (!assistant) {
            assistant = store.appendMessage({ id: makeRuntimeId("msg"), sessionId, runId: run.id, stepId: step.id, role: "assistant",
              content: text, metadata: { engine: "rust", thought, rustMessage: event.message }, createdAt: nowIso() });
            yield { type: "message", message: assistant };
          }
        } else if (event.type === "tool-result") {
          if (!step || !event.toolCallId) throw new Error("Rust tool result has no step or identity.");
          const id = `msg_tool_${run.id}_${event.toolCallId}`;
          if (!store.listMessages(sessionId).some(message => message.id === id)) {
            const output = event.result;
            store.appendMessage({ id, sessionId, runId: run.id, stepId: step.id, role: "tool",
              content: typeof output === "string" ? output : JSON.stringify(output ?? null), createdAt: nowIso(),
              metadata: { engine: "rust", modelToolCallId: event.toolCallId, rustMessage: { role: "tool",
                content: [{ type: "tool-result", toolCallId: event.toolCallId, output, isError: event.isError }] } },
            });
          }
        } else if (event.type === "finish") {
          lastFinish = event.finishReason ?? "stop";
        } else if (event.type === "step-completed") {
          completedWorkerStep = true;
          if (step) {
            step = store.updateRunStep(step.id, { status: "completed", completedAt: nowIso(), finishReason: lastFinish });
            if (!step.metadata.rustAfterHook) {
              await sessionHooks.emit({ type: "step:after", sessionId, runId: run.id, stepIndex: step.index });
              store.updateRunStep(step.id, { metadata: { ...store.getRunStep(step.id).metadata, rustAfterHook: true } });
            }
          }
        } else if (event.type === "cancelled") {
          terminal = true;
          throw new Error("Rust loop cancelled.");
        } else if (event.type === "error") {
          terminal = true;
          throw new Error(event.error ?? "Rust agent loop failed.");
        } else if (event.type === "done") {
          disposition = event.disposition;
          terminal = true;
          break;
        }
        this.loopSequences.set(run.id, event.sequence ?? 0);
        run = store.getRun(run.id);
      }
      if (waiting) return;
      if (!terminal) throw new Error("Rust loop ended without a terminal event.");
      if (step) store.updateRunStep(step.id, { status: "completed", completedAt: nowIso(), finishReason: lastFinish,
        metadata: { ...store.getRunStep(step.id).metadata, thought } });
      const finalStatus = disposition?.status ?? "completed";
      const summary = disposition?.summary || text;
      if (summary && summary !== assistant?.content) {
        assistant = store.appendMessage({ id: makeRuntimeId("msg"), sessionId, runId: run.id, stepId: step?.id ?? null,
          role: "assistant", content: summary, metadata: { engine: "rust", disposition: disposition?.reason }, createdAt: nowIso() });
        yield { type: "message", message: assistant };
      }
      const completed = store.updateRun(run.id, { status: finalStatus, completedAt: nowIso(), stopReason: disposition?.reason ?? "completed", model: selection.modelId });
      store.updateSession(sessionId, { status: finalStatus === "blocked" ? "completed" : finalStatus,
        activeRunId: null, pendingResumeToken: null, completedAt: nowIso(),
        blockedReason: finalStatus === "blocked" || finalStatus === "failed" ? summary : null, updatedAt: nowIso(), resultSummary: summary });
      await sessionHooks.emit({ type: "run:completed", sessionId, runId: run.id, status: finalStatus });
      if (finalStatus === "failed" || finalStatus === "blocked") yield { type: "run_failed", run: completed, error: summary };
      else yield { type: "run_completed", run: completed, ...(assistant ? { message: assistant } : {}) };
      yield { type: "done", sessionId, runId: run.id };
    } catch (error) {
      const loopId = this.activeLoops.get(sessionId);
      if (loopId && !terminal) await cancelRustAgentLoop(loopId).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      if (compacting) emitSessionLive(sessionId, { type: "context_compaction_failed", error: message });
      const interrupted = signal?.aborted || message === "Rust loop cancelled." || message.includes("RUN_INTERRUPTED");
      if (!interrupted) logger.error({ sessionId, runId: run.id, stepId: step?.id,
        code: toRuntimeError(error).code, err: error,
      }, "[agent-runtime] native run failed");
      if (step) store.updateRunStep(step.id, { status: interrupted ? "interrupted" : "failed", completedAt: nowIso(), finishReason: message });
      const failed = store.updateRun(run.id, { status: interrupted ? "interrupted" : "failed", completedAt: nowIso(), stopReason: message });
      store.updateSession(sessionId, { status: interrupted ? "paused" : "failed", activeRunId: null, pendingResumeToken: null,
        blockedReason: interrupted ? null : message, resultSummary: message, updatedAt: nowIso() });
      yield interrupted ? { type: "run_completed", run: failed } : { type: "run_failed", run: failed, error: message };
      yield { type: "done", sessionId, runId: run.id };
    } finally {
      observation.abort();
      if (!waiting) { this.activeLoops.delete(sessionId); this.preparedContexts.delete(run.id); this.loopSequences.delete(run.id); }
    }
  }

  async interrupt(sessionId: string, _reason: string): Promise<void> {
    const loopId = this.activeLoops.get(sessionId) ?? store.listRuns(sessionId).find(run =>
      ["running", "waiting_permission", "waiting_input"].includes(run.status) && typeof run.metadata.rustLoopId === "string")?.metadata.rustLoopId;
    if (typeof loopId === "string") await cancelRustAgentLoop(loopId);
  }
  async close(sessionId: string): Promise<void> { await this.interrupt(sessionId, "Session closed."); }
}
export const rustNativeBackend = new RustNativeBackend();
