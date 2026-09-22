import { compileCompletedPrototypes } from "../prototype-integration.js";
import { validateInputMedia } from '../media-capabilities.js';
import { hasInlineMedia, normalizeMediaPayload } from '../media-tool-content.js';
import { acpMediaInput } from '../media-backend-input.js';
import { normalizeInput, hasInput, type RuntimeContentPart } from '../content-parts.js';
import { withDeadline } from '../managed-process.js';
import { activateAcceptedRun } from '../run-admission.js';
import type { AgentSessionStreamMode } from '../../../lib/ipc/agent-session-protocol.js';
import { logger } from '../../../lib/logger.js';
import {
  captureFileChangeBaseline,
  captureFileChanges,
  type FileChangeBaseline,
} from '../../acp/file-change-capture.js';
import type {
  AgentRunStreamChunk,
  StreamTurnRequest,
} from '../contracts.js';
import { AgentRuntimeError, AgentValidationError } from '../runtime-errors.js';
import { makeRuntimeId, nowIso } from '../runtime-ids.js';
import { agentRuntimeStore } from '../session-store.js';
import { acpConnectionPool } from './acp-connection-pool.js';
import { isAcpModel, parseAcpModel } from './acp-model.js';
import { resolveSessionEngineModel, sessionUsesAcpEngine } from './acp-engine-routing.js';
import { mergeAcpSessionMetadata } from './acp-session-metadata.js';
import { acpPermissionBridge } from './acp-permission-bridge.js';
import { acpSessionUpdateRouter } from './acp-session-update-router.js';
import {
  AcpUpdateMapper,
  createPermissionRequestedChunk,
  createRunCompletedChunk,
  createRunFailedChunk,
  createRunStartedChunk,
  createStepStartedChunk,
} from './acp-update-mapper.js';
import {
  mergeStepUsage,
  usageFromAcpPrompt,
  asStepUsageRecord,
} from './acp-usage.js';

type StreamQueueItem =
  | { kind: 'chunk'; chunk: AgentRunStreamChunk }
  | { kind: 'done' }
  | { kind: 'error'; error: string };

class StreamQueue {
  private readonly pending: StreamQueueItem[] = [];
  private resolvers: Array<(item: StreamQueueItem) => void> = [];
  private closed = false;

  push(item: StreamQueueItem): void {
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve(item);
      return;
    }
    this.pending.push(item);
  }

  async next(): Promise<StreamQueueItem> {
    const pending = this.pending.shift();
    if (pending) return pending;
    if (this.closed) return { kind: 'done' };
    return new Promise<StreamQueueItem>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  close(): void {
    this.closed = true;
    for (const resolve of this.resolvers) {
      resolve({ kind: 'done' });
    }
    this.resolvers = [];
  }
}

interface ActiveTurn {
  queue: StreamQueue;
  abortController: AbortController;
  task: Promise<void>;
}

class AcpSessionEngine {
  private readonly activeTurns = new Map<string, ActiveTurn>();

  isSessionStreaming(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  usesAcpSession(sessionId: string): boolean {
    return sessionUsesAcpEngine(sessionId);
  }

  async *stream(
    sessionId: string,
    mode: AgentSessionStreamMode,
    input: StreamTurnRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<AgentRunStreamChunk> {
    const session = agentRuntimeStore.getSession(sessionId);
    if(input.contentParts?.some(p=>p.type!=='text'))await validateInputMedia(sessionId,input);
    const model = resolveSessionEngineModel(sessionId, input);
    if (!isAcpModel(model)) {
      throw new AgentValidationError('Session is not configured for an ACP model.');
    }

    const existing = this.activeTurns.get(sessionId);
    if (existing && (acpPermissionBridge.hasPendingForSession(sessionId) || !existing.queue)) {
      yield* this.consumeQueue(sessionId, existing.queue, abortSignal);
      return;
    }
    if (existing) {
      throw new AgentRuntimeError(
        'Session already has an active run.',
        'SESSION_BUSY',
        409,
      );
    }

    input = normalizeInput(input);
    const prompt = hasInput(input) ? input.message ?? '' : this.resolvePrompt(sessionId, mode, input);
    if (mode === 'resume' && acpPermissionBridge.hasPendingForSession(sessionId)) {
      return;
    }

    const queue = new StreamQueue();
    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) abortController.abort();
      else abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const task = this.runTurn(sessionId, model, prompt, queue, abortController.signal, input.acceptedRunId, input.contentParts);
    this.activeTurns.set(sessionId, { queue, abortController, task });

    try {
      yield* this.consumeQueue(sessionId, queue, abortController.signal);
    } finally {
      await task.catch(() => undefined);
      this.activeTurns.delete(sessionId);
      acpPermissionBridge.clearTurnContext(sessionId);
      acpSessionUpdateRouter.clear(sessionId);
    }
  }

  async interruptSession(sessionId: string, reason = 'Session interrupted.'): Promise<void> {
    acpPermissionBridge.rejectAllForSession(sessionId, reason);
    const active = this.activeTurns.get(sessionId);
    if (active) {
      active.abortController.abort();
      active.queue.close();
    }
    try { await withDeadline(acpConnectionPool.cancelPrompt(sessionId), 1000, 'ACP cancel timed out.'); } catch { /* Stop the host below. */ }
    await acpConnectionPool.evict(sessionId);
    if (active) await withDeadline(active.task, 5000, 'ACP execution shutdown could not be confirmed.');
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.interruptSession(sessionId, 'Session closed.');
    await acpConnectionPool.evict(sessionId);
  }

  private resolvePrompt(
    sessionId: string,
    mode: AgentSessionStreamMode,
    input: StreamTurnRequest,
  ): string {
    const session = agentRuntimeStore.getSession(sessionId);
    const message = input.message?.trim();
    if (message) return message;
    if (mode === 'continue') {
      return `Continue the previous work. Session status: ${session.status}.`;
    }
    return session.prompt;
  }

  private async *consumeQueue(
    sessionId: string,
    queue: StreamQueue,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<AgentRunStreamChunk> {
    while (true) {
      if (abortSignal?.aborted) {
        throw new AgentRuntimeError('Run interrupted by client.', 'ABORTED', 499);
      }
      const item = await queue.next();
      if (item.kind === 'chunk') {
        yield item.chunk;
        continue;
      }
      if (item.kind === 'error') {
        throw new AgentRuntimeError(item.error, 'RUN_FAILED', 500);
      }
      const activeRunId = agentRuntimeStore.getSession(sessionId).activeRunId;
      if (activeRunId) {
        yield { type: 'done', sessionId, runId: activeRunId };
      }
      return;
    }
  }

  private async runTurn(
    sessionId: string,
    model: string,
    prompt: string,
    queue: StreamQueue,
    abortSignal: AbortSignal,
    acceptedRunId?: string,
    contentParts?: RuntimeContentPart[],
  ): Promise<void> {
    const session = agentRuntimeStore.getSession(sessionId);
    const parsed = parseAcpModel(model);
    let baseline: FileChangeBaseline | null = null;

    try {
      const userMessage = agentRuntimeStore.appendMessage({
        id: makeRuntimeId('msg'),
        sessionId,
        runId: null,
        stepId: null,
        role: 'user',
        content: prompt,
        contentParts,
        metadata: { source: 'acp_turn' },
        createdAt: nowIso(),
      });
      queue.push({ kind: 'chunk', chunk: { type: 'message', message: userMessage } });

      const run = acceptedRunId
        ? activateAcceptedRun(sessionId, acceptedRunId, userMessage.id, model)
        : agentRuntimeStore.appendRun({
        id: makeRuntimeId('run'),
        sessionId,
        status: 'running',
        startedAt: nowIso(),
        completedAt: null,
        triggerMessageId: userMessage.id,
        currentStep: 1,
        stopReason: null,
        model,
        metadata: { engine: 'acp', providerId: parsed.providerId },
      });
      const step = agentRuntimeStore.appendRunStep({
        id: makeRuntimeId('step'),
        runId: run.id,
        sessionId,
        index: 1,
        status: 'running',
        model,
        startedAt: nowIso(),
        completedAt: null,
        finishReason: null,
        metadata: { engine: 'acp' },
      });
      agentRuntimeStore.updateSession(sessionId, {
        status: 'running',
        activeRunId: run.id,
        pendingResumeToken: null,
        blockedReason: null,
        completedAt: null,
        updatedAt: nowIso(),
        sessionMetadata: mergeAcpSessionMetadata(session, { engineModel: model }),
      });

      queue.push({ kind: 'chunk', chunk: createRunStartedChunk(sessionId, run, userMessage.id) });
      queue.push({ kind: 'chunk', chunk: createStepStartedChunk(sessionId, step) });

      const pooled = await acpConnectionPool.acquire({
        synaxSessionId: sessionId,
        projectId: session.projectId,
        providerId: parsed.providerId,
      });
      baseline = await captureFileChangeBaseline(pooled.workDir);

      const mapper = new AcpUpdateMapper({
        sessionId,
        run,
        step,
        isReplay: pooled.isReplay,
      });

      let updates = Promise.resolve();
      let updateError: unknown;
      acpSessionUpdateRouter.set(sessionId, (params) => {
        if (params.sessionId !== pooled.acpSessionId) return;
        updates = updates.then(async () => {
          let update: typeof params.update & {contentParts?:RuntimeContentPart[]} = params.update;
          if (hasInlineMedia(update)) {
            const normalized = await normalizeMediaPayload(session.projectId, update);
            update = { ...(normalized.value as typeof update), contentParts: normalized.contentParts } as typeof update;
          }
          const chunks = mapper.mapUpdate(update);
          for (const chunk of chunks) queue.push({ kind: 'chunk', chunk });
          if (!pooled.isReplay) acpConnectionPool.clearReplay(sessionId);
        }).catch(error => { updateError ??= error; });
      });

      acpPermissionBridge.setTurnContext(sessionId, {
        sessionId,
        acpSessionId: pooled.acpSessionId,
        runId: run.id,
        stepId: step.id,
        rules: session.permissionRules,
        isSubSession: Boolean(session.parentSessionId),
        onPermissionRequested: (decision, toolCall) => {
          queue.push({
            kind: 'chunk',
            chunk: createPermissionRequestedChunk(run.id, step.id, decision, toolCall),
          });
        },
      });

      if (abortSignal.aborted) {
        throw new AgentRuntimeError('Run interrupted by client.', 'ABORTED', 499);
      }

      await acpConnectionPool.applySessionModel(sessionId, parsed.modelId);

      const promptResult = await pooled.connection.conn.prompt({
        sessionId: pooled.acpSessionId,
        prompt: await acpMediaInput(contentParts ?? [], prompt),
      });

      await updates;
      if (updateError) throw updateError;
      acpConnectionPool.touch(sessionId);
      const assistantMessage = mapper.finalizeAssistantMessage();
      const captured = await captureFileChanges(pooled.workDir, [], baseline);
      const stopReason = promptResult.stopReason ?? 'end_turn';
      const failed = stopReason !== 'end_turn' && stopReason !== 'max_tokens';
      if (assistantMessage && stopReason === 'end_turn') await compileCompletedPrototypes(assistantMessage, abortSignal);

      const currentStep = agentRuntimeStore.getRunStep(step.id);
      const usage = mergeStepUsage(
        mergeStepUsage(
          asStepUsageRecord(currentStep.metadata.usage),
          mapper.getAccumulatedUsage(),
        ),
        promptResult.usage ? usageFromAcpPrompt(promptResult.usage) : {},
      );
      const stepMetadata = Object.keys(usage).length > 0
        ? { ...currentStep.metadata, usage }
        : currentStep.metadata;

      const completedRun = agentRuntimeStore.updateRun(run.id, {
        status: failed ? 'failed' : 'completed',
        completedAt: nowIso(),
        stopReason,
        metadata: {
          ...run.metadata,
          fileChanges: captured.fileChanges,
          changeSummary: captured.changeSummary,
        },
      });
      agentRuntimeStore.updateRunStep(step.id, {
        status: failed ? 'failed' : 'completed',
        completedAt: nowIso(),
        finishReason: stopReason,
        metadata: stepMetadata,
      });
      agentRuntimeStore.updateSession(sessionId, {
        status: failed ? 'failed' : 'completed',
        activeRunId: null,
        pendingResumeToken: null,
        completedAt: failed ? null : nowIso(),
        resultSummary: assistantMessage?.content ?? null,
        updatedAt: nowIso(),
      });

      if (failed) {
        queue.push({
          kind: 'chunk',
          chunk: createRunFailedChunk(sessionId, completedRun, `ACP stop reason: ${stopReason}`),
        });
      } else {
        queue.push({
          kind: 'chunk',
          chunk: createRunCompletedChunk(sessionId, completedRun, assistantMessage),
        });
      }
      queue.push({ kind: 'done' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ sessionId, error: message }, '[AcpSessionEngine] turn failed');
      const activeRunId = agentRuntimeStore.getSession(sessionId).activeRunId;
      if (activeRunId) {
        const failedRun = agentRuntimeStore.updateRun(activeRunId, {
          status: abortSignal.aborted ? 'interrupted' : 'failed',
          completedAt: nowIso(),
          stopReason: message,
        });
        agentRuntimeStore.updateSession(sessionId, {
          status: abortSignal.aborted ? 'interrupted' : 'failed',
          activeRunId: null,
          blockedReason: message,
          updatedAt: nowIso(),
        });
        queue.push({
          kind: 'chunk',
          chunk: createRunFailedChunk(sessionId, failedRun, message),
        });
      }
      queue.push({ kind: 'error', error: message });
    } finally {
      queue.close();
    }
  }
}

export const acpSessionEngine = new AcpSessionEngine();
