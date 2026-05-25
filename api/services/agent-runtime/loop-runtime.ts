import type {
  AgentContextBundle,
  AgentRun,
  AgentRunPart,
  AgentRunStep,
  AgentRunStreamChunk,
  AgentRuntimeMessage,
  CompactionConfig,
  LoopModelStreamEvent,
  LoopStepModelResult,
  StreamTurnRequest,
  StructuredToolCall,
  ToolCallRecord,
} from "./contracts.js";
import { agentEventService, type AgentEventService } from "./event-service.js";
import { detectDoomLoop, shouldForceFinalSummary } from "./loop-guards.js";
import { buildLoopToolSet } from "./loop-ai-tools.js";
import { buildLoopModelMessages } from "./loop-model-messages.js";
import { generateLoopModelStep, streamLoopModelStep } from "./loop-model-stream.js";
import { buildLoopSystemPrompt } from "./loop-prompt.js";
import { loopResumeService, type LoopResumeService } from "./loop-resume.js";
import {
  permissionPolicy,
  type PermissionPolicy,
} from "./permission-policy.js";
import { profileService, type ProfileService } from "./profile-service.js";
import { AgentRuntimeError, AgentValidationError } from "./runtime-errors.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { agentRuntimeStore, type AgentRuntimeStore } from "./session-store.js";
import { generateSessionTitle } from "./session-title-service.js";
import { toolRegistry, type ToolRegistry } from "./tool-registry.js";
import {
  type DisclosureState,
  type DisclosureStrategy,
  advance as advanceDisclosure,
  createState as createDisclosureState,
  filterByDisclosure,
  getStrategyForProfile,
  isTerminalTier,
  promote as promoteDisclosure,
  rebuildState as rebuildDisclosureState,
} from "./tool-disclosure.js";
import { countMessagesTokens, countTokens, estimateToolDefinitionsTokens } from "./context-tokenizer.js";
import { shouldCompact, compactMessages, getCompactionConfig } from "./context-compressor.js";
import { buildTaskDriftReminder } from "./tools/task-tools.js";
import { sessionHooks } from "./session-hooks.js";
import { sessionLiveBus } from "./session-live-bus.js";
import { resolveGatewaySelection } from "../llm-runtime/stream.js";
import { logger } from "../../lib/logger.js";

const LOG_TEXT_LIMIT = 2000;
const ACTIVE_SESSION_WAIT_MS = 25;
const ACTIVE_SESSION_TIMEOUT_MS = 5_000;
const DEFAULT_CONTEXT_LIMIT = 128_000;

export class AgentLoopRuntime {
  private readonly activeSessionControllers = new Map<string, Set<AbortController>>();

  constructor(
    private readonly store: AgentRuntimeStore = agentRuntimeStore,
    private readonly profiles: ProfileService = profileService,
    private readonly events: AgentEventService = agentEventService,
    private readonly tools: ToolRegistry = toolRegistry,
    private readonly permissions: PermissionPolicy = permissionPolicy,
    private readonly resume: LoopResumeService = loopResumeService,
  ) {}

  listMessages(sessionId: string): AgentRuntimeMessage[] {
    this.store.getSession(sessionId);
    return this.store.listMessages(sessionId);
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
    const session = this.store.getSession(sessionId);

    const RESUMABLE: string[] = ['interrupted', 'paused', 'completed', 'blocked', 'failed'];
    if (!RESUMABLE.includes(session.status)) {
      throw new AgentValidationError(
        `Session status "${session.status}" cannot be resumed. Resumable statuses: ${RESUMABLE.join(', ')}`,
      );
    }

    const hasNewMessage = Boolean(input.message?.trim());

    if (!hasNewMessage && session.status === 'completed') {
      throw new AgentValidationError(
        'Completed sessions require a new message to continue. Provide input.message.',
      );
    }

    if (hasNewMessage) {
      yield* this.streamRun(sessionId, input, abortSignal, false);
    } else {
      if (session.status === 'interrupted') {
        const runs = this.store.listRuns(sessionId);
        const lastRun = runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        if (lastRun?.status === 'completed') {
          this.store.updateSession(sessionId, {
            status: 'completed',
            updatedAt: nowIso(),
            completedAt: nowIso(),
            resultSummary: lastRun.stopReason ?? 'Run completed before interruption.',
            blockedReason: null,
            activeRunId: null,
          });
          yield { type: 'done', sessionId, runId: lastRun.id };
          return;
        }
      }
      const continuationPrompt = this.buildContinuationPrompt(sessionId, session.status);
      yield* this.streamRun(sessionId, { ...input, message: continuationPrompt }, abortSignal, false);
    }
  }

  async *streamRun(
    sessionId: string,
    input: StreamTurnRequest,
    abortSignal?: AbortSignal,
    resume = false,
  ): AsyncGenerator<AgentRunStreamChunk> {
    const session = this.store.getSession(sessionId);
    const activeExecution = this.beginSessionExecution(sessionId, abortSignal);
    const runAbortSignal = activeExecution.signal;
    const profile = this.profiles.tryGet(session.profileId);
    const prompt = input.message?.trim() || session.prompt;
    let run: AgentRun;
    let pendingResume = resume
      ? this.resume.resolvePendingRun(sessionId)
      : null;
    let pendingPermission = pendingResume?.permission ?? null;

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

    if (resume) {
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
      const userMessage = this.store.appendMessage({
        id: makeRuntimeId("msg"),
        sessionId,
        runId: null,
        stepId: null,
        role: "user",
        content: prompt,
        metadata: { source: input.message ? "turn_request" : "session_prompt" },
        createdAt: nowIso(),
      });
      yield { type: "message", message: userMessage };

      run = this.createRun(sessionId, userMessage.id, input.model ?? null);
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
      void sessionHooks.emit({ type: 'run:started', sessionId, runId: run.id });
    }

    try {
      const maxSteps = Infinity;
      const context = session.contextSnapshotId
        ? this.tryGetContext(session.contextSnapshotId)
        : null;

      // Resolve model capabilities once for the run
      let modelCapabilities: { reasoning: boolean } | undefined
      try {
        const selection = await resolveGatewaySelection({
          projectId: session.projectId,
          purpose: input.purpose ?? profile.kind,
          model: input.model ?? undefined,
        })
        modelCapabilities = { reasoning: selection.modelDef.reasoning ?? false }
      } catch { /* non-critical, proceed without capabilities */ }

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

      const disclosureStrategy = getStrategyForProfile(profile.kind);
      let disclosureState: DisclosureState | null = disclosureStrategy
        ? rebuildDisclosureState(
            this.store.listRunToolCalls(run.id),
            disclosureStrategy.escalationToolId,
          )
        : null;

      while (run.currentStep < maxSteps) {
        if (runAbortSignal.aborted) {
          throw new AgentRuntimeError(
            "Run interrupted by client.",
            "ABORTED",
            499,
          );
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
          metadata: {},
        });
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
            maxSteps,
          },
          "[agent-runtime] step started",
        );
        yield { type: "step_started", step, event: stepStarted };
        sessionLiveBus.emit(sessionId, { type: 'step_started', stepId: step.id, stepIndex: step.index, modelCapabilities });

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
        void sessionHooks.emit({ type: 'step:before', sessionId, runId: run.id, stepIndex: step.index });
        for await (const event of this.generateStep({
          sessionId,
          prompt: currentPrompt,
          input,
          profile,
          context,
          history,
          previousParts: previousStepParts,
          previousToolCalls,
          stepIndex: step.index,
          maxSteps,
          mustFinalize: shouldForceFinalSummary(step.index, maxSteps),
          blockedByPermission: pendingPermission?.userReply === "reject",
          disclosureState: disclosureState,
          disclosureStrategy: disclosureStrategy,
          abortSignal: runAbortSignal,
        })) {
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
            sessionLiveBus.emit(sessionId, { type: 'thought_delta', stepId: step.id, delta: event.delta });
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
            sessionLiveBus.emit(sessionId, { type: 'message_delta', stepId: step.id, delta: event.delta });
          }
          if (event.type === "step_complete") {
            modelResult = { model: event.model, step: event.step };
          }
        }

        if (!modelResult) {
          throw new AgentRuntimeError("Model step produced no result.", "INTERNAL", 500);
        }

        await this.persistStepOutput(
          run.id,
          step.id,
          sessionId,
          modelResult.step,
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
        if (step.index === 1) {
          const currentSession = this.store.getSession(sessionId);
          if (!currentSession.title) {
            generateSessionTitle(sessionId, currentSession.projectId, currentSession.profileId, currentSession.prompt);
          }
        }

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
          );
          const completedStep = this.store.updateRunStep(step.id, {
            status: "blocked",
            completedAt: nowIso(),
            finishReason:
              modelResult.step.finishReason ?? "permission_rejected",
            metadata: { usage: modelResult.step.usage },
          });
          void sessionHooks.emit({ type: 'step:after', sessionId, runId: run.id, stepIndex: step.index });
          const blockedRun = this.store.updateRun(run.id, {
            status: "blocked",
            completedAt: nowIso(),
            stopReason: pendingPermission.reason,
          });
          this.store.updateSession(sessionId, {
            status: "blocked",
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

        if (modelResult.step.toolCalls.length === 0 || modelResult.step.final) {
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
          );
          const completedStep = this.store.updateRunStep(step.id, {
            status: "completed",
            completedAt: nowIso(),
            finishReason:
              modelResult.step.finishReason ??
              modelResult.step.stopReason ??
              "stop",
            metadata: { usage: modelResult.step.usage },
          });
          void sessionHooks.emit({ type: 'step:after', sessionId, runId: run.id, stepIndex: step.index });
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

        let waitingPermission = null as null | {
          permission: NonNullable<typeof pendingPermission>;
          record: ToolCallRecord;
        };
        const allCalls = withIds(modelResult.step.toolCalls.slice(0, 50));
        const canParallelRead = profile.toolPolicy?.allowParallelReadTools &&
          allCalls.length > 1 &&
          allCalls.every((c) => {
            try {
              const t = this.tools.get(c.toolId);
              return t.mutability === 'read' && c.toolId !== 'subagent.delegate';
            } catch { return false; }
          });

        if (canParallelRead) {
          const maxParallel = profile.toolPolicy!.maxParallelReadTools ?? 4;
          const batch = allCalls.slice(0, maxParallel);
          const executions = await Promise.all(
            batch.map((call) =>
              this.tools.execute(sessionId, call.toolId, call.args, {
                runId: run.id, stepId: step.id,
                modelToolCallId: call.id,
                resumeToken: optionsResumeToken(run.id, step.id, call.id),
              }).then((exec) => ({ call, exec })),
            ),
          );
          for (const { call, exec } of executions) {
            this.appendToolCallPart({ runId: run.id, stepId: step.id, sessionId, record: exec.record, reason: call.reason });
            yield {
              type: "tool_call", runId: run.id, stepId: step.id, toolCall: exec.record,
              event: this.events.append({ sessionId, type: "tool_call", summary: `${call.toolId} requested`, payload: { runId: run.id, stepId: step.id, toolCallId: exec.record.id, modelToolCallId: call.id } }),
            };
            sessionLiveBus.emit(sessionId, { type: 'tool_call', stepId: step.id, toolCall: exec.record });
            this.appendToolResultPart({ runId: run.id, stepId: step.id, sessionId, record: exec.record });
            yield { type: "tool_result", runId: run.id, stepId: step.id, toolCall: exec.record };
            sessionLiveBus.emit(sessionId, { type: 'tool_result', stepId: step.id, toolCall: exec.record });
            if (disclosureState && disclosureStrategy && call.toolId === disclosureStrategy.escalationToolId) {
              disclosureState = promoteDisclosure(disclosureState);
            }
          }
        } else {
          for (const call of allCalls) {
            const toolExecution = await this.tools.execute(
              sessionId, call.toolId, call.args,
              { runId: run.id, stepId: step.id, modelToolCallId: call.id, resumeToken: optionsResumeToken(run.id, step.id, call.id) },
            );
            this.appendToolCallPart({ runId: run.id, stepId: step.id, sessionId, record: toolExecution.record, reason: call.reason });
            yield {
              type: "tool_call", runId: run.id, stepId: step.id, toolCall: toolExecution.record,
              event: this.events.append({ sessionId, type: "tool_call", summary: `${call.toolId} requested`, payload: { runId: run.id, stepId: step.id, toolCallId: toolExecution.record.id, modelToolCallId: call.id } }),
            };
            sessionLiveBus.emit(sessionId, { type: 'tool_call', stepId: step.id, toolCall: toolExecution.record });
            logger.info(
              { sessionId, runId: run.id, stepId: step.id, toolCallId: toolExecution.record.id, toolId: call.toolId, status: toolExecution.record.status, permissionAction: toolExecution.permission?.action ?? null },
              "[agent-runtime] tool call executed",
            );
            if (toolExecution.permission?.action === "ask") {
              waitingPermission = { permission: toolExecution.permission, record: toolExecution.record };
              logger.info(
                { sessionId, runId: run.id, stepId: step.id, permissionId: toolExecution.permission.id, toolCallId: toolExecution.record.id, reason: truncateLogText(toolExecution.permission.reason) },
                "[agent-runtime] permission requested",
              );
              break;
            }
            const completedRecord =
              call.toolId === "subagent.delegate" && toolExecution.toolResult?.result
                ? await this.awaitTaskResult(toolExecution.record, toolExecution.toolResult.result, runAbortSignal)
                : toolExecution.record;
            this.appendToolResultPart({ runId: run.id, stepId: step.id, sessionId, record: completedRecord });
            if (completedRecord.status === "denied") {
              logger.warn(
                { sessionId, runId: run.id, stepId: step.id, toolCallId: completedRecord.id, toolId: call.toolId },
                "[agent-runtime] tool call denied",
              );
              currentPrompt = `The attempted tool call ${call.toolId} was denied. Explain the blocker and finish without further writes.`;
              pendingPermission = toolExecution.permission ?? null;
              continue;
            }
            logger.info(
              { sessionId, runId: run.id, stepId: step.id, toolCallId: completedRecord.id, toolId: call.toolId, status: completedRecord.status, outputSummary: truncateLogText(completedRecord.outputSummary ?? completedRecord.error ?? "") },
              "[agent-runtime] tool result recorded",
            );
            yield { type: "tool_result", runId: run.id, stepId: step.id, toolCall: completedRecord };
            sessionLiveBus.emit(sessionId, { type: 'tool_result', stepId: step.id, toolCall: completedRecord });
            if (disclosureState && disclosureStrategy && call.toolId === disclosureStrategy.escalationToolId) {
              disclosureState = promoteDisclosure(disclosureState);
            }
          }
        }

        if (disclosureState) {
          disclosureState = advanceDisclosure(disclosureState);
        }

        const completedStep = this.store.updateRunStep(step.id, {
          status: waitingPermission ? "waiting_permission" : "completed",
          completedAt: nowIso(),
          finishReason: waitingPermission
            ? "permission_required"
            : (modelResult.step.finishReason ?? "tool_calls"),
          model: modelResult.model,
          metadata: { usage: modelResult.step.usage },
        });
        void sessionHooks.emit({ type: 'step:after', sessionId, runId: run.id, stepIndex: step.index });

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

        const doomLoop = detectDoomLoop(this.store.listRunToolCalls(run.id));
        if (doomLoop) {
          const note = `Repeated tool call detected for ${doomLoop.toolId}.`;
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
          const blockedRun = this.store.updateRun(run.id, {
            status: "blocked",
            completedAt: nowIso(),
            stopReason: note,
          });
          this.store.updateSession(sessionId, {
            status: "blocked",
            updatedAt: nowIso(),
            completedAt: nowIso(),
            resultSummary: note,
            blockedReason: note,
            activeRunId: null,
            pendingResumeToken: null,
          });
          const event = this.events.append({
            sessionId,
            type: "run_failed",
            summary: note,
            payload: {
              runId: blockedRun.id,
              stepId: completedStep.id,
              toolCallId: doomLoop.id,
              stopReason: note,
            },
          });
          yield { type: "run_failed", run: blockedRun, error: note, event };
          yield { type: "done", sessionId, runId: blockedRun.id };
          return;
        }

        currentPrompt = prompt;
        pendingPermission = null;
      }

      const stoppedRun = this.store.updateRun(run.id, {
        status: "completed",
        completedAt: nowIso(),
        stopReason: "max_steps",
      });
      const summary = "Maximum steps reached. Summarize the current status.";
      logger.info(
        {
          sessionId,
          runId: stoppedRun.id,
          stepCount: stoppedRun.currentStep,
          summary,
        },
        "[agent-runtime] max steps reached",
      );
      const assistantMessage = this.finishAssistantMessage(
        sessionId,
        run.id,
        null,
        summary,
        input.model ?? null,
        input.purpose ?? profile.kind,
        undefined,
      );
      this.store.updateSession(sessionId, {
        status: "completed",
        updatedAt: nowIso(),
        completedAt: nowIso(),
        resultSummary: summary,
        activeRunId: null,
        pendingResumeToken: null,
      });
      const completedEvent = this.events.append({
        sessionId,
        type: "run_completed",
        summary,
        payload: { runId: stoppedRun.id, stopReason: "max_steps" },
      });
      yield { type: "message", message: assistantMessage };
      yield {
        type: "run_completed",
        run: stoppedRun,
        message: assistantMessage,
        event: completedEvent,
      };
      yield { type: "done", sessionId, runId: stoppedRun.id };
    } catch (error) {
      const abortReason =
        runAbortSignal.aborted && 'reason' in runAbortSignal
          ? (runAbortSignal as AbortSignal & { reason?: unknown }).reason
          : undefined;
      const message =
        abortReason instanceof Error
          ? abortReason.message
          : typeof abortReason === 'string'
            ? abortReason
            : error instanceof Error
              ? error.message
              : String(error);
      logger.error(
        {
          sessionId,
          runId: run.id,
          aborted: Boolean(runAbortSignal.aborted),
          err: error,
        },
        "[agent-runtime] run failed",
      );
      const isAbort = Boolean(runAbortSignal.aborted);
      const failedRun = this.store.updateRun(run.id, {
        status: isAbort ? "interrupted" : "failed",
        completedAt: nowIso(),
        stopReason: message,
      });

      // If session was already set to 'paused' (by pause()), don't overwrite
      const currentSession = this.store.getSession(sessionId);
      const sessionStatus = currentSession.status === 'paused'
        ? 'paused'
        : isAbort ? 'interrupted' : 'failed';

      this.store.updateSession(sessionId, {
        status: sessionStatus,
        updatedAt: nowIso(),
        completedAt: sessionStatus === 'failed' ? nowIso() : null,
        blockedReason: message,
        resultSummary: message,
        activeRunId: null,
        pendingResumeToken: null,
      });
      const failedEvent = this.events.append({
        sessionId,
        type: "run_failed",
        summary: message,
        payload: { runId: failedRun.id, error: message, resumable: sessionStatus !== 'failed' },
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
        try {
          const finalRun = this.store.getRun(run.id);
          void sessionHooks.emit({ type: 'run:completed', sessionId, runId: run.id, status: finalRun.status });
        } catch { /* run may not exist if creation failed */ }
      }
      activeExecution.dispose();
    }
  }

  interruptSessions(
    sessionIds: Iterable<string>,
    reason = "Agent runtime session deleted by user.",
  ): void {
    for (const sessionId of sessionIds) {
      for (const controller of this.activeSessionControllers.get(sessionId) ?? []) {
        if (!controller.signal.aborted) {
          controller.abort(new Error(reason));
        }
      }
    }
  }

  async waitForIdleSessions(
    sessionIds: Iterable<string>,
    timeoutMs = ACTIVE_SESSION_TIMEOUT_MS,
  ): Promise<void> {
    const ids = [...new Set(sessionIds)];
    const deadline = Date.now() + timeoutMs;
    while (ids.some((sessionId) => (this.activeSessionControllers.get(sessionId)?.size ?? 0) > 0)) {
      if (Date.now() >= deadline) {
        throw new AgentRuntimeError(
          "Timed out while waiting for active agent runtime sessions to stop.",
          "DELETE_TIMEOUT",
          409,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, ACTIVE_SESSION_WAIT_MS));
    }
  }

  async interruptAndWaitForSessions(
    sessionIds: Iterable<string>,
    reason = "Agent runtime session deleted by user.",
    timeoutMs = ACTIVE_SESSION_TIMEOUT_MS,
  ): Promise<void> {
    this.interruptSessions(sessionIds, reason);
    await this.waitForIdleSessions(sessionIds, timeoutMs);
  }

  private createRun(
    sessionId: string,
    triggerMessageId: string,
    model: string | null,
  ): AgentRun {
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
    prompt: string;
    input: StreamTurnRequest;
    profile: ReturnType<ProfileService["get"]>;
    context: AgentContextBundle | null;
    history: AgentRuntimeMessage[];
    previousParts: AgentRunPart[];
    previousToolCalls: ToolCallRecord[];
    stepIndex: number;
    maxSteps: number;
    mustFinalize: boolean;
    blockedByPermission: boolean;
    disclosureState: DisclosureState | null;
    disclosureStrategy: DisclosureStrategy | null;
    abortSignal?: AbortSignal;
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
        type: 'step_complete',
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
      .list()
      .filter(
        (tool) =>
          input.profile.allowedCapabilities.includes(tool.id) ||
          tool.category === "skill" ||
          tool.id === "tools.invalid",
      );
    const visibleTools =
      input.disclosureState && input.disclosureStrategy
        ? filterByDisclosure(availableTools, input.disclosureState, input.disclosureStrategy)
        : availableTools;
    const toolSet = buildLoopToolSet(availableTools, visibleTools);
    let conversationMessages = buildLoopModelMessages(
      this.store,
      input.sessionId,
      toolSet,
    );

    const systemPromptContent = buildLoopSystemPrompt({
      profile: input.profile,
      context: input.context,
      history: input.history,
      previousParts: input.previousParts,
      previousToolCalls: input.previousToolCalls,
      currentPrompt: input.prompt,
      maxSteps: input.maxSteps,
      stepIndex: input.stepIndex,
      mustFinalize: input.mustFinalize,
      disclosureHint:
        input.disclosureState && input.disclosureStrategy && !isTerminalTier(input.disclosureState, input.disclosureStrategy)
          ? 'Currently in exploration mode. Call tools_escalate when ready to write files.'
          : undefined,
    });

    const contextLimit = (input as { contextLimit?: number }).contextLimit ?? DEFAULT_CONTEXT_LIMIT;
    const compactionConfig = getCompactionConfig();
    const systemTokens = countTokens(systemPromptContent, input.input.model ?? undefined);
    const conversationTokens = countMessagesTokens(
      conversationMessages as unknown as import('../llm-runtime/types.js').LlmGatewayMessage[],
      input.input.model ?? undefined,
    );
    const toolTokens = estimateToolDefinitionsTokens(visibleTools.length, input.input.model ?? undefined);
    const totalTokens = systemTokens + conversationTokens + toolTokens;

    if (shouldCompact(totalTokens, contextLimit, compactionConfig)) {
      logger.info(
        {
          sessionId: input.sessionId,
          stepIndex: input.stepIndex,
          totalTokens,
          contextLimit,
          threshold: compactionConfig.threshold,
        },
        "[agent-runtime] context approaching limit, triggering compaction",
      );

      const compactionResult = await compactMessages(conversationMessages, {
        sessionId: input.sessionId,
        runId: input.input.purpose ?? null,
        model: input.input.model ?? undefined,
        contextLimit,
        config: compactionConfig,
        generateSummary: async (sysPrompt, userPrompt) => {
          const summaryResult = await generateLoopModelStep({
            request: {
              projectId: this.store.getSession(input.sessionId).projectId,
              purpose: 'context-compaction',
              model: compactionConfig.summaryModel ?? input.input.model,
              messages: [
                { role: 'system' as const, content: sysPrompt },
                { role: 'user' as const, content: userPrompt },
              ],
              maxTokens: compactionConfig.maxSummaryTokens,
            },
            tools: buildLoopToolSet([]),
            mustFinalize: true,
            model: compactionConfig.summaryModel ?? input.input.model ?? null,
            abortSignal: input.abortSignal,
          });
          return summaryResult.step.message ?? '';
        },
      });

      if (compactionResult.didCompact && compactionResult.record) {
        conversationMessages = compactionResult.messages;
        this.store.saveCompactionRecord(compactionResult.record);
        this.events.append({
          sessionId: input.sessionId,
          type: 'progress_updated',
          summary: `Context compacted: ${compactionResult.record.originalTokenCount} → ${compactionResult.record.compressedTokenCount} tokens`,
          payload: {
            kind: 'compaction',
            originalTokens: compactionResult.record.originalTokenCount,
            compressedTokens: compactionResult.record.compressedTokenCount,
            messageCount: compactionResult.record.compressedMessageCount,
          },
        });
      }
    }

    const lastUserMessage = [...conversationMessages]
      .reverse()
      .find((message) => message.role === "user");
    const needsInstructionOverride =
      input.stepIndex > 1 &&
      input.prompt.trim().length > 0 &&
      !(
        lastUserMessage?.role === "user" &&
        typeof lastUserMessage.content === "string" &&
        lastUserMessage.content.trim() === input.prompt.trim()
      );

    const todoDriftReminder = input.stepIndex > 1 ? buildTaskDriftReminder(input.sessionId) : null;

    const request = {
      projectId: this.store.getSession(input.sessionId).projectId,
      purpose: input.input.purpose ?? input.profile.kind,
      model: input.input.model,
      messages: [
        {
          role: "system" as const,
          content: systemPromptContent,
        },
        ...conversationMessages,
        ...(todoDriftReminder
          ? [
              {
                role: "user" as const,
                content: `<system-reminder>\n${todoDriftReminder}\n</system-reminder>`,
              },
            ]
          : []),
        ...(needsInstructionOverride
          ? [
              {
                role: "user" as const,
                content: `<system-reminder>\n${input.prompt.trim()}\n</system-reminder>`,
              },
            ]
          : []),
      ],
      temperature: input.input.temperature,
      maxTokens: input.input.maxTokens,
    };
    yield* streamLoopModelStep({
      request,
      tools: toolSet,
      mustFinalize: input.mustFinalize,
      model: input.input.model ?? null,
      abortSignal: input.abortSignal,
    });
  }

  private async persistStepOutput(
    runId: string,
    stepId: string,
    sessionId: string,
    step: LoopStepModelResult["step"],
  ): Promise<AgentRunPart[]> {
    const parts: AgentRunPart[] = [];
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
          createdAt: nowIso(),
        }),
      );
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
  ): AgentRuntimeMessage {
    return this.store.appendMessage({
      id: makeRuntimeId("msg"),
      sessionId,
      runId,
      stepId,
      role: "assistant",
      content,
      metadata: { model, purpose, usage },
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

    for await (const _chunk of this.streamRun(
      childSessionId,
      {},
      abortSignal,
    )) {
      // The child run persists its own messages/events; the parent only needs the final summary.
    }

    const childSession = this.store.getSession(childSessionId);
    const childSummary =
      childSession.resultSummary ??
      `Child session ${childSessionId} finished with status ${childSession.status}.`;
    const status =
      childSession.status === "completed" ? record.status : "failed";
    const outputSummary = truncateSummary(
      `Subtask ${childSessionId} ${childSession.status}: ${childSummary}`,
    );
    const updated = this.store.updateToolCall(record.sessionId, record.id, {
      status,
      outputSummary,
      outputRef: {
        ...(result as Record<string, unknown>),
        childSessionId,
        childStatus: childSession.status,
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
        childStatus: childSession.status,
      },
    });
    return updated;
  }

  private tryGetContext(contextSnapshotId: string): AgentContextBundle | null {
    try {
      return this.store.getContextBundle(contextSnapshotId);
    } catch {
      return null;
    }
  }

  private buildContinuationPrompt(sessionId: string, status: string): string {
    if (status === 'paused') {
      return 'Session was paused by user. Continue from where you left off.';
    }
    if (status === 'failed') {
      return 'Session previously failed. Review the error and previous context, then retry the task from where it left off.';
    }

    const runs = this.store.listRuns(sessionId);
    const lastRun = runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!lastRun) {
      return 'Session was interrupted. Continue working on the original task using tools.';
    }

    const incompleteTools = this.store
      .listRunToolCalls(lastRun.id)
      .filter(tc => tc.status === 'running' || tc.status === 'pending');

    const parts: string[] = [
      'Session was interrupted (server restarted). You MUST continue the original task — do NOT just summarize what happened.',
    ];

    if (incompleteTools.length > 0) {
      const toolList = incompleteTools
        .map(tc => `- ${tc.toolId}(${tc.inputSummary?.slice(0, 80) ?? ''})`)
        .join('\n');
      parts.push(
        `The following tool calls were interrupted and did not complete:\n${toolList}\nRetry these operations as needed to continue the task.`,
      );
    } else {
      parts.push(
        'Review your previous tool calls and results. If the task is not fully complete, continue using tools. Only produce a final summary if ALL objectives from the original prompt have been achieved.',
      );
    }

    return parts.join('\n\n');
  }

  private beginSessionExecution(
    sessionId: string,
    abortSignal?: AbortSignal,
  ): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const onAbort = () => {
      const reason =
        abortSignal && 'reason' in abortSignal
          ? (abortSignal as AbortSignal & { reason?: unknown }).reason
          : undefined;
      if (!controller.signal.aborted) {
        controller.abort(reason instanceof Error ? reason : new Error(String(reason ?? "Run interrupted by client.")));
      }
    };

    if (abortSignal?.aborted) {
      onAbort();
    } else {
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    }

    const controllers = this.activeSessionControllers.get(sessionId) ?? new Set<AbortController>();
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

export const agentLoopRuntime = new AgentLoopRuntime();

function withIds(toolCalls: StructuredToolCall[]): StructuredToolCall[] {
  return toolCalls.map((toolCall) => ({
    ...toolCall,
    id: normalizeToolCallId(toolCall.id),
  }));
}

function normalizeToolCallId(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
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
