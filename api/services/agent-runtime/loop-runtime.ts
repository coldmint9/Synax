import { coalesceLoopDeltas } from "./loop-delta-bursts.js";
import {
  persistInlineVisualization,
  hydrateCompletedVisualizations,
} from "./visualization-integration.js";
import { isVisualizationIntent } from "./visualization-intent.js";
import { filterHistoryFileReads } from "./checkpoints/state.js";
import {
  captureCheckpoint,
  captureCompletedReply,
} from "./checkpoints/store.js";
import { assertHistoryUnlocked } from "./checkpoints/guards.js";
import { workflowMode, usesGoalWorkflow } from "./workflow-mode.js";
import { buildToolContextReceipt } from "./tool-context-receipt.js";
import {
  cacheDiagnosticsEnabled,
  fingerprintGatewayRequest,
  compareRequests,
  readCacheFingerprint,
  type CacheRequestFingerprint,
} from "../llm-runtime/cache-diagnostics.js";
import {
  readRuntimeReminder,
  runtimeReminderMessage,
  snapshotRuntimeReminder,
} from "./runtime-request-snapshot.js";
import { measureContextComposition } from "./context-composition.js";
import {
  normalizeInput,
  hasInput,
  mediaSafeErrorText,
} from "./content-parts.js";
import {
  activeTurnReferences,
  pendingTurnReferenceSkillLoads,
} from "./turn-reference-state.js";
import { prepareTurnReferences } from "./turn-references.js";
import { resolveSessionUserRequest } from "./session-user-request.js";
import { runtimeTransaction } from "./runtime-transaction.js";
import type { AgentSession } from "./contracts.js";
import {
  activateAcceptedRun,
  acceptedInputRequestId,
  type AcceptedRuntimeInput,
} from "./run-admission.js";
import { isWorkContinuation } from "./work-intent.js";
import { workRuntime } from "./work-runtime.js";
import { workStore } from "./work-store.js";
import {
  projectWorkContext,
  evictedContextToolIds,
} from "./context-projection.js";
import { getRawSqlite } from "../../db/index.js";
import { INVALID_TOOL_ID } from "./tool-invalid.js";
import { interactionService } from "./interaction-service.js";
import {
  CONTROL_TOOLS,
  validateControlBatch,
  controlToolError,
} from "./control-policy.js";
import {
  rootGoal,
  goalStopReason,
  belongsToPlanExecution,
  goalEvidenceSection,
  type PlanExecutionBoundary,
} from "./control-runtime.js";
import { getGoalState, initializeGoal } from "./goal-control.js";
import type {
  AgentContextBundle,
  AgentRun,
  AgentRunPart,
  AgentRunStep,
  AgentRunStreamChunk,
  AgentRuntimeMessage,
  LoopModelStreamEvent,
  LoopStepModelResult,
  StreamTurnRequest,
  StructuredToolCall,
  ToolCallRecord,
} from "./contracts.js";
import { agentEventService, type AgentEventService } from "./event-service.js";
import {
  detectDoomLoop,
  shouldConverge,
  buildConsecutiveFailureReminder,
} from "./loop-guards.js";
import { buildLoopToolSet } from "./loop-ai-tools.js";
import { streamLoopModelStep } from "./loop-model-stream.js";
import { buildLoopSystemPrompt, buildLoopStepNote } from "./loop-prompt.js";
import { buildRuntimeEnvironment } from "./prompt-environment.js";
import { synaxAgent } from "./synax/index.js";
import { loadProjectRulesSection } from "./synax/synax-instructions.js";
import { enrichContextForPrompt } from "./synax/synax-runtime-context.js";
import { resolvePromptLocale } from "../prompts/locale-infer.js";
import { readSessionPermissionConfig } from "./session-permissions.js";
import { isWikiAgentProfile } from "../wiki/wiki-agent-profiles.js";
import { memoryManager } from "../context/memory-manager.js";
import { loopResumeService, type LoopResumeService } from "./loop-resume.js";
import {
  permissionPolicy,
  type PermissionPolicy,
} from "./permission-policy.js";
import { profileService, type ProfileService } from "./profile-service.js";
import { AgentRuntimeError, AgentValidationError } from "./runtime-errors.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { agentRuntimeStore, type AgentRuntimeStore } from "./session-store.js";
import { normalizeAgentSessionStatus } from "./session-projection.js";
import { applySessionPermissionUpdate } from "./session-permissions.js";
import { toolRegistry, type ToolRegistry } from "./tool-registry.js";
import { profileCanUseTool } from "./tool-mount-policy.js";
import { rebuildSessionFileReads } from "./read-tracker.js";
import { skillAgentBridge } from "../skills/agent-bridge.js";
import { countMessagesTokens, countTokens } from "./context-tokenizer.js";
import { resolveSessionWorkDir } from "./tools/workspace.js";
import {
  runChildToCompletion,
  resolvePerChildTimeoutMs,
} from "./subagent-orchestrator.js";
import { sessionHooks } from "./session-hooks.js";
import { emitSessionLive } from "../../lib/ipc/agent-session-protocol.js";
import { resolveGatewaySelection } from "../llm-runtime/gateway.js";
import {
  mapThinkingModeToReasoningEffort,
  type ReasoningEffort,
} from "../llm-runtime/thinking-mode-strategy.js";
import { getGlobalConfigForRuntime } from "../../lib/config/config-store.js";
import { logger } from "../../lib/logger.js";
import {
  CONTEXT_TOOL_CLEAR_THRESHOLD,
  CONTEXT_TOOL_CLEAR_KEEP_RECENT,
  CONTEXT_TOOL_CLEAR_EXCLUDE,
} from "../../lib/env.js";
import { computeClearedToolCallIds } from "./loop-model-messages.js";
import { inputQueueService } from "./input-queue-service.js";
import { warmupMcpForSession } from "../mcp/mcp-session-tool-provider.js";

const LOG_TEXT_LIMIT = 2000;
const ACTIVE_SESSION_WAIT_MS = 25;
const ACTIVE_SESSION_TIMEOUT_MS = 5_000;
const DEFAULT_CONTEXT_LIMIT = 200_000;

export class AgentLoopRuntime {
  private readonly activeSessionControllers = new Map<
    string,
    Set<AbortController>
  >();

  constructor(
    private readonly store: AgentRuntimeStore = agentRuntimeStore,
    private readonly profiles: ProfileService = profileService,
    private readonly events: AgentEventService = agentEventService,
    private readonly toolsOverride?: ToolRegistry,
    private readonly permissions: PermissionPolicy = permissionPolicy,
    private readonly resume: LoopResumeService = loopResumeService,
  ) {}

  // ToolRegistry and session/runtime modules import each other. Resolve the
  // default at call time rather than capturing an uninitialized singleton.
  private get tools(): ToolRegistry {
    return this.toolsOverride ?? toolRegistry;
  }

  listMessages(sessionId: string): AgentRuntimeMessage[] {
    this.store.getSession(sessionId);
    const messages = this.store.listMessages(sessionId);
    hydrateCompletedVisualizations(messages);
    return messages;
  }

  listRuns(sessionId: string): AgentRun[] {
    this.store.getSession(sessionId);
    return this.store.listRuns(sessionId);
  }

  getRun(sessionId: string, runId: string): AgentRun {
    this.store.getSession(sessionId);
    const run = this.store.getRun(runId);
    if (run.sessionId !== sessionId)
      throw new AgentValidationError("Run does not belong to the session.");
    return run;
  }

  listRunSteps(sessionId: string, runId: string): AgentRunStep[] {
    this.getRun(sessionId, runId);
    return this.store.listRunSteps(runId);
  }

  async resumeRun(
    sessionId: string,
    input: StreamTurnRequest = {},
    abortSignal?: AbortSignal,
  ): Promise<void> {
    for await (const _chunk of this.streamRun(
      sessionId,
      input,
      abortSignal,
      true,
    )) {
      // Background resumes persist into the runtime store and event log.
    }
  }

  async *streamContinue(
    sessionId: string,
    input: StreamTurnRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<AgentRunStreamChunk> {
    let session = this.store.getSession(sessionId);
    if (input.acceptedRunId && session.status === "queued") {
      const accepted = this.store.getRun(input.acceptedRunId);
      const runtime = accepted.metadata.runtime as AcceptedRuntimeInput;
      if (accepted.sessionId !== sessionId || !runtime)
        throw new AgentValidationError("Invalid accepted Run.");
      session = {
        ...session,
        status: normalizeAgentSessionStatus(runtime.previousSessionStatus),
      };
    }

    const RESUMABLE: AgentSession["status"][] = [
      "interrupted",
      "completed",
      "failed",
      "cancelled",
    ];
    if (!RESUMABLE.includes(session.status)) {
      throw new AgentValidationError(
        `Session status "${session.status}" cannot be resumed. Resumable statuses: ${RESUMABLE.join(", ")}`,
      );
    }

    input = normalizeInput(input);
    const hasNewMessage = hasInput(input);

    if (!hasNewMessage && session.status === "completed") {
      throw new AgentValidationError(
        "Completed sessions require a new message to continue. Provide input.message.",
      );
    }

    // Recover any incomplete subagent.delegate calls before continuing
    await this.recoverIncompleteSubtasks(sessionId, abortSignal);

    if (hasNewMessage) {
      yield* this.streamRun(sessionId, input, abortSignal, false);
    } else {
      if (session.status === "interrupted") {
        const runs = this.store.listRuns(sessionId);
        const lastRun = runs.sort((a, b) =>
          b.startedAt.localeCompare(a.startedAt),
        )[0];
        if (lastRun?.status === "completed") {
          this.store.updateSession(sessionId, {
            status: "completed",
            updatedAt: nowIso(),
            completedAt: nowIso(),
            resultSummary:
              lastRun.stopReason ?? "Run completed before interruption.",
            blockedReason: null,
            activeRunId: null,
          });
          yield { type: "done", sessionId, runId: lastRun.id };
          return;
        }
      }
      const continuationPrompt = this.buildContinuationPrompt(
        sessionId,
        session.status,
      );
      yield* this.streamRun(
        sessionId,
        {
          ...input,
          message: continuationPrompt,
          messageSource: "system_injection",
        },
        abortSignal,
        false,
      );
    }
  }

  async *streamRun(
    sessionId: string,
    input: StreamTurnRequest,
    abortSignal?: AbortSignal,
    resume = false,
  ): AsyncGenerator<AgentRunStreamChunk> {
    input = normalizeInput(input);
    this.assertSessionNotBusy(sessionId);
    assertHistoryUnlocked(sessionId);
    const beforeStart = this.store.getSession(sessionId);
    if (
      beforeStart.sessionMetadata?.runtimeControl ||
      (beforeStart.parentSessionId &&
        beforeStart.sessionMetadata?.manualStop &&
        !hasInput(input))
    )
      throw new AgentRuntimeError(
        "Session has been stopped by user.",
        "ABORTED",
        499,
      );
    abortSignal?.throwIfAborted();
    if (
      !resume &&
      input.messageSource !== "system_injection" &&
      hasInput(input) &&
      !isWorkContinuation(input.message ?? "") &&
      !beforeStart.parentSessionId &&
      beforeStart.sessionMetadata?.mode === "goal"
    ) {
      const previousGoal = getGoalState(beforeStart.sessionMetadata);
      if (
        previousGoal &&
        ["completed", "cancelled"].includes(previousGoal.status)
      )
        this.store.updateSessionMetadata(sessionId, {
          goal: initializeGoal(input.message || "Media request"),
          plan: null,
        });
      else if (previousGoal?.status === "blocked")
        this.store.updateSessionMetadata(sessionId, {
          goal: {
            ...previousGoal,
            status:
              (
                beforeStart.sessionMetadata?.plan as
                  | { status?: string }
                  | undefined
              )?.status === "approved"
                ? "executing"
                : "planning",
            reason: undefined,
          },
        });
    }
    if (beforeStart.status === "waiting_input") {
      const pending = interactionService.pending(sessionId);
      if (pending?.kind === "plan_approval" && hasInput(input)) {
        interactionService.deferPlan(sessionId, pending.id);
        const resolved = interactionService.consume(sessionId);
        if (!resolved)
          throw new AgentValidationError(
            "Plan approval could not be converted into a saved plan.",
          );
        const completedAt = nowIso();
        this.store.updateRun(resolved.runId, {
          status: "completed",
          completedAt,
          stopReason: "plan_saved",
        });
        this.store.updateSession(sessionId, {
          status: "completed",
          updatedAt: completedAt,
          completedAt,
          resultSummary: "Plan saved for later execution.",
          blockedReason: null,
          activeRunId: null,
          pendingResumeToken: null,
        });
        this.events.append({
          sessionId,
          type: "run_completed",
          summary: "Plan saved for later execution.",
          payload: { runId: resolved.runId, stopReason: "plan_saved" },
        });
        yield* this.streamRun(sessionId, input, abortSignal, false);
        return;
      }
      if (!resume || !interactionService.ready(sessionId))
        throw new AgentValidationError(
          "Resolve the pending form before continuing.",
        );
    }
    if (
      !input.acceptedRunId &&
      (input.permissionTier !== undefined ||
        input.permissionOverrides !== undefined)
    ) {
      applySessionPermissionUpdate(sessionId, {
        permissionTier: input.permissionTier,
        permissionOverrides: input.permissionOverrides,
      });
    }
    let session = this.store.getSession(sessionId);
    const storedTier = session.sessionMetadata?.permissionTier;
    if (
      session.profileId === "synax" &&
      (storedTier === "readonly" || storedTier === "readwrite")
    ) {
      session = applySessionPermissionUpdate(sessionId, {
        permissionTier: "boundary",
      });
    } else if (session.profileId === "synax" && storedTier === undefined) {
      // Old sessions without a mode keep explicit restrictions, with mandatory boundary review added.
      session = this.store.updateSession(sessionId, {
        permissionRules: [
          { gate: "approval_mode", pattern: "boundary", action: "ask" },
          ...session.permissionRules,
        ],
        sessionMetadata: {
          ...session.sessionMetadata,
          permissionTier: "boundary",
        },
      });
    }
    if (input.reasoningEffort) {
      session = this.store.updateSession(sessionId, {
        reasoningEffort: input.reasoningEffort,
        updatedAt: nowIso(),
      });
    }
    const profile = this.profiles.getForSession(session);
    const prompt = hasInput(input)
      ? (input.message?.trim() ?? "")
      : session.prompt;
    const inputResume = resume ? interactionService.ready(sessionId) : null;
    let pendingResume =
      resume && !inputResume ? this.resume.resolvePendingRun(sessionId) : null;
    if (resume && !inputResume && !pendingResume)
      throw new AgentValidationError(
        "No pending runtime action is available to resume.",
      );
    const activeExecution = this.beginSessionExecution(sessionId, abortSignal);
    const runAbortSignal = activeExecution.signal;
    try {
      let run: AgentRun;
      let pendingPermission = pendingResume?.permission ?? null;
      let mcpWarmedUp = false;

      // Kick MCP warm-up eagerly. startServer dedupes concurrent starts, so the
      // awaited warm-up after step_started below usually resolves immediately
      // instead of serializing a cold spawn into first-token latency.
      void warmupMcpForSession(sessionId);

      logger.info(
        {
          sessionId,
          profileId: session.profileId,
          resume,
          model: input.model ?? null,
          prompt: truncateLogText(prompt),
        },
        "[agent-runtime] run starting",
      );

      if (inputResume) {
        const resolved = interactionService.consume(sessionId);
        if (!resolved)
          throw new AgentValidationError(
            "The input checkpoint was already consumed.",
          );
        run = this.store.getRun(resolved.runId);
        yield { type: "run_resumed", run };
        yield {
          type: "tool_result",
          runId: run.id,
          stepId: resolved.stepId,
          toolCall: this.store.getToolCall(sessionId, resolved.toolCallId),
        };
        if (["save", "cancel", "decline"].includes(resolved.response!.action)) {
          const saved = resolved.response!.action === "save";
          const cancelledPlan =
            resolved.kind === "plan_approval" &&
            resolved.response!.action === "cancel";
          const completed = saved || cancelledPlan;
          const reason = saved
            ? "Plan saved without execution."
            : cancelledPlan
              ? "Plan saved; immediate execution cancelled."
              : "User declined or cancelled the requested input.";
          const finished = this.store.updateRun(run.id, {
            status: completed ? "completed" : "blocked",
            completedAt: nowIso(),
            stopReason: reason,
          });
          this.store.updateSession(sessionId, {
            status: "completed",
            activeRunId: null,
            pendingResumeToken: null,
            completedAt: nowIso(),
            resultSummary: reason,
            blockedReason: completed ? null : reason,
          });
          if (!completed) {
            const g = getGoalState(
              this.store.getSession(sessionId).sessionMetadata,
            );
            if (g)
              this.store.updateSessionMetadata(sessionId, {
                goal: { ...g, status: "blocked", reason },
              });
          }
          yield completed
            ? { type: "run_completed", run: finished }
            : { type: "run_failed", run: finished, error: reason };
          yield { type: "done", sessionId, runId: run.id };
          return;
        }
        session = this.store.getSession(sessionId);
      } else if (resume) {
        if (!pendingResume)
          throw new AgentValidationError(
            "No pending runtime action is available to resume.",
          );
        run = this.store.updateRun(pendingResume.run.id, {
          status: "running",
          completedAt: null,
          stopReason: null,
          model: input.model ?? pendingResume.run.model,
        });
        this.store.updateSession(sessionId, {
          status: "running",
          updatedAt: nowIso(),
          blockedReason: null,
          completedAt: null,
          activeRunId: run.id,
          pendingResumeToken: null,
        });
        const resumedEvent = this.events.append({
          sessionId,
          type: "run_resumed",
          summary: "Run resumed from pending permission.",
          payload: {
            runId: run.id,
            stepId: pendingResume.step.id,
            permissionId: pendingResume.permission.id,
            toolCallId: pendingResume.toolCall?.id ?? null,
          },
        });
        logger.info(
          {
            sessionId,
            runId: run.id,
            stepId: pendingResume.step.id,
            permissionId: pendingResume.permission.id,
            toolCallId: pendingResume.toolCall?.id ?? null,
          },
          "[agent-runtime] run resumed from pending permission",
        );
        yield { type: "run_resumed", run, event: resumedEvent };
      } else {
        const inputMessageId = makeRuntimeId("msg");
        await captureCheckpoint(
          sessionId,
          "input",
          inputMessageId,
          null,
          input.acceptedRunId,
        );
        const userMessage = this.store.appendMessage({
          id: inputMessageId,
          sessionId,
          runId: input.acceptedRunId ?? null,
          stepId: null,
          role: "user",
          content: prompt,
          contentParts: input.contentParts,
          metadata: {
            requestId: acceptedInputRequestId(sessionId, input.acceptedRunId),
            references: input.references,
            source:
              input.messageSource === "system_injection"
                ? "system_injection"
                : hasInput(input)
                  ? "turn_request"
                  : "session_prompt",
          },
          createdAt: nowIso(),
        });
        yield { type: "message", message: userMessage };

        run = this.createRun(
          sessionId,
          userMessage.id,
          input.model ?? null,
          input.acceptedRunId,
        );
        const planBoundary = rootGoal(session).root.sessionMetadata?.plan as
          | PlanExecutionBoundary
          | undefined;
        if (planBoundary?.executionId)
          run = this.store.updateRun(run.id, {
            metadata: {
              ...run.metadata,
              goalExecutionId: planBoundary.executionId,
            },
          });
        this.store.updateSession(sessionId, {
          status: "running",
          updatedAt: nowIso(),
          blockedReason: null,
          activeRunId: run.id,
          pendingResumeToken: null,
          completedAt: null,
        });
        const startedEvent = this.events.append({
          sessionId,
          type: "run_started",
          summary: `${profile.label} run started`,
          payload: {
            runId: run.id,
            triggerMessageId: userMessage.id,
            model: input.model ?? null,
          },
        });
        logger.info(
          {
            sessionId,
            runId: run.id,
            triggerMessageId: userMessage.id,
            model: input.model ?? null,
          },
          "[agent-runtime] run started",
        );
        yield { type: "run_started", run, event: startedEvent };
        void sessionHooks.emit({
          type: "run:started",
          sessionId,
          runId: run.id,
        });
      }

      if (!resume) {
        const referenceContext =
          input.referenceContext ??
          prepareTurnReferences(sessionId, input.references);
        run = this.store.updateRun(run.id, {
          metadata: {
            ...this.store.getRun(run.id).metadata,
            turnReferences: referenceContext ?? null,
          },
        });
      }
      workRuntime.attach(sessionId, run);
      run = this.store.getRun(run.id);
      if (
        !resume &&
        input.messageSource !== "system_injection" &&
        synaxAgent.isSynaxSession(session)
      ) {
        const routed = synaxAgent.maybeAutoRoute(sessionId, prompt);
        if (routed) {
          session = this.store.getSession(sessionId);
        }
      }

      try {
        // Keep maxSteps readable for existing clients/profiles; it now controls only the prompt.
        const convergenceThreshold =
          input.maxSteps ??
          (run.metadata.convergenceThreshold as number | undefined) ??
          profile.maxSteps;
        run = this.store.updateRun(run.id, {
          metadata: { ...run.metadata, convergenceThreshold },
        });
        const context = session.contextSnapshotId
          ? this.tryGetContext(session.contextSnapshotId)
          : null;

        // Resolve model capabilities/context window/reasoning effort once for the run
        let modelCapabilities: { reasoning: boolean } | undefined;
        let runOutputReserve = input.maxTokens ?? 8192;
        let runContextLimit = DEFAULT_CONTEXT_LIMIT;
        let runReasoningEffort: ReasoningEffort =
          mapThinkingModeToReasoningEffort(session.thinkingMode);
        try {
          const selection = await resolveGatewaySelection({
            projectId: session.projectId,
            purpose: input.purpose ?? profile.kind,
            model: input.model ?? undefined,
          });
          modelCapabilities = {
            reasoning: selection.modelDef.reasoning ?? false,
          };
          runOutputReserve =
            input.maxTokens ?? selection.modelDef.maxTokens ?? 8192;
          if (
            typeof selection.modelDef.contextLimit === "number" &&
            selection.modelDef.contextLimit > 0
          ) {
            runContextLimit = selection.modelDef.contextLimit;
            // Persist the provider-configured window on the run: the usage bar
            // (`GET /sessions/:id/stats`) must render the configured context size
            // (e.g. the 1M toggle in provider settings) instead of whatever
            // window the provider happens to report in its usage payload.
            run = this.store.updateRun(run.id, {
              metadata: { ...run.metadata, contextLimit: runContextLimit },
            });
          }
          runReasoningEffort =
            input.reasoningEffort ??
            session.reasoningEffort ??
            readProviderDefaultReasoningEffort(selection.providerId) ??
            mapThinkingModeToReasoningEffort(session.thinkingMode);
        } catch {
          /* non-critical, proceed without capabilities */
        }
        input = { ...input, reasoningEffort: runReasoningEffort };
        run = this.store.updateRun(run.id, {
          metadata: { ...run.metadata, reasoningEffort: runReasoningEffort },
        });

        let currentPrompt = prompt;
        if (pendingResume?.permission.userReply) {
          this.appendSystemNotePart({
            runId: run.id,
            stepId: pendingResume.step.id,
            sessionId,
            content: `Permission reply: ${pendingResume.permission.userReply}`,
            toolCallId: pendingResume.permission.toolCallId,
            metadata: { permissionId: pendingResume.permission.id },
          });
        }
        if (
          pendingResume?.permission.action === "allow" &&
          pendingResume.toolCall
        ) {
          logger.info(
            {
              sessionId,
              runId: run.id,
              stepId: pendingResume.step.id,
              permissionId: pendingResume.permission.id,
              toolCallId: pendingResume.toolCall.id,
            },
            "[agent-runtime] resuming approved tool call",
          );
          const resumedToolExecution = await this.tools.resumePending(
            sessionId,
            pendingResume.permission,
            runAbortSignal,
          );
          this.appendToolResultPart({
            runId: run.id,
            stepId: pendingResume.step.id,
            sessionId,
            record: resumedToolExecution.record,
          });
          yield {
            type: "tool_result",
            runId: run.id,
            stepId: pendingResume.step.id,
            toolCall: resumedToolExecution.record,
          };
          pendingPermission = null;
          pendingResume = null;
        }

        rebuildSessionFileReads(
          sessionId,
          filterHistoryFileReads(
            sessionId,
            this.store.listToolCalls(sessionId),
          ),
        );

        let clearingActivated = false;

        while (true) {
          const terminalWork = workStore.current(sessionId);
          if (
            terminalWork &&
            ["completed", "cancelled"].includes(terminalWork.status)
          ) {
            yield* this.finishWorkRun(sessionId, run);
            return;
          }
          const liveSession = this.store.getSession(sessionId);
          if (["interrupted", "cancelled"].includes(liveSession.status)) {
            this.interruptSessions([sessionId], "Session stopped by user.");
            throw new Error("Session stopped by user.");
          }
          const stopReason = goalStopReason(this.store.getSession(sessionId));
          if (stopReason) {
            yield* this.finishControlledGoal(sessionId, run, stopReason);
            return;
          }
          if (runAbortSignal.aborted) {
            throw new AgentRuntimeError(
              "Run interrupted by client.",
              "ABORTED",
              499,
            );
          }
          if (this.store.getRun(run.id).metadata.roundHandoff) {
            yield* this.finishYieldedRun(sessionId, run);
            return;
          }

          run = this.store.updateRun(run.id, {
            currentStep: run.currentStep + 1,
          });
          const step = this.store.appendRunStep({
            id: makeRuntimeId("stp"),
            runId: run.id,
            sessionId,
            index: run.currentStep,
            status: "running",
            model: input.model ?? null,
            startedAt: nowIso(),
            completedAt: null,
            finishReason: null,
            metadata: {
              contextProjectionVersion: 2,
              contextReceiptEnabled: false,
              reasoningEffort: input.reasoningEffort,
              workId: workStore.current(sessionId)?.id,
              workChangeVersion: workStore.current(sessionId)?.changeVersion,
              converging: shouldConverge(run.currentStep, convergenceThreshold),
            },
          });
          const workVersionBeforeStep =
            workStore.current(sessionId)?.progressVersion ?? 0;
          const stepStarted = this.events.append({
            sessionId,
            type: "step_started",
            summary: `Step ${step.index} started`,
            payload: { runId: run.id, stepId: step.id, index: step.index },
          });
          logger.info(
            {
              sessionId,
              runId: run.id,
              stepId: step.id,
              stepIndex: step.index,
              convergenceThreshold,
            },
            "[agent-runtime] step started",
          );
          yield { type: "step_started", step, event: stepStarted };
          emitSessionLive(sessionId, {
            type: "step_started",
            stepId: step.id,
            stepIndex: step.index,
            modelCapabilities,
          });
          if (!mcpWarmedUp) {
            mcpWarmedUp = true;
            // Tool schemas are read by generateStep below, so MCP must be warm
            // before the model call — but a cold spawn must not sit between run
            // admission and the step_started handoff the client renders.
            await warmupMcpForSession(sessionId);
          }

          const history = this.store
            .listMessages(sessionId)
            .filter(
              (message) =>
                message.role === "user" || message.role === "assistant",
            );
          const previousToolCalls = this.store.listRunToolCalls(run.id);
          const previousSteps = this.store.listRunSteps(run.id);
          const previousStep =
            previousSteps.find(
              (candidate) => candidate.index === step.index - 1,
            ) ?? null;
          const previousStepParts = previousStep
            ? this.store.listRunParts(previousStep.id)
            : [];

          let modelResult: LoopStepModelResult | null = null;
          let stepForceInjectRequested = false;
          void sessionHooks.emit({
            type: "step:before",
            sessionId,
            runId: run.id,
            stepIndex: step.index,
          });
          for await (const event of coalesceLoopDeltas(
            (stepSignal) =>
              this.generateStep({
                sessionId,
                stepId: step.id,
                prompt: currentPrompt,
                input,
                profile,
                context,
                history,
                previousParts: previousStepParts,
                previousToolCalls,
                stepIndex: step.index,
                maxSteps: convergenceThreshold,
                converging: shouldConverge(step.index, convergenceThreshold),
                blockedByPermission: pendingPermission?.userReply === "reject",
                previousStepUsage: previousStep?.metadata?.usage as
                  | Record<string, unknown>
                  | undefined,
                abortSignal: stepSignal,
                clearingActivated,
                contextLimit: runContextLimit,
                outputReserve: runOutputReserve,
              }),
            runAbortSignal,
          )) {
            if (inputQueueService.getForceInjectId(sessionId)) {
              stepForceInjectRequested = true;
              break;
            }
            if (event.type === "context_composition") {
              this.store.updateRunStep(step.id, {
                metadata: {
                  ...this.store.getRunStep(step.id).metadata,
                  contextComposition: event.composition,
                },
              });
              const contextEvent = this.events.append({
                sessionId,
                type: "progress_updated",
                visibility: "internal",
                summary: "Request context composition updated",
                payload: {
                  kind: "context_composition",
                  runId: run.id,
                  stepId: step.id,
                },
              });
              yield { type: "event", event: contextEvent };
            }
            if (event.type === "retry_status") {
              this.store.updateRunStep(step.id, {
                metadata: {
                  ...this.store.getRunStep(step.id).metadata,
                  retry: event.retry.phase === "recovered" ? null : event.retry,
                },
              });
              const retryEvent = this.events.append({
                sessionId,
                type: "progress_updated",
                visibility: "internal",
                summary: `LLM ${event.retry.reason}: ${event.retry.phase} (${event.retry.group}/${event.retry.attempt}/${event.retry.maxRetries})`,
                payload: {
                  kind: "llm_retry",
                  runId: run.id,
                  stepId: step.id,
                  retry: event.retry,
                },
              });
              yield {
                type: "retry_status",
                runId: run.id,
                stepId: step.id,
                retry: event.retry,
                event: retryEvent,
              };
              emitSessionLive(sessionId, {
                type: "retry_status",
                stepId: step.id,
                retry: event.retry,
              });
            }
            if (event.type === "usage") {
              this.store.updateRunStep(step.id, {
                metadata: {
                  ...this.store.getRunStep(step.id).metadata,
                  usage: event.usage,
                },
              });
            }
            if (event.type === "thought_delta") {
              const evt = this.events.append({
                sessionId,
                type: "thought_delta",
                summary: event.delta,
                payload: { runId: run.id, stepId: step.id, delta: event.delta },
                visibility: "internal",
              });
              yield {
                type: "thought_delta",
                runId: run.id,
                stepId: step.id,
                delta: event.delta,
                event: evt,
              };
              emitSessionLive(sessionId, {
                type: "thought_delta",
                stepId: step.id,
                delta: event.delta,
              });
            }
            if (event.type === "text_delta") {
              const evt = this.events.append({
                sessionId,
                type: "message_delta",
                summary: event.delta,
                payload: { runId: run.id, stepId: step.id, delta: event.delta },
                visibility: "user_visible",
              });
              yield {
                type: "message_delta",
                runId: run.id,
                stepId: step.id,
                delta: event.delta,
                event: evt,
              };
              emitSessionLive(sessionId, {
                type: "message_delta",
                stepId: step.id,
                delta: event.delta,
              });
            }
            if (event.type === "step_complete") {
              modelResult = { model: event.model, step: event.step };
            }
            if (event.type === "context_compacted") {
              const compactEvt = this.events.append({
                sessionId,
                type: "progress_updated",
                summary: `Context compacted: ${event.originalTokens} → ${event.compressedTokens} tokens`,
                payload: {
                  kind: "compaction",
                  originalTokens: event.originalTokens,
                  compressedTokens: event.compressedTokens,
                  messageCount: event.messageCount,
                },
              });
              yield {
                type: "context_compacted",
                runId: run.id,
                stepId: step.id,
                originalTokens: event.originalTokens,
                compressedTokens: event.compressedTokens,
                messageCount: event.messageCount,
                event: compactEvt,
              };
              emitSessionLive(sessionId, {
                type: "context_compacted",
                stepId: step.id,
                originalTokens: event.originalTokens,
                compressedTokens: event.compressedTokens,
                messageCount: event.messageCount,
              });
            }
          }

          if (stepForceInjectRequested) {
            this.store.updateRunStep(step.id, {
              status: "interrupted",
              completedAt: nowIso(),
              finishReason: "input_force_inject",
            });
            await captureCompletedReply(sessionId, step.id);
            void sessionHooks.emit({
              type: "step:after",
              sessionId,
              runId: run.id,
              stepIndex: step.index,
            });
            const forced = await this.injectQueuedInput(sessionId, run);
            if (forced) {
              yield {
                type: "input_injected",
                message: forced.userMessage,
                queueItemId: forced.queueItemId,
              };
              currentPrompt = forced.message;
              if (forced.model) {
                input = { ...input, model: forced.model };
              }
            }
            continue;
          }

          if (!modelResult) {
            throw new AgentRuntimeError(
              "Model step produced no result.",
              "INTERNAL",
              500,
            );
          }

          this.store.updateRunStep(step.id, {
            metadata: {
              ...this.store.getRunStep(step.id).metadata,
              usage: modelResult.step.usage,
              reasoningParts: modelResult.step.reasoningParts,
              providerMetadata: modelResult.step.providerMetadata,
              sources: modelResult.step.sources,
              toolCallProviderMetadata:
                modelResult.step.toolCallProviderMetadata,
              protocol: modelResult.step.protocol,
            },
          });
          const stepUsage = modelResult.step.usage as
            | Record<string, unknown>
            | undefined;
          if (
            !clearingActivated &&
            typeof stepUsage?.inputTokens === "number"
          ) {
            const stepContextLimit = runContextLimit;
            if (
              (stepUsage.inputTokens as number) >
              stepContextLimit * CONTEXT_TOOL_CLEAR_THRESHOLD
            ) {
              clearingActivated = true;
            }
          }

          const willEmitFinalAssistantMessage =
            pendingPermission?.userReply === "reject" ||
            modelResult.step.toolCalls.length === 0 ||
            modelResult.step.final;
          await this.persistStepOutput(
            run.id,
            step.id,
            sessionId,
            modelResult.step,
            { skipAssistantText: willEmitFinalAssistantMessage },
          );
          logger.info(
            {
              sessionId,
              runId: run.id,
              stepId: step.id,
              stepIndex: step.index,
              model: modelResult.model,
              final: modelResult.step.final,
              finishReason: modelResult.step.finishReason ?? null,
              stopReason: modelResult.step.stopReason ?? null,
              thought: truncateLogText(modelResult.step.thought ?? ""),
              message: truncateLogText(modelResult.step.message ?? ""),
              toolCalls: modelResult.step.toolCalls.map((call) => ({
                id: call.id,
                toolId: call.toolId,
                reason: truncateLogText(call.reason ?? ""),
              })),
            },
            "[agent-runtime] model step completed",
          );
          if (pendingPermission?.userReply === "reject") {
            const blockedSummary =
              modelResult.step.message?.trim() || pendingPermission.reason;
            logger.warn(
              {
                sessionId,
                runId: run.id,
                stepId: step.id,
                permissionId: pendingPermission.id,
                reason: pendingPermission.reason,
              },
              "[agent-runtime] run blocked by rejected permission",
            );
            const assistantMessage = this.finishAssistantMessage(
              sessionId,
              run.id,
              step.id,
              blockedSummary,
              modelResult.model,
              input.purpose ?? profile.kind,
              modelResult.step.usage,
              modelResult.step.sources,
            );
            const completedStep = this.store.updateRunStep(step.id, {
              status: "blocked",
              completedAt: nowIso(),
              finishReason:
                modelResult.step.finishReason ?? "permission_rejected",
              metadata: {
                ...this.store.getRunStep(step.id).metadata,
                usage: modelResult.step.usage,
              },
            });
            await captureCompletedReply(sessionId, step.id);
            void sessionHooks.emit({
              type: "step:after",
              sessionId,
              runId: run.id,
              stepIndex: step.index,
            });
            const blockedRun = this.store.updateRun(run.id, {
              status: "blocked",
              completedAt: nowIso(),
              stopReason: pendingPermission.reason,
            });
            this.store.updateSession(sessionId, {
              status: "completed",
              updatedAt: nowIso(),
              completedAt: nowIso(),
              resultSummary: blockedSummary,
              blockedReason: pendingPermission.reason,
              activeRunId: null,
              pendingResumeToken: null,
            });
            const event = this.events.append({
              sessionId,
              type: "run_failed",
              summary: pendingPermission.reason,
              payload: {
                runId: blockedRun.id,
                stepId: completedStep.id,
                stopReason: pendingPermission.reason,
              },
            });
            yield { type: "message", message: assistantMessage };
            yield {
              type: "run_failed",
              run: blockedRun,
              error: pendingPermission.reason,
              event,
            };
            yield { type: "done", sessionId, runId: blockedRun.id };
            return;
          }

          if (
            modelResult.step.toolCalls.length === 0 &&
            inputQueueService.getForceInjectId(sessionId)
          ) {
            const injected = await this.injectQueuedInput(sessionId, run);
            if (injected) {
              this.store.updateRunStep(step.id, {
                status: "completed",
                completedAt: nowIso(),
                finishReason: "input_injected",
              });
              await captureCompletedReply(sessionId, step.id);
              void sessionHooks.emit({
                type: "step:after",
                sessionId,
                runId: run.id,
                stepIndex: step.index,
              });
              yield {
                type: "input_injected",
                message: injected.userMessage,
                queueItemId: injected.queueItemId,
              };
              currentPrompt = injected.message;
              if (injected.model) input = { ...input, model: injected.model };
              continue;
            }
          }
          if (
            modelResult.step.toolCalls.length === 0 &&
            workStore.current(sessionId)
          ) {
            const finalText =
              modelResult.step.message?.trim() ||
              (modelResult.step.contentParts?.length
                ? "Generated media is attached."
                : undefined);
            try {
              if (!finalText)
                throw new AgentValidationError(
                  "An empty response is not a final result.",
                );
              if (
                usesGoalWorkflow(this.store.getSession(sessionId)) &&
                shouldConverge(step.index, convergenceThreshold)
              ) {
                workRuntime.yieldRound(
                  {
                    sessionId,
                    runId: run.id,
                    stepId: step.id,
                    toolCallId: "",
                    toolId: "runtime.final",
                    category: "task",
                    mutability: "task",
                    args: {},
                  },
                  finalText,
                );
                this.store.updateRunStep(step.id, {
                  status: "completed",
                  completedAt: nowIso(),
                  finishReason: "round_yielded",
                });
                await captureCompletedReply(sessionId, step.id);
                void sessionHooks.emit({
                  type: "step:after",
                  sessionId,
                  runId: run.id,
                  stepIndex: step.index,
                });
                yield* this.finishYieldedRun(sessionId, run);
                return;
              }
              const result = await workRuntime.complete(
                {
                  sessionId,
                  runId: run.id,
                  stepId: step.id,
                  toolCallId: "",
                  toolId: "runtime.final",
                  category: "task",
                  mutability: "task",
                  args: {},
                },
                finalText,
              );
              this.store.updateRunStep(step.id, {
                status: "completed",
                completedAt: nowIso(),
                finishReason: "work_completion",
              });
              if (result.suspend) {
                yield { type: "done", sessionId, runId: run.id };
                return;
              }
              if (this.store.getRun(run.id).metadata.roundHandoff)
                yield* this.finishYieldedRun(sessionId, run);
              else yield* this.finishWorkRun(sessionId, run);
              return;
            } catch (error) {
              const work = workRuntime.rejectedCompletion(
                sessionId,
                error instanceof Error ? error.message : String(error),
              );
              this.store.updateRunStep(step.id, {
                status: "completed",
                completedAt: nowIso(),
                finishReason: "work_closing",
              });
              currentPrompt =
                work?.reason ??
                "The final answer was rejected; fix the gap before finishing again.";
              continue;
            }
          }
          if (modelResult.step.toolCalls.length === 0) {
            const finalText =
              modelResult.step.message?.trim() || "Run completed.";
            logger.info(
              {
                sessionId,
                runId: run.id,
                stepId: step.id,
                stepIndex: step.index,
                summary: truncateLogText(finalText),
              },
              "[agent-runtime] run completed in step",
            );
            const assistantMessage = this.finishAssistantMessage(
              sessionId,
              run.id,
              step.id,
              finalText,
              modelResult.model,
              input.purpose ?? profile.kind,
              modelResult.step.usage,
              modelResult.step.sources,
            );
            persistInlineVisualization(assistantMessage, runAbortSignal);
            const completedStep = this.store.updateRunStep(step.id, {
              status: "completed",
              completedAt: nowIso(),
              finishReason:
                modelResult.step.finishReason ??
                modelResult.step.stopReason ??
                "stop",
              metadata: {
                ...this.store.getRunStep(step.id).metadata,
                usage: modelResult.step.usage,
              },
            });
            await captureCompletedReply(sessionId, step.id);
            void sessionHooks.emit({
              type: "step:after",
              sessionId,
              runId: run.id,
              stepIndex: step.index,
            });
            const completedRun = this.store.updateRun(run.id, {
              status: "completed",
              completedAt: nowIso(),
              stopReason: modelResult.step.stopReason ?? "completed",
              model: modelResult.model,
            });
            this.store.updateSession(sessionId, {
              status: "completed",
              updatedAt: nowIso(),
              completedAt: nowIso(),
              resultSummary: finalText,
              blockedReason: null,
              activeRunId: null,
              pendingResumeToken: null,
            });
            const completedEvent = this.events.append({
              sessionId,
              type: "run_completed",
              summary: finalText,
              payload: {
                runId: completedRun.id,
                stepId: completedStep.id,
                messageId: assistantMessage.id,
                stopReason: completedRun.stopReason,
              },
            });
            yield { type: "message", message: assistantMessage };
            yield {
              type: "run_completed",
              run: completedRun,
              message: assistantMessage,
              event: completedEvent,
            };
            yield { type: "done", sessionId, runId: completedRun.id };
            return;
          }

          if (inputQueueService.getForceInjectId(sessionId)) {
            this.store.updateRunStep(step.id, {
              status: "interrupted",
              completedAt: nowIso(),
              finishReason: "input_force_inject",
            });
            await captureCompletedReply(sessionId, step.id);
            void sessionHooks.emit({
              type: "step:after",
              sessionId,
              runId: run.id,
              stepIndex: step.index,
            });
            const forced = await this.injectQueuedInput(sessionId, run);
            if (forced) {
              yield {
                type: "input_injected",
                message: forced.userMessage,
                queueItemId: forced.queueItemId,
              };
              currentPrompt = forced.message;
              if (forced.model) {
                input = { ...input, model: forced.model };
              }
            }
            continue;
          }

          let waitingPermission = null as null | {
            permission: NonNullable<typeof pendingPermission>;
            record: ToolCallRecord;
          };
          const batchError = validateControlBatch(modelResult.step.toolCalls);
          const calls = batchError
            ? modelResult.step.toolCalls.map((c) => ({
                ...c,
                toolId: INVALID_TOOL_ID,
                args: { tool: c.toolId, error: batchError },
              }))
            : modelResult.step.toolCalls;
          const allCalls = withIds(calls.slice(0, 50));

          // Build dedup index from previous steps — same tool + same args on a
          // read-only tool is needless re-execution that burns context.  Fold it.
          // However, if the original output has been cleared from context, the LLM
          // legitimately needs the data again — skip those from the dedup index.
          const clearedIds = evictedContextToolIds(sessionId);
          const clearedToolOutputs = computeClearedToolCallIds(
            this.store,
            sessionId,
            {
              contextLimit: runContextLimit,
              threshold: CONTEXT_TOOL_CLEAR_THRESHOLD,
              keepRecent: CONTEXT_TOOL_CLEAR_KEEP_RECENT,
              excludeTools: CONTEXT_TOOL_CLEAR_EXCLUDE,
              priorInputTokens: null,
              forceActivated: clearingActivated,
            },
          );
          for (const id of clearedToolOutputs ?? []) clearedIds.add(id);

          const dedupIndex = new Map<string, ToolCallRecord>();
          for (const prev of this.store.listRunToolCalls(run.id)) {
            const boundary = rootGoal(this.store.getSession(sessionId)).root
              .sessionMetadata?.plan as PlanExecutionBoundary | undefined;
            if (
              boundary?.executionId &&
              !belongsToPlanExecution(prev, boundary)
            )
              continue;
            if (prev.status === "completed" || prev.status === "compacted") {
              // Don't dedup against calls whose output was cleared from context
              if (clearedIds.has(prev.id)) continue;
              if (
                prev.stepId &&
                this.store.getRunStep(prev.stepId).metadata
                  .workChangeVersion !==
                  workStore.current(sessionId)?.changeVersion
              )
                continue;
              dedupIndex.set(`${prev.toolId}:${prev.argsHash}`, prev);
            }
          }

          // Unified parallel: launch all tool calls concurrently, no arbitrary cap.
          // The LLM already determined these calls are independent when it emitted
          // them together. If a write depends on a read, the LLM should call the
          // read in step N and the write in step N+1.
          const executions = await Promise.all(
            allCalls.map(async (call) => {
              const tool = this.tools.list().find((t) => t.id === call.toolId);
              if (
                this.store.getRunStep(step.id).metadata.source !==
                  "turn_reference" &&
                tool?.mutability === "read" &&
                !["bash", "verification.run", "context.read"].includes(
                  tool.id,
                ) &&
                tool.category !== "mcp"
              ) {
                const argsHash = this.store.hashArgs(call.args);
                const prev = dedupIndex.get(`${call.toolId}:${argsHash}`);
                if (prev) {
                  // Safety valve: if the same call has already been deduped 2+ times
                  // in this run, the LLM clearly can't see the original result (likely
                  // cleared or compacted away). Re-execute instead of deduping again.
                  const priorDedups = this.store
                    .listRunToolCalls(run.id)
                    .filter(
                      (tc) =>
                        tc.toolId === call.toolId &&
                        tc.argsHash === argsHash &&
                        tc.status === "compacted" &&
                        tc.outputRef === null,
                    ).length;
                  if (priorDedups >= 2) {
                    logger.info(
                      {
                        sessionId,
                        runId: run.id,
                        stepId: step.id,
                        toolId: call.toolId,
                        argsHash,
                        priorDedups,
                      },
                      "[agent-runtime] dedup safety valve — re-executing after repeated dedup misses",
                    );
                    return this.tools
                      .execute(sessionId, call.toolId, call.args, {
                        runId: run.id,
                        stepId: step.id,
                        modelToolCallId: call.id,
                        resumeToken: optionsResumeToken(
                          run.id,
                          step.id,
                          call.id,
                        ),
                        abortSignal: runAbortSignal,
                      })
                      .then((exec) => ({ call, exec }));
                  }

                  logger.info(
                    {
                      sessionId,
                      runId: run.id,
                      stepId: step.id,
                      toolId: call.toolId,
                      argsHash,
                      originalCallId: prev.id,
                    },
                    "[agent-runtime] tool call deduplicated",
                  );
                  const dedupRecord = this.store.appendToolCall({
                    id: makeRuntimeId("tc"),
                    sessionId,
                    runId: run.id,
                    stepId: step.id,
                    modelToolCallId: call.id,
                    toolId: call.toolId,
                    category: tool.category,
                    mutability: tool.mutability,
                    argsHash,
                    inputSummary: prev.inputSummary,
                    inputRef: call.toolId === "skill.load" ? call.args : null,
                    outputSummary: `[Duplicate of earlier ${call.toolId} call — the result is already in your context above. Re-read what you received earlier instead of calling again.]`,
                    outputRef: null,
                    status: "compacted",
                    permissionDecisionId: null,
                    startedAt: nowIso(),
                    endedAt: nowIso(),
                    error: null,
                  });
                  return { call, exec: { record: dedupRecord } };
                }
              }

              return this.tools
                .execute(sessionId, call.toolId, call.args, {
                  runId: run.id,
                  stepId: step.id,
                  modelToolCallId: call.id,
                  resumeToken: optionsResumeToken(run.id, step.id, call.id),
                  abortSignal: runAbortSignal,
                })
                .then((exec) => ({ call, exec }));
            }),
          );

          // Emit tool_call events in model-dictated order (allCalls order)
          for (const { call, exec } of executions) {
            this.appendToolCallPart({
              runId: run.id,
              stepId: step.id,
              sessionId,
              record: exec.record,
              reason: call.reason,
            });
            yield {
              type: "tool_call",
              runId: run.id,
              stepId: step.id,
              toolCall: exec.record,
              event: this.events.append({
                sessionId,
                type: "tool_call",
                summary: `${call.toolId} requested`,
                payload: {
                  runId: run.id,
                  stepId: step.id,
                  toolCallId: exec.record.id,
                  modelToolCallId: call.id,
                },
              }),
            };
            emitSessionLive(sessionId, {
              type: "tool_call",
              stepId: step.id,
              toolCall: exec.record,
            });
            logger.info(
              {
                sessionId,
                runId: run.id,
                stepId: step.id,
                toolCallId: exec.record.id,
                toolId: call.toolId,
                status: exec.record.status,
                permissionAction: exec.permission?.action ?? null,
              },
              "[agent-runtime] tool call executed",
            );
          }

          const interactionExec = executions.find(
            ({ exec }) => exec.interactionId,
          );
          if (interactionExec) {
            const event = this.events.append({
              sessionId,
              type: "interaction_requested",
              summary: "Waiting for user input.",
              payload: {
                interactionId: interactionExec.exec.interactionId,
                runId: run.id,
                stepId: step.id,
              },
            });
            yield { type: "event", event };
            yield { type: "done", sessionId, runId: run.id };
            return;
          }

          // Check for permission "ask" — pause at the first one in model order.
          // If any tool needs user approval, we persist results for tools that
          // completed BEFORE it and yield a permission_requested event.
          const askIndex = executions.findIndex(
            ({ exec }) => exec.permission?.action === "ask",
          );

          if (askIndex >= 0) {
            const askExec = executions[askIndex];
            waitingPermission = {
              permission: askExec.exec.permission!,
              record: askExec.exec.record,
            };
            logger.info(
              {
                sessionId,
                runId: run.id,
                stepId: step.id,
                permissionId: askExec.exec.permission!.id,
                toolCallId: askExec.exec.record.id,
                reason: truncateLogText(askExec.exec.permission!.reason),
              },
              "[agent-runtime] permission requested",
            );

            // Emit tool_result for tools that completed BEFORE the ask-point (model order)
            for (let i = 0; i < askIndex; i++) {
              const { call, exec } = executions[i];
              const completedRecord =
                call.toolId === "subagent.delegate" && exec.toolResult?.result
                  ? await this.awaitTaskResult(
                      exec.record,
                      exec.toolResult.result,
                      runAbortSignal,
                    )
                  : exec.record;
              this.appendToolResultPart({
                runId: run.id,
                stepId: step.id,
                sessionId,
                record: completedRecord,
              });
              if (completedRecord.status === "denied") {
                logger.warn(
                  {
                    sessionId,
                    runId: run.id,
                    stepId: step.id,
                    toolCallId: completedRecord.id,
                    toolId: call.toolId,
                  },
                  "[agent-runtime] tool call denied",
                );
              }
              logger.info(
                {
                  sessionId,
                  runId: run.id,
                  stepId: step.id,
                  toolCallId: completedRecord.id,
                  toolId: call.toolId,
                  status: completedRecord.status,
                  outputSummary: truncateLogText(
                    completedRecord.outputSummary ??
                      completedRecord.error ??
                      "",
                  ),
                },
                "[agent-runtime] tool result recorded",
              );
              yield {
                type: "tool_result",
                runId: run.id,
                stepId: step.id,
                toolCall: completedRecord,
              };
              emitSessionLive(sessionId, {
                type: "tool_result",
                stepId: step.id,
                toolCall: completedRecord,
              });
            }
          } else {
            // No permission issues — resolve subagent delegation results in parallel,
            // then emit tool_result events in model-dictated order.
            const resolved = await Promise.all(
              executions.map(({ call, exec }) =>
                call.toolId === "subagent.delegate" && exec.toolResult?.result
                  ? this.awaitTaskResult(
                      exec.record,
                      exec.toolResult.result,
                      runAbortSignal,
                    )
                  : Promise.resolve(exec.record),
              ),
            );

            for (let i = 0; i < resolved.length; i++) {
              const completedRecord = resolved[i];
              const { call } = executions[i];
              this.appendToolResultPart({
                runId: run.id,
                stepId: step.id,
                sessionId,
                record: completedRecord,
              });
              if (completedRecord.status === "denied") {
                logger.warn(
                  {
                    sessionId,
                    runId: run.id,
                    stepId: step.id,
                    toolCallId: completedRecord.id,
                    toolId: call.toolId,
                  },
                  "[agent-runtime] tool call denied",
                );
              }
              logger.info(
                {
                  sessionId,
                  runId: run.id,
                  stepId: step.id,
                  toolCallId: completedRecord.id,
                  toolId: call.toolId,
                  status: completedRecord.status,
                  outputSummary: truncateLogText(
                    completedRecord.outputSummary ??
                      completedRecord.error ??
                      "",
                  ),
                },
                "[agent-runtime] tool result recorded",
              );
              yield {
                type: "tool_result",
                runId: run.id,
                stepId: step.id,
                toolCall: completedRecord,
              };
              emitSessionLive(sessionId, {
                type: "tool_result",
                stepId: step.id,
                toolCall: completedRecord,
              });
            }
          }

          const completedStep = this.store.updateRunStep(step.id, {
            status: waitingPermission ? "waiting_permission" : "completed",
            completedAt: nowIso(),
            finishReason: waitingPermission
              ? "permission_required"
              : (modelResult.step.finishReason ?? "tool_calls"),
            model: modelResult.model,
            metadata: {
              ...this.store.getRunStep(step.id).metadata,
              usage: modelResult.step.usage,
            },
          });
          await captureCompletedReply(sessionId, step.id);
          void sessionHooks.emit({
            type: "step:after",
            sessionId,
            runId: run.id,
            stepIndex: step.index,
          });

          if (waitingPermission) {
            const resumedRun = this.store.updateRun(run.id, {
              status: "waiting_permission",
              stopReason: waitingPermission.permission.reason,
              model: modelResult.model,
            });
            this.store.updateSession(sessionId, {
              status: "waiting_permission",
              updatedAt: nowIso(),
              blockedReason: waitingPermission.permission.reason,
              resultSummary: waitingPermission.permission.reason,
              activeRunId: resumedRun.id,
              pendingResumeToken: waitingPermission.permission.resumeToken,
            });
            const permissionEvent = this.events.append({
              sessionId,
              type: "permission_requested",
              summary: waitingPermission.permission.reason,
              payload: {
                runId: resumedRun.id,
                stepId: completedStep.id,
                permissionId: waitingPermission.permission.id,
                toolCallId: waitingPermission.record.id,
              },
            });
            logger.info(
              {
                sessionId,
                runId: resumedRun.id,
                stepId: completedStep.id,
                permissionId: waitingPermission.permission.id,
                toolCallId: waitingPermission.record.id,
              },
              "[agent-runtime] waiting for permission",
            );
            yield {
              type: "permission_requested",
              runId: resumedRun.id,
              stepId: completedStep.id,
              permission: waitingPermission.permission,
              toolCall: waitingPermission.record,
              event: permissionEvent,
            };
            yield { type: "done", sessionId, runId: resumedRun.id };
            return;
          }

          if (this.store.getRun(run.id).metadata.roundHandoff) {
            yield* this.finishYieldedRun(sessionId, run);
            return;
          }
          workRuntime.afterStep(sessionId, step.id, workVersionBeforeStep);
          const afterWork = workStore.current(sessionId);
          if (
            afterWork &&
            ["completed", "blocked", "cancelled"].includes(afterWork.status)
          ) {
            yield* this.finishWorkRun(sessionId, run);
            return;
          }
          const doomLoop = workStore.current(sessionId)
            ? null
            : detectDoomLoop(
                this.store.listRunToolCalls(run.id),
                profile?.doomLoopThreshold,
              );
          if (doomLoop) {
            const note = `Repeated tool call detected for ${doomLoop.toolId} with identical arguments. Change approach or report the blocker; converge to an honest status report without repeating unchanged calls.`;
            logger.warn(
              {
                sessionId,
                runId: run.id,
                stepId: step.id,
                toolCallId: doomLoop.id,
                toolId: doomLoop.toolId,
                argsHash: doomLoop.argsHash,
              },
              "[agent-runtime] doom loop detected",
            );
            this.store.appendRunPart({
              id: makeRuntimeId("prt"),
              runId: run.id,
              stepId: step.id,
              sessionId,
              kind: "system_note",
              sequence: this.store.nextRunPartSequence(step.id),
              content: note,
              toolCallId: doomLoop.id,
              metadata: { guard: "doom_loop" },
              createdAt: nowIso(),
            });
          }

          currentPrompt = prompt;
          pendingPermission = null;

          if (inputQueueService.getForceInjectId(sessionId)) {
            const injected = await this.injectQueuedInput(sessionId, run);
            if (injected) {
              yield {
                type: "input_injected",
                message: injected.userMessage,
                queueItemId: injected.queueItemId,
              };
              currentPrompt = injected.message;
              if (injected.model) {
                input = { ...input, model: injected.model };
              }
            }
          }
        }
      } catch (error) {
        const committedWork = workStore.current(sessionId);
        if (committedWork?.status === "completed") {
          yield* this.finishWorkRun(sessionId, run);
          return;
        }
        for (const step of this.store.listRunSteps(run.id)) {
          if (step.status === "running")
            this.store.updateRunStep(step.id, {
              status: "interrupted",
              completedAt: nowIso(),
              finishReason: "interrupted",
            });
        }
        if (
          error instanceof AgentRuntimeError &&
          [
            "UNSUPPORTED_MEDIA",
            "MEDIA_CAPABILITY_UNKNOWN",
            "MEDIA_TOO_LARGE",
            "MEDIA_NOT_FOUND",
            "MEDIA_CHANGED",
          ].includes(error.code)
        ) {
          const message = error.message;
          this.store.updateRun(run.id, {
            status: "blocked",
            completedAt: nowIso(),
            stopReason: message,
          });
          const completedAt = nowIso();
          this.store.updateSession(sessionId, {
            status: "completed",
            updatedAt: completedAt,
            completedAt,
            resultSummary: message,
            blockedReason: message,
            activeRunId: null,
            pendingResumeToken: null,
          });
          yield {
            type: "run_failed",
            run: this.store.getRun(run.id),
            error: message,
          };
          yield { type: "done", sessionId, runId: run.id };
          return;
        }
        if (
          error instanceof Error &&
          error.message.startsWith("context_blocked:") &&
          committedWork
        ) {
          committedWork.status = "waiting";
          committedWork.reason = error.message;
          workStore.save(committedWork);
          yield* this.finishWorkRun(sessionId, run);
          return;
        }
        const abortReason =
          runAbortSignal.aborted && "reason" in runAbortSignal
            ? (runAbortSignal as AbortSignal & { reason?: unknown }).reason
            : undefined;
        const message = mediaSafeErrorText(
          abortReason instanceof Error
            ? abortReason.message
            : typeof abortReason === "string"
              ? abortReason
              : error instanceof Error
                ? error.message
                : String(error),
        );
        const responseBody =
          (error as any)?.responseBody ?? (error as any)?.data ?? undefined;
        const statusCode =
          (error as any)?.statusCode ?? (error as any)?.status ?? undefined;
        logger.error(
          {
            sessionId,
            runId: run.id,
            aborted: Boolean(runAbortSignal.aborted),
            err: {
              name: error instanceof Error ? error.name : undefined,
              message,
            },
            statusCode,
            responseBody:
              responseBody === undefined
                ? undefined
                : mediaSafeErrorText(
                    typeof responseBody === "string"
                      ? responseBody
                      : JSON.stringify(responseBody),
                  ).slice(0, 1000),
          },
          "[agent-runtime] run failed",
        );
        const isAbort = Boolean(runAbortSignal.aborted);
        const failedRun = this.store.updateRun(run.id, {
          status: isAbort ? "interrupted" : "failed",
          completedAt: nowIso(),
          stopReason: message,
        });

        const sessionStatus: AgentSession["status"] = isAbort
          ? "interrupted"
          : "failed";

        this.store.updateSession(sessionId, {
          status: sessionStatus,
          updatedAt: nowIso(),
          completedAt: sessionStatus === "failed" ? nowIso() : null,
          blockedReason: message,
          resultSummary: message,
          activeRunId: null,
          pendingResumeToken: null,
        });
        const failedEvent = this.events.append({
          sessionId,
          type: "run_failed",
          summary: message,
          payload: {
            runId: failedRun.id,
            error: message,
            resumable: sessionStatus !== "failed",
          },
        });
        yield {
          type: "run_failed",
          run: failedRun,
          error: message,
          event: failedEvent,
        };
        yield { type: "done", sessionId, runId: failedRun.id };
      } finally {
        if (run) {
          for (const step of this.store.listRunSteps(run.id)) {
            if (step.status === "running")
              this.store.updateRunStep(step.id, {
                status: "interrupted",
                completedAt: nowIso(),
                finishReason: "run_ended",
              });
          }
          try {
            await captureCompletedReply(sessionId);
            const finalRun = this.store.getRun(run.id);
            void sessionHooks.emit({
              type: "run:completed",
              sessionId,
              runId: run.id,
              status: finalRun.status,
            });
          } catch {
            /* run may not exist if creation failed */
          }
        }
      }
    } finally {
      activeExecution.dispose();
    }
  }

  private async *finishWorkRun(
    sessionId: string,
    run: AgentRun,
  ): AsyncGenerator<AgentRunStreamChunk> {
    const work = workStore.current(sessionId)!;
    let message: AgentRuntimeMessage | undefined;
    getRawSqlite().transaction(() => {
      workRuntime.persistTerminal(work, run.id);
      message = this.store
        .listMessages(sessionId)
        .find(
          (m) =>
            m.metadata.purpose === "work_result" &&
            m.content === (work.result ?? work.reason),
        );
      if (!message)
        message = this.finishAssistantMessage(
          sessionId,
          run.id,
          null,
          work.result ?? work.reason ?? "Work completed.",
          run.model,
          "work_result",
        );
    })();
    if (work.status === "completed" && message)
      persistInlineVisualization(message);
    const terminalRun = this.store.getRun(run.id);
    const eventType =
      work.status === "completed" ? "run_completed" : "run_failed";
    const latest = this.store.getLatestEventOfTypes(sessionId, [
      "run_completed",
      "run_failed",
    ]);
    if (latest?.payload.runId !== run.id)
      this.events.append({
        sessionId,
        type: eventType,
        summary: message!.content,
        payload: { runId: run.id, workId: work.id, status: terminalRun.status },
      });
    yield { type: "message", message: message! };
    if (work.status === "completed")
      yield { type: "run_completed", run: terminalRun, message: message! };
    else
      yield {
        type: "run_failed",
        run: terminalRun,
        error: work.reason ?? "Work blocked.",
      };
    yield { type: "done", sessionId, runId: run.id };
  }

  private async *finishYieldedRun(
    sessionId: string,
    run: AgentRun,
  ): AsyncGenerator<AgentRunStreamChunk> {
    const handoff = this.store.getRun(run.id).metadata.roundHandoff as {
      stepId: string;
      summary: string;
    };
    let message!: AgentRuntimeMessage;
    let finished!: AgentRun;
    getRawSqlite().transaction(() => {
      message = this.finishAssistantMessage(
        sessionId,
        run.id,
        handoff.stepId,
        handoff.summary,
        run.model,
        "round_handoff",
      );
      finished = this.store.updateRun(run.id, {
        status: "completed",
        completedAt: nowIso(),
        stopReason: "round_yielded",
      });
      // A yielded round is terminal at the Session layer. The latest Run's
      // round_yielded stop reason carries the continuation contract.
      this.store.updateSession(sessionId, {
        status: "completed",
        activeRunId: null,
        pendingResumeToken: null,
        completedAt: nowIso(),
        updatedAt: nowIso(),
        resultSummary: handoff.summary,
        blockedReason: null,
      });
    })();
    persistInlineVisualization(message);
    const event = this.events.append({
      sessionId,
      type: "run_completed",
      summary: handoff.summary,
      payload: {
        runId: run.id,
        stepId: handoff.stepId,
        messageId: message.id,
        stopReason: "round_yielded",
        workCompleted: false,
      },
    });
    yield { type: "message", message };
    yield { type: "run_completed", run: finished, message, event };
    yield { type: "done", sessionId, runId: run.id };
  }

  private async *finishControlledGoal(
    sessionId: string,
    run: AgentRun,
    reason: string,
  ): AsyncGenerator<AgentRunStreamChunk> {
    const session = this.store.getSession(sessionId),
      goal = rootGoal(session).goal;
    const completed = goal?.status === "completed";
    const finished = this.store.updateRun(run.id, {
      status: completed ? "completed" : "blocked",
      completedAt: nowIso(),
      stopReason: reason,
    });
    this.store.updateSession(sessionId, {
      status: "completed",
      completedAt: nowIso(),
      resultSummary: reason,
      blockedReason: completed ? null : reason,
      activeRunId: null,
      pendingResumeToken: null,
    });
    const message = this.store.appendMessage({
      id: makeRuntimeId("msg"),
      sessionId,
      runId: run.id,
      stepId: null,
      role: "assistant",
      content: reason,
      metadata: { goalStatus: goal?.status },
      createdAt: nowIso(),
    });
    if (completed) persistInlineVisualization(message);
    yield { type: "message", message };
    yield completed
      ? { type: "run_completed", run: finished, message }
      : { type: "run_failed", run: finished, error: reason };
    yield { type: "done", sessionId, runId: run.id };
  }

  interruptSessions(
    sessionIds: Iterable<string>,
    reason = "Agent runtime session deleted by user.",
  ): void {
    const ids = this.sessionTreeIds(sessionIds);
    for (const sessionId of ids) {
      for (const controller of this.activeSessionControllers.get(sessionId) ??
        []) {
        if (!controller.signal.aborted) {
          controller.abort(new Error(reason));
        }
      }
      // dispose() releases the controller only after the generator and tools
      // have actually unwound. An abort request is not shutdown confirmation.
    }
  }

  private sessionTreeIds(sessionIds: Iterable<string>): string[] {
    return [
      ...new Set(
        [...sessionIds].flatMap((id) =>
          this.store.tryGetSession(id)
            ? this.store.listSessionTree(id).map((session) => session.id)
            : [id],
        ),
      ),
    ];
  }

  async waitForIdleSessions(
    sessionIds: Iterable<string>,
    timeoutMs = ACTIVE_SESSION_TIMEOUT_MS,
  ): Promise<void> {
    const ids = [...new Set(sessionIds)];
    const deadline = Date.now() + timeoutMs;
    while (
      ids.some(
        (sessionId) =>
          (this.activeSessionControllers.get(sessionId)?.size ?? 0) > 0,
      )
    ) {
      if (Date.now() >= deadline) {
        throw new AgentRuntimeError(
          "Timed out while waiting for active agent runtime sessions to stop.",
          "DELETE_TIMEOUT",
          409,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, ACTIVE_SESSION_WAIT_MS),
      );
    }
  }

  async interruptAndWaitForSessions(
    sessionIds: Iterable<string>,
    reason = "Agent runtime session deleted by user.",
    timeoutMs = ACTIVE_SESSION_TIMEOUT_MS,
  ): Promise<void> {
    const ids = this.sessionTreeIds(sessionIds);
    this.interruptSessions(ids, reason);
    await this.waitForIdleSessions(ids, timeoutMs);
  }

  private async injectQueuedInput(
    sessionId: string,
    run: AgentRun,
  ): Promise<{
    message: string;
    model: string | null;
    userMessage: AgentRuntimeMessage;
    queueItemId: string;
  } | null> {
    const queuedMessageId = makeRuntimeId("msg");
    if (inputQueueService.getForceInjectId(sessionId))
      await captureCheckpoint(sessionId, "input", queuedMessageId);
    const injected = runtimeTransaction(() => {
      const item = inputQueueService.consumeForced(sessionId);
      if (!item) return null;

      this.store.updateRun(run.id, {
        metadata: {
          ...this.store.getRun(run.id).metadata,
          turnReferences: item.referenceContext ?? null,
          turnReferenceInputId: queuedMessageId,
        },
      });
      const userMessage = this.store.appendMessage({
        id: queuedMessageId,
        sessionId,
        runId: run.id,
        stepId: null,
        role: "user",
        content: item.message,
        contentParts: item.contentParts,
        metadata: {
          source: "input_queue",
          queueItemId: item.id,
          consumedBeforeStepIndex: this.store.getRun(run.id).currentStep + 1,
          references: item.references,
        },
        createdAt: nowIso(),
      });
      workRuntime.attach(sessionId, {
        ...run,
        triggerMessageId: userMessage.id,
      });
      this.events.append({
        sessionId,
        type: "progress_updated",
        summary: `User input injected from queue`,
        payload: {
          queueItemId: item.id,
          messageId: userMessage.id,
          runId: run.id,
        },
        visibility: "user_visible",
      });
      if (item.reasoningEffort) {
        this.store.updateSession(sessionId, {
          reasoningEffort: item.reasoningEffort,
          updatedAt: nowIso(),
        });
      }
      logger.info(
        {
          sessionId,
          runId: run.id,
          queueItemId: item.id,
          messageId: userMessage.id,
        },
        "[agent-runtime] queued user input injected at step boundary",
      );
      return {
        message: item.message,
        model: item.model ?? null,
        userMessage,
        queueItemId: item.id,
      };
    });
    if (injected) await warmupMcpForSession(sessionId);
    return injected;
  }

  private createRun(
    sessionId: string,
    triggerMessageId: string,
    model: string | null,
    acceptedRunId?: string,
  ): AgentRun {
    if (acceptedRunId)
      return activateAcceptedRun(
        sessionId,
        acceptedRunId,
        triggerMessageId,
        model,
      );
    return this.store.appendRun({
      id: makeRuntimeId("run"),
      sessionId,
      status: "running",
      startedAt: nowIso(),
      completedAt: null,
      triggerMessageId,
      currentStep: 0,
      stopReason: null,
      model,
      metadata: {},
    });
  }

  private async *generateStep(input: {
    sessionId: string;
    stepId: string;
    prompt: string;
    input: StreamTurnRequest;
    profile: ReturnType<ProfileService["get"]>;
    context: AgentContextBundle | null;
    history: AgentRuntimeMessage[];
    previousParts: AgentRunPart[];
    previousToolCalls: ToolCallRecord[];
    stepIndex: number;
    maxSteps: number;
    converging: boolean;
    blockedByPermission: boolean;
    previousStepUsage?: Record<string, unknown> | null;
    abortSignal?: AbortSignal;
    clearingActivated?: boolean;
    contextLimit?: number;
    outputReserve?: number;
  }): AsyncGenerator<LoopModelStreamEvent> {
    if (input.blockedByPermission) {
      logger.info(
        {
          sessionId: input.sessionId,
          stepIndex: input.stepIndex,
          blockedByPermission: true,
        },
        "[agent-runtime] generation skipped due to blocked permission",
      );
      yield {
        type: "step_complete",
        model: input.input.model ?? null,
        step: {
          thought: undefined,
          message:
            "The requested action was blocked by permission policy. Summarizing current status instead.",
          toolCalls: [],
          final: true,
          stopReason: "blocked",
          finishReason: "blocked",
        },
      };
      return;
    }

    // Runtime-requested loads use an ordinary tool-only step before generation.
    // The existing execution path owns permissions, hooks, persistence, events,
    // resume and history projection; no skill body is injected into the prompt.
    const referenceLoads = pendingTurnReferenceSkillLoads(input.sessionId);
    if (referenceLoads.length) {
      const step = this.store.getRunStep(input.stepId);
      this.store.updateRunStep(step.id, {
        metadata: { ...step.metadata, source: "turn_reference" },
      });
      yield {
        type: "step_complete",
        model: null,
        step: {
          toolCalls: referenceLoads,
          final: false,
          stopReason: null,
          finishReason: "tool_calls",
        },
      };
      return;
    }

    logger.info(
      {
        sessionId: input.sessionId,
        stepIndex: input.stepIndex,
        maxSteps: input.maxSteps,
        prompt: truncateLogText(input.prompt),
        historyCount: input.history.length,
        previousPartCount: input.previousParts.length,
        previousToolCallCount: input.previousToolCalls.length,
      },
      "[agent-runtime] generating step",
    );
    const availableTools = this.tools
      .listForSession(input.sessionId)
      .filter(
        (tool) =>
          profileCanUseTool(input.profile, tool) ||
          ["work.checkpoint", "context.read"].includes(tool.id) ||
          (tool.id === "verification.run" &&
            profileCanUseTool(input.profile, { id: "bash" })) ||
          tool.category === "skill" ||
          tool.category === "mcp" ||
          tool.id === "tools.invalid",
      );
    const session = this.store.getSession(input.sessionId);
    const userRequest = resolveSessionUserRequest(session, input.prompt);
    const webSearchDisabled =
      getGlobalConfigForRuntime().webSearch.routing === "disabled";
    const allowedTools = availableTools.filter(
      (tool) =>
        !controlToolError(session, tool) &&
        !(webSearchDisabled && tool.id === "webSearch"),
    );
    const toolSet = buildLoopToolSet(allowedTools);
    const contextLimit =
      (input as { contextLimit?: number }).contextLimit ??
      DEFAULT_CONTEXT_LIMIT;

    let conversationMessages: import("@ai-sdk/provider-utils").ModelMessage[] =
      [];

    const relevantMemories = memoryManager.getRelevantMemories(
      session.projectId,
      userRequest,
      5,
    );
    const projectMemoriesSection =
      relevantMemories.length > 0
        ? [
            "## Relevant project memories",
            ...relevantMemories.map(
              (m) =>
                `- [${m.memoryType}] ${m.title}: ${m.content.slice(0, 400)}`,
            ),
          ].join("\n")
        : null;

    let projectRulesSection: string | null = null;
    try {
      const workDir = resolveSessionWorkDir(input.sessionId, session.projectId);
      // MR repository files are evidence, never authority over the pinned Git contract.
      if (session.profileId !== 'git-manager') projectRulesSection = loadProjectRulesSection(workDir);
    } catch {
      projectRulesSection = null;
    }

    const selectedReferences = activeTurnReferences(input.sessionId);
    const visualizationIntent = isVisualizationIntent(userRequest);
    const turnSkillIds = [
      ...new Set([
        ...session.skillIds,
        ...(selectedReferences?.skillIds ?? []),
      ]),
    ];
    const skillCandidates = skillAgentBridge.listForPrompt({
      profileId: input.profile.id,
      projectId: session.projectId,
      activeSkillIds: turnSkillIds,
    });
    const autoVisualizeSkill = visualizationIntent
      ? skillCandidates.find(
          (skill) =>
            skill.name.toLowerCase() === "visualize" ||
            skill.id.toLowerCase().endsWith("/visualize"),
        )
      : undefined;
    const activeSkillIds = new Set(turnSkillIds);
    if (autoVisualizeSkill) activeSkillIds.add(autoVisualizeSkill.id);
    const skillsSection =
      allowedTools.some((tool) => tool.id === "skill.load") &&
      skillCandidates.length > 0
        ? [
            "## Available skills",
            "Skills selected for this turn must be loaded with skill.load before authoring. Check the tool result for success or failure. Other skills may be loaded when their descriptions match the task. Full instructions arrive as tool results. Do not reload instructions still present in context. Report loading failures; never claim to have followed unavailable content.",
            ...(visualizationIntent
              ? [
                  `Visual preview intent detected. Load ${autoVisualizeSkill?.id ?? "the visualize skill"} now, then produce one conversation preview instead of only describing it. Do not implement production files unless the user separately asks for that.`,
                ]
              : []),
            ...skillCandidates.map((skill) => {
              return JSON.stringify({
                id: skill.id,
                name: skill.label,
                description: skill.description,
                ...(activeSkillIds.has(skill.id) ? { selected: true } : {}),
                ...(selectedReferences?.skillIds.includes(skill.id)
                  ? { selectedForTurnMount: true }
                  : {}),
              }).replace(/</g, "\\u003c");
            }),
          ].join("\n")
        : null;

    const permissionConfig = readSessionPermissionConfig(
      session.sessionMetadata,
    );
    const locale = resolvePromptLocale(input.input.locale, userRequest);

    let contextForPrompt = input.context;
    try {
      const workDir = resolveSessionWorkDir(input.sessionId, session.projectId);
      contextForPrompt = enrichContextForPrompt(
        input.context,
        session.projectId,
        workDir,
        userRequest,
        input.sessionId,
      );
    } catch {
      contextForPrompt = input.context;
    }

    const systemPromptContent = buildLoopSystemPrompt({
      profile: input.profile,
      context: contextForPrompt,
      locale,
      permissionTier: permissionConfig.permissionTier,
      effectivePermissionRules: session.permissionRules,
      isSubSession: Boolean(session.parentSessionId),
      availableToolIds: allowedTools.map((tool) => tool.id),
      specializedOutput: isWikiAgentProfile(input.profile.id),
      modePromptSection: synaxAgent.buildModePromptSection(session),
      variantPromptSection: synaxAgent.buildVariantPromptSection(session),
      intentPromptSection: synaxAgent.isSynaxSession(session)
        ? synaxAgent.buildIntentPromptSection(
            session,
            userRequest,
            input.stepIndex,
          )
        : null,
      loopHintsOverride: synaxAgent.isSynaxSession(session)
        ? synaxAgent.buildEffectiveLoopHints(session)
        : null,
      projectMemoriesSection,
      projectRulesSection,
      skillsSection,
      selectedReferencesSection: selectedReferences?.content,
      visualizationIntent,
    });

    // Static instructions/reference preview; the complete request also contains historical and latest reminders
    // Writing this every step churned session_metadata (12+ KB rows) and emitted
    // a session_changed event per step; only persist when the preview changed.
    try {
      const previousPrompt = this.store.getSession(input.sessionId)
        .sessionMetadata?.latestSystemPrompt;
      if (previousPrompt !== systemPromptContent) {
        this.store.updateSessionMetadata(input.sessionId, {
          latestSystemPrompt: systemPromptContent,
        });
      }
    } catch {
      // Non-critical: metadata write failure should not block the step
    }

    const needsInstructionOverride =
      input.stepIndex > 1 &&
      userRequest.length > 0 &&
      !input.history.some(
        (message) =>
          message.role === "user" &&
          resolveSessionUserRequest(session, message.content) === userRequest,
      );

    const failureReminder = buildConsecutiveFailureReminder(
      input.previousToolCalls,
      input.profile.consecutiveFailureReminderThreshold,
    );

    const stepNote = buildLoopStepNote({
      ...input,
      mode: workflowMode(session),
    });
    const tailReminders = [
      buildRuntimeEnvironment(input.sessionId, session.projectId),
      workRuntime.prompt(input.sessionId) ?? "",
      synaxAgent.buildRuntimeStateSection(session) ?? "",
      goalEvidenceSection(session, input.previousToolCalls) ?? "",
      stepNote,
      failureReminder ?? "",
      needsInstructionOverride ? userRequest : "",
    ].filter(Boolean);

    const currentStep = this.store.getRunStep(input.stepId);
    const reminder = snapshotRuntimeReminder(
      currentStep.metadata,
      tailReminders,
      this.store
        .listMessages(input.sessionId)
        .filter(
          (message) =>
            message.runId === currentStep.runId &&
            message.metadata.source === "input_queue" &&
            message.metadata.consumedBeforeStepIndex === currentStep.index,
        )
        .map((message) => message.id),
    );
    const reminderTokens = countMessagesTokens(
      [runtimeReminderMessage(reminder)],
      input.input.model ?? undefined,
    );
    const toolComposition = await measureContextComposition({
      messages: [],
      tools: toolSet,
      model: input.input.model,
    });
    const stableContextFingerprint = JSON.stringify({
      model: input.input.model ?? null,
      reasoningEffort: input.input.reasoningEffort ?? session.thinkingMode,
      blocks: (
        await fingerprintGatewayRequest({
          messages: [{ role: "system", content: systemPromptContent }],
          tools: toolSet.tools,
          activeTools: toolSet.activeTools,
        })
      ).blocks,
    });
    const projection = projectWorkContext({
      sessionId: input.sessionId,
      toolSet,
      contextLimit,
      currentStepId: input.stepId,
      configurationFingerprint: stableContextFingerprint,
      clearing: {
        contextLimit,
        threshold: CONTEXT_TOOL_CLEAR_THRESHOLD,
        keepRecent: CONTEXT_TOOL_CLEAR_KEEP_RECENT,
        excludeTools: CONTEXT_TOOL_CLEAR_EXCLUDE,
        priorInputTokens:
          typeof input.previousStepUsage?.inputTokens === "number"
            ? input.previousStepUsage.inputTokens
            : null,
        forceActivated: input.clearingActivated,
      },
      outputReserve: input.outputReserve ?? input.input.maxTokens ?? 8192,
      systemTokens:
        reminderTokens +
        countMessagesTokens(
          [{ role: "system", content: systemPromptContent }],
          input.input.model ?? undefined,
        ) +
        toolComposition.total,
      model: input.input.model ?? undefined,
    });
    conversationMessages = projection.messages;
    projection.systemMessageContents.add(reminder.content);
    const compositionSources = {
      systemMessageContents: projection.systemMessageContents,
      toolCalls: this.store.listToolCalls(input.sessionId),
    };
    if (projection.compacted)
      yield {
        type: "context_compacted" as const,
        originalTokens: projection.originalTokens,
        compressedTokens: projection.tokens,
        messageCount: projection.messages.length,
      };

    const previousRequests = this.store
      .listSessionSteps(input.sessionId)
      .filter(
        (step) => step.id !== input.stepId && step.metadata.runtimeReminder,
      );
    const diagnosticsContext = {
      requestId: input.stepId,
      source: session.parentSessionId
        ? ("subsession" as const)
        : ("main" as const),
      phase: projection.compacted
        ? ("post-compaction" as const)
        : previousRequests.length
          ? ("continuous" as const)
          : ("cold" as const),
    };
    const previousReminder = readRuntimeReminder(
      previousRequests.at(-1)?.metadata,
    );
    const request = {
      previousHistoryAnchor: previousReminder?.historyAnchor,
      onRequestPrepared: async (
        prepared: Parameters<
          NonNullable<
            import("../llm-runtime/types.js").LlmGatewayRequest["onRequestPrepared"]
          >
        >[0],
      ) => {
        const latest = this.store.getRunStep(input.stepId);
        const saved = readRuntimeReminder(latest.metadata);
        if (!saved)
          throw new AgentValidationError(
            "request_snapshot_missing: runtime reminder must be saved before dispatch.",
          );
        if (
          saved.historyAnchor &&
          saved.historyAnchor.fingerprint !== prepared.historyAnchor.fingerprint
        )
          throw new AgentValidationError(
            "request_snapshot_changed: media or history changed during retry; start a new request.",
          );
        const preparedComposition = await measureContextComposition({
          ...compositionSources,
          messages: prepared.messages,
          tools: toolSet,
          model: input.input.model,
          skillsSection,
          selectedReferences: selectedReferences?.content,
        });
        if (
          preparedComposition.total >
          contextLimit - (input.outputReserve ?? input.input.maxTokens ?? 8192)
        )
          throw new AgentValidationError(
            "context_blocked: prepared media/text/schema request exceeds the model window.",
          );
        const status =
          !previousReminder?.historyAnchor && previousReminder
            ? "unknown"
            : prepared.historyAnchorStatus;
        this.store.updateRunStep(input.stepId, {
          metadata: {
            ...latest.metadata,
            runtimeReminder: saved.historyAnchor
              ? saved
              : { ...saved, historyAnchor: prepared.historyAnchor },
            requestComposition: {
              ...(latest.metadata.requestComposition as Record<
                string,
                unknown
              >),
              historyAnchorStatus: status,
            },
            contextComposition: preparedComposition,
            ...(latest.metadata.cacheDiagnostics
              ? {
                  cacheDiagnostics: {
                    ...(latest.metadata.cacheDiagnostics as Record<
                      string,
                      unknown
                    >),
                    historyAnchorStatus: status,
                  },
                }
              : {}),
          },
        });
      },
      cacheDiagnosticsContext: diagnosticsContext,
      projectId: this.store.getSession(input.sessionId).projectId,
      purpose: input.input.purpose ?? input.profile.kind,
      model: input.input.model,
      cacheControl: true,
      // The native loop rebuilds history locally, including encrypted reasoning.
      responseOptions: { store: false },
      reasoningEffort:
        input.input.reasoningEffort ??
        mapThinkingModeToReasoningEffort(session.thinkingMode),
      messages: [
        {
          role: "system" as const,
          content: systemPromptContent,
        },
        ...conversationMessages,
        runtimeReminderMessage(reminder),
      ],
      temperature: input.input.temperature,
      maxTokens: input.input.maxTokens,
    };
    const composition = await measureContextComposition({
      ...compositionSources,
      messages: request.messages,
      tools: toolSet,
      model: input.input.model,
      skillsSection,
      selectedReferences: selectedReferences?.content,
    });
    if (
      composition.total >
      contextLimit - (input.outputReserve ?? input.input.maxTokens ?? 8192)
    )
      throw new AgentValidationError(
        "context_blocked: the final request, including required reminders, active tool schemas and output reservation, exceeds the model window.",
      );
    yield { type: "context_composition", composition };
    input.abortSignal?.throwIfAborted();
    let diagnostics: Record<string, unknown> | undefined;
    if (cacheDiagnosticsEnabled()) {
      const fingerprint = await fingerprintGatewayRequest({
        ...request,
        tools: toolSet.tools,
        activeTools: toolSet.activeTools,
      });
      const previous = previousRequests.at(-1)?.metadata.cacheDiagnostics as
        | { request?: CacheRequestFingerprint }
        | undefined;
      diagnostics = {
        version: 1,
        boundary: "native",
        ...diagnosticsContext,
        model: input.input.model ?? null,
        request: fingerprint,
        comparison: readCacheFingerprint(previous?.request)
          ? compareRequests(
              readCacheFingerprint(previous?.request)!,
              fingerprint,
            )
          : null,
        compacted: projection.compacted,
        runtimeReminderTokens: reminderTokens,
      };
    }
    // Save before network dispatch. Metadata failure is fatal: an unsaved request cannot be replayed reliably.
    this.store.updateRunStep(input.stepId, {
      metadata: {
        ...this.store.getRunStep(input.stepId).metadata,
        runtimeReminder: reminder,
        contextReceiptEnabled: allowedTools.some(
          (tool) => tool.id === "context.read",
        ),
        ...(projection.compaction
          ? { contextCompaction: projection.compaction }
          : {}),
        ...(diagnostics ? { cacheDiagnostics: diagnostics } : {}),
        runtimeReminderTokens: reminderTokens,
        requestComposition: {
          version: 1,
          systemMeaning: "static-instructions-and-references",
          compacted: projection.compacted,
        },
      },
    });
    yield* streamLoopModelStep({
      request,
      tools: toolSet,
      model: input.input.model ?? null,
      abortSignal: input.abortSignal,
      hookContext: {
        sessionId: input.sessionId,
        runId: currentStep.runId,
        stepId: input.stepId,
        purpose: input.input.purpose ?? undefined,
      },
    });
  }

  private async persistStepOutput(
    runId: string,
    stepId: string,
    sessionId: string,
    step: LoopStepModelResult["step"],
    options?: { skipAssistantText?: boolean },
  ): Promise<AgentRunPart[]> {
    const parts: AgentRunPart[] = [];
    if (step.contentParts?.length) {
      const createdAt = nowIso();
      this.store.appendMessage({
        id: makeRuntimeId("msg"),
        sessionId,
        runId,
        stepId,
        role: "assistant",
        content: "",
        contentParts: step.contentParts,
        metadata: { type: "media" },
        createdAt,
      });
      parts.push(
        this.store.appendRunPart({
          id: makeRuntimeId("prt"),
          sessionId,
          runId,
          stepId,
          kind: "text",
          sequence: this.store.nextRunPartSequence(stepId),
          content: "",
          toolCallId: null,
          metadata: { contentParts: step.contentParts },
          createdAt,
        }),
      );
    }
    if (step.thought?.trim()) {
      logger.info(
        {
          runId,
          stepId,
          sessionId,
          kind: "thought",
          content: truncateLogText(step.thought.trim()),
        },
        "[agent-runtime] step thought",
      );
      parts.push(
        this.store.appendRunPart({
          id: makeRuntimeId("prt"),
          runId,
          stepId,
          sessionId,
          kind: "thought",
          sequence: this.store.nextRunPartSequence(stepId),
          content: step.thought.trim(),
          toolCallId: null,
          metadata: {},
          createdAt: nowIso(),
        }),
      );
      this.store.appendMessage({
        id: makeRuntimeId("msg"),
        sessionId,
        runId,
        stepId,
        role: "assistant",
        content: step.thought.trim(),
        metadata: { type: "thinking" },
        createdAt: nowIso(),
      });
    }
    if (step.message?.trim()) {
      logger.info(
        {
          runId,
          stepId,
          sessionId,
          kind: "text",
          content: truncateLogText(step.message.trim()),
        },
        "[agent-runtime] step message",
      );
      const textCreatedAt = nowIso();
      parts.push(
        this.store.appendRunPart({
          id: makeRuntimeId("prt"),
          runId,
          stepId,
          sessionId,
          kind: "text",
          sequence: this.store.nextRunPartSequence(stepId),
          content: step.message.trim(),
          toolCallId: null,
          metadata: {},
          createdAt: textCreatedAt,
        }),
      );
      if (!options?.skipAssistantText) {
        this.store.appendMessage({
          id: makeRuntimeId("msg"),
          sessionId,
          runId,
          stepId,
          role: "assistant",
          content: step.message.trim(),
          metadata: {},
          createdAt: textCreatedAt,
        });
      }
    }
    return parts;
  }

  private finishAssistantMessage(
    sessionId: string,
    runId: string,
    stepId: string | null,
    content: string,
    model: string | null,
    purpose: string,
    usage?: Record<string, unknown>,
    sources?: LoopStepModelResult["step"]["sources"],
  ): AgentRuntimeMessage {
    return this.store.appendMessage({
      id: makeRuntimeId("msg"),
      sessionId,
      runId,
      stepId,
      role: "assistant",
      content,
      metadata: {
        model,
        purpose,
        usage,
        ...(sources?.length ? { sources } : {}),
      },
      createdAt: nowIso(),
    });
  }

  private appendSystemNotePart(input: {
    runId: string;
    stepId: string;
    sessionId: string;
    content: string;
    toolCallId?: string | null;
    metadata?: Record<string, unknown>;
  }): AgentRunPart {
    return this.store.appendRunPart({
      id: makeRuntimeId("prt"),
      runId: input.runId,
      stepId: input.stepId,
      sessionId: input.sessionId,
      kind: "system_note",
      sequence: this.store.nextRunPartSequence(input.stepId),
      content: input.content,
      toolCallId: input.toolCallId ?? null,
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
    });
  }

  private appendToolCallPart(input: {
    runId: string;
    stepId: string;
    sessionId: string;
    record: ToolCallRecord;
    reason?: string;
  }): AgentRunPart {
    const existing = this.store
      .listRunParts(input.stepId)
      .find((p) => p.kind === "tool_call" && p.toolCallId === input.record.id);
    if (existing) return existing;
    return this.store.appendRunPart({
      id: makeRuntimeId("prt"),
      runId: input.runId,
      stepId: input.stepId,
      sessionId: input.sessionId,
      kind: "tool_call",
      sequence: this.store.nextRunPartSequence(input.stepId),
      content: `${input.record.toolId} ${input.record.inputSummary}`,
      toolCallId: input.record.id,
      metadata: {
        reason: input.reason ?? null,
        modelToolCallId: input.record.modelToolCallId,
      },
      createdAt: nowIso(),
    });
  }

  private appendToolResultPart(input: {
    runId: string;
    stepId: string;
    sessionId: string;
    record: ToolCallRecord;
  }): AgentRunPart {
    const step = this.store.getRunStep(input.stepId);
    if (
      step.metadata.contextProjectionVersion === 2 &&
      step.metadata.contextReceiptEnabled &&
      ["completed", "failed"].includes(input.record.status)
    ) {
      const receipts = (step.metadata.toolContextReceipts ?? {}) as Record<
        string,
        unknown
      >;
      if (!receipts[input.record.id]) {
        const receipt = buildToolContextReceipt(input.record);
        if (receipt)
          this.store.updateRunStep(step.id, {
            metadata: {
              ...step.metadata,
              toolContextReceipts: {
                ...receipts,
                [input.record.id]: {
                  ...receipt,
                  outputType:
                    input.record.status === "failed" ? "error-text" : "text",
                },
              },
            },
          });
      }
    }
    const summary =
      input.record.outputSummary ??
      input.record.error ??
      input.record.inputSummary;
    return this.store.appendRunPart({
      id: makeRuntimeId("prt"),
      runId: input.runId,
      stepId: input.stepId,
      sessionId: input.sessionId,
      kind: "tool_result",
      sequence: this.store.nextRunPartSequence(input.stepId),
      content: `${input.record.toolId} [${input.record.status}]: ${summary}`,
      toolCallId: input.record.id,
      metadata: { status: input.record.status },
      createdAt: nowIso(),
    });
  }

  private async awaitTaskResult(
    record: ToolCallRecord,
    result: unknown,
    abortSignal?: AbortSignal,
  ): Promise<ToolCallRecord> {
    if (!result || typeof result !== "object") return record;
    const taskResult = result as {
      taskId?: unknown;
      session?: { id?: unknown };
    };
    const childSessionId =
      typeof taskResult.taskId === "string"
        ? taskResult.taskId
        : typeof taskResult.session?.id === "string"
          ? taskResult.session.id
          : null;
    if (!childSessionId) return record;

    // Run the child with a wall-clock timeout so a hung sub-agent (e.g. a stalled
    // LLM call) aborts itself instead of blocking the parent's Promise.all forever.
    // The budget follows the same `limits.agentTimeoutMs` setting as the main
    // agent, so children are no longer capped at a shorter hard-coded ceiling.
    const childProjectId = this.store.tryGetSession(childSessionId)?.projectId;
    const childResult = await runChildToCompletion(
      childSessionId,
      { profileId: "subagent", prompt: "" },
      { timeoutMs: resolvePerChildTimeoutMs(childProjectId), abortSignal },
    );

    const childSession = this.store.tryGetSession(childSessionId);
    const childSummary =
      childSession?.resultSummary ??
      childResult.error ??
      `Child session ${childSessionId} finished with status ${childSession?.status ?? "deleted"}.`;
    const status =
      childResult.status === "completed" ? record.status : "failed";
    const outputSummary = truncateSummary(
      `Subtask ${childSessionId} ${childResult.status}: ${childSummary}`,
    );
    const updated = this.store.updateToolCall(record.sessionId, record.id, {
      status,
      outputSummary,
      outputRef: {
        ...(result as Record<string, unknown>),
        childSessionId,
        childStatus: childSession?.status ?? "deleted",
        childSummary,
      },
      endedAt: nowIso(),
      error: status === "failed" ? childSummary : null,
    });
    this.events.append({
      sessionId: record.sessionId,
      type: "tool_result",
      summary: `subagent.delegate: ${outputSummary}`,
      payload: {
        runId: record.runId,
        stepId: record.stepId,
        toolCallId: record.id,
        childSessionId,
        childStatus: childSession?.status ?? "deleted",
      },
    });
    return updated;
  }

  /**
   * On session resume, scan for incomplete subagent.delegate tool calls
   * and attempt to recover interrupted child sessions. Unrecoverable children
   * are marked as failed so the model can re-delegate if needed.
   */
  private async recoverIncompleteSubtasks(
    sessionId: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const runs = this.store.listRuns(sessionId);
    for (const run of runs) {
      const calls = this.store.listRunToolCalls(run.id);
      for (const call of calls) {
        if (call.toolId !== "subagent.delegate") continue;
        if (call.status === "completed" || call.status === "failed") continue;

        const inputRef = call.inputRef as {
          taskId?: unknown;
          session?: { id?: unknown };
        } | null;
        const childId =
          typeof inputRef?.taskId === "string"
            ? inputRef.taskId
            : typeof inputRef?.session?.id === "string"
              ? inputRef.session.id
              : null;

        if (!childId) {
          this.store.updateToolCall(sessionId, call.id, {
            status: "failed",
            outputSummary:
              "Subtask reference lost — child session ID not found.",
            endedAt: nowIso(),
            error: "Child session ID missing from tool call inputRef.",
          });
          continue;
        }

        try {
          const child = this.store.getSession(childId);
          if (child.sessionMetadata?.manualStop) {
            this.store.updateToolCall(sessionId, call.id, {
              status: "failed",
              outputSummary: `Subtask ${childId} was stopped by user.`,
              outputRef: { childSessionId: childId, childStatus: child.status },
              endedAt: nowIso(),
              error: "Subagent stopped by user.",
            });
            continue;
          }
          if (child.status === "interrupted") {
            logger.info(
              { sessionId, childSessionId: childId, childStatus: child.status },
              "[agent-runtime] recovering interrupted child session",
            );
            // Resume the child to completion
            for await (const _chunk of this.streamRun(
              childId,
              {
                contentParts: this.store.getSession(childId).sessionMetadata
                  ?.initialContentParts as
                  | import("./content-parts.js").RuntimeContentPart[]
                  | undefined,
              },
              abortSignal,
            )) {
              // consume stream; child persists its own state
            }
            const updated = this.store.getSession(childId);
            const summary =
              updated.resultSummary ??
              `Child session finished with status ${updated.status}.`;
            this.store.updateToolCall(sessionId, call.id, {
              status: updated.status === "completed" ? "completed" : "failed",
              outputSummary: `Subtask ${childId} ${updated.status}: ${summary}`,
              outputRef: {
                ...((call.inputRef as Record<string, unknown>) ?? {}),
                childSessionId: childId,
                childStatus: updated.status,
                childSummary: summary,
              },
              endedAt: nowIso(),
              error: updated.status === "failed" ? summary : null,
            } as Partial<ToolCallRecord>);
            logger.info(
              {
                sessionId,
                childSessionId: childId,
                childStatus: updated.status,
              },
              "[agent-runtime] child session recovered",
            );
          } else if (child.status === "running") {
            // Zombie child: mark as interrupted so it doesn't block future delegates
            this.store.updateSession(childId, {
              status: "interrupted",
              updatedAt: nowIso(),
              blockedReason:
                "Parent session resumed; child marked as interrupted.",
            });
            this.store.updateToolCall(sessionId, call.id, {
              status: "failed",
              outputSummary:
                "Subtask was interrupted and could not be recovered. Re-delegate if needed.",
              endedAt: nowIso(),
              error: "interrupted",
            });
          } else if (
            child.status === "completed" ||
            child.status === "failed"
          ) {
            // Child finished independently — update parent record
            const summary =
              child.resultSummary ??
              `Child session finished with status ${child.status}.`;
            this.store.updateToolCall(sessionId, call.id, {
              status: child.status === "completed" ? "completed" : "failed",
              outputSummary: `Subtask ${childId} ${child.status}: ${summary}`,
              outputRef: {
                ...((call.inputRef as Record<string, unknown>) ?? {}),
                childSessionId: childId,
                childStatus: child.status,
                childSummary: summary,
              },
              endedAt: nowIso(),
              error: child.status === "failed" ? summary : null,
            } as Partial<ToolCallRecord>);
          }
        } catch {
          // Child session deleted or lost
          this.store.updateToolCall(sessionId, call.id, {
            status: "failed",
            outputSummary: "Child session lost — re-delegate if needed.",
            endedAt: nowIso(),
            error: "Child session not found.",
          });
        }
      }
    }
  }

  private tryGetContext(contextSnapshotId: string): AgentContextBundle | null {
    try {
      return this.store.getContextBundle(contextSnapshotId);
    } catch {
      return null;
    }
  }

  private buildContinuationPrompt(sessionId: string, status: string): string {
    if (status === "failed") {
      return "Session previously failed. Review the error and previous context, then retry the task from where it left off.";
    }

    const runs = this.store.listRuns(sessionId);
    const lastRun = runs.sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    )[0];
    if (!lastRun) {
      return "Session was interrupted. Continue working on the original task using tools.";
    }

    const incompleteTools = this.store
      .listRunToolCalls(lastRun.id)
      .filter((tc) => tc.status === "running" || tc.status === "pending");

    const parts: string[] = [
      "Execution was interrupted. Reconcile the current Work checkpoint and existing results first. If the task is already done, deliver the result; otherwise perform only the remaining necessary action.",
    ];

    if (incompleteTools.length > 0) {
      const toolList = incompleteTools
        .map((tc) => `- ${tc.toolId}(${tc.inputSummary?.slice(0, 80) ?? ""})`)
        .join("\n");
      parts.push(
        `The following tool calls were interrupted and did not complete:\n${toolList}\nRetry these operations as needed to continue the task.`,
      );
    } else {
      parts.push(
        "Review your previous tool calls and results. If the task is not fully complete, continue using tools. Only produce a final summary if ALL objectives from the original prompt have been achieved.",
      );
    }

    return parts.join("\n\n");
  }

  private assertSessionNotBusy(sessionId: string): void {
    const active = this.activeSessionControllers.get(sessionId);
    if ((active?.size ?? 0) > 0) {
      throw new AgentRuntimeError(
        "Session already has an active run.",
        "SESSION_BUSY",
        409,
      );
    }
  }

  private beginSessionExecution(
    sessionId: string,
    abortSignal?: AbortSignal,
  ): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const onAbort = () => {
      const reason =
        abortSignal && "reason" in abortSignal
          ? (abortSignal as AbortSignal & { reason?: unknown }).reason
          : undefined;
      if (!controller.signal.aborted) {
        controller.abort(
          reason instanceof Error
            ? reason
            : new Error(String(reason ?? "Run interrupted by client.")),
        );
      }
    };

    if (abortSignal?.aborted) {
      onAbort();
    } else {
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    }

    const controllers =
      this.activeSessionControllers.get(sessionId) ??
      new Set<AbortController>();
    controllers.add(controller);
    this.activeSessionControllers.set(sessionId, controllers);

    return {
      signal: controller.signal,
      dispose: () => {
        abortSignal?.removeEventListener("abort", onAbort);
        const current = this.activeSessionControllers.get(sessionId);
        if (!current) return;
        current.delete(controller);
        if (current.size === 0) {
          this.activeSessionControllers.delete(sessionId);
        }
      },
    };
  }
}

function readProviderDefaultReasoningEffort(
  providerId: string,
): ReasoningEffort | null {
  try {
    const global = getGlobalConfigForRuntime();
    const connection = global?.providerConnections?.[providerId];
    const raw = connection?.extra;
    const listed = Array.isArray(raw?.reasoningEfforts)
      ? (raw.reasoningEfforts as unknown[]).filter(
          (e): e is ReasoningEffort =>
            e === "low" ||
            e === "medium" ||
            e === "high" ||
            e === "xhigh" ||
            e === "max",
        )
      : [];
    const legacy = raw?.defaultReasoningEffort;
    if (
      legacy === "low" ||
      legacy === "medium" ||
      legacy === "high" ||
      legacy === "xhigh" ||
      legacy === "max"
    ) {
      listed.push(legacy);
    }
    if (listed.length === 0) return null;
    return listed.includes("high") ? "high" : listed[0];
  } catch {
    return null;
  }
}

export const agentLoopRuntime = new AgentLoopRuntime();

function withIds(toolCalls: StructuredToolCall[]): StructuredToolCall[] {
  return toolCalls.map((toolCall) => ({
    ...toolCall,
    id: normalizeToolCallId(toolCall.id),
  }));
}

function normalizeToolCallId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return makeRuntimeId("mtc");
}

function optionsResumeToken(
  runId: string,
  stepId: string,
  toolCallId: string,
): string {
  return `${runId}:${stepId}:${toolCallId}`;
}

function truncateSummary(value: string, limit = 1_000): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

function truncateLogText(value: string, limit = LOG_TEXT_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
