import { randomUUID } from "node:crypto";
import { buildContextCheckpoint, type CheckpointTextSlice } from "./checkpoint-builder.js";
import { CHECKPOINT_MAX_SUMMARY_TOKENS, type ContextBudget, type ContextCheckpoint } from "./context-checkpoint.js";
import { countTokens } from "./context-tokenizer.js";
import { runtimeClient, decode } from "./sidecar/runtime-repository.js";
import { generateGatewayTextResult } from "../../infrastructure/llm-runtime/gateway.js";
import { emitSessionLive } from "../../infrastructure/runtime/ipc/agent-session-protocol.js";
import type { ContextCompactionState } from "./context-compaction-types.js";
import type { AgentRuntimeMessage } from "./contracts.js";
import { currentExecutionContext } from "../../infrastructure/runtime/execution-context.js";
import { logger } from "../../infrastructure/runtime/logger.js";
import { agentRuntimeStore } from "./session-store.js";
import { compactedContextUsageSnapshot, readContextUsage, type ContextUsageSnapshot } from "./analytics-projection.js";

export interface CheckpointHead {
  checkpoint: ContextCheckpoint | null;
  checkpointObjectId?: string;
  active: {
    runId: string; stepId: string; status: string; startedAt: string;
    throughRevision: number; throughStepId: string; sourceFingerprint: string;
    indexGeneration: number;
    boundaryAt?: string;
  } | null;
  revision: number;
  generation: number;
  latestStepId: string | null;
  throughRevision?: number | null;
}

async function command<T>(sessionId: string, operation: string, payload: unknown, requestId: string = randomUUID()): Promise<T> {
  return decode<T>(await runtimeClient().historyCommand({ sessionId, operation, payload, requestId }));
}

function isTerminalCompactionError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /COMPACTION_(CONFIGURATION_CHANGED|SOURCE_CHANGED|OWNER_SUPERSEDED|SUPERSEDED|EXPIRED)|REVISION_CONFLICT/.test(text);
}

/** History commands are receipt-idempotent. Retry transport/storage blips
 * with the same request ID, while semantic ownership conflicts fail fast. */
async function commandWithRetry<T>(
  sessionId: string,
  operation: string,
  payload: unknown,
  requestId: string,
  attempts = 3,
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await command<T>(sessionId, operation, payload, requestId);
    } catch (error) {
      last = error;
      if (isTerminalCompactionError(error) || attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export function readCheckpointHead(sessionId: string): Promise<CheckpointHead> {
  return command(sessionId, "context_current", {});
}

export function recoverCheckpointHead(sessionId: string): Promise<CheckpointHead> {
  return command(sessionId, "context_recover", {});
}

function notify(sessionId: string, active: NonNullable<CheckpointHead["active"]>, status: ContextCompactionState["status"], extra: Partial<ContextCompactionState> = {}): void {
  const state: ContextCompactionState = {
    id: `context:${active.runId}`, runId: active.runId, stepId: active.stepId,
    throughStepId: active.throughStepId, throughRevision: active.throughRevision, boundaryAt: active.boundaryAt,
    status, startedAt: active.startedAt, requestId: null,
    ...(status === "running" ? {} : { completedAt: new Date().toISOString() }), ...extra,
  };
  const message: AgentRuntimeMessage = {
    id: state.id, sessionId, runId: active.runId, stepId: active.stepId, role: "system",
    content: status === "running" ? "正在压缩上下文" : status === "failed" ? "上下文压缩失败" : state.compacted ? "上下文已压缩" : "上下文无需进一步压缩",
    createdAt: active.startedAt, metadata: { source: "context_compaction", contextCompaction: state },
  };
  emitSessionLive(sessionId, { type: "context_compaction_state", state, message });
}

export function persistCompactedContextUsage(
  sessionId: string,
  stepId: string,
  compressedTokens: number,
  limit: number,
): ContextUsageSnapshot | null {
  try {
    const session = agentRuntimeStore.getSession(sessionId);
    const previous = readContextUsage(session.sessionMetadata?.contextUsage);
    const snapshot = compactedContextUsageSnapshot(previous, compressedTokens, stepId, limit);
    if (!snapshot) return null;
    agentRuntimeStore.updateSessionMetadata(sessionId, { contextUsage: snapshot });
    return snapshot;
  } catch (error) {
    logger.warn({ sessionId, error: String(error) }, "Post-compaction context usage persistence skipped");
    return null;
  }
}

export async function runSessionCheckpoint(input: {
  sessionId: string;
  projectId: string;
  model?: string;
  budget: ContextBudget;
  summaryBudget: number;
  signal?: AbortSignal;
  ownerId?: string;
  recompact?: boolean;
  head?: CheckpointHead;
  /** Called before persistence with the exact candidate; must check the
   * complete next request, including required context and native media. */
  validate(checkpoint: ContextCheckpoint): Promise<boolean> | boolean;
  /** Called after the durable commit to persist derived UI usage metadata. */
  onCommitted?: (checkpoint: ContextCheckpoint) => Promise<ContextUsageSnapshot | null> | ContextUsageSnapshot | null;
}): Promise<ContextCheckpoint | null> {
  const timeout = AbortSignal.timeout(300_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  signal.throwIfAborted();
  let head = input.head ?? await readCheckpointHead(input.sessionId);
  if (head.active?.status === "running") head = await recoverCheckpointHead(input.sessionId);
  if (!head.latestStepId || !input.recompact && head.checkpoint?.throughStepId === head.latestStepId) return null;
  const runId = `run_cmp_${randomUUID()}`;
  const authority = { ownerId: input.ownerId, executionContext: currentExecutionContext() };
  const active = await command<NonNullable<CheckpointHead["active"]>>(input.sessionId, "context_begin", {
    runId, stepId: `stp_cmp_${randomUUID()}`, throughStepId: head.latestStepId,
    expectedRevision: head.revision, model: input.model ?? null,
    ...authority,
  }, `begin:${runId}`);
  notify(input.sessionId, active, "running");
  let committed = false;
  try {
    async function* pages(): AsyncGenerator<CheckpointTextSlice[]> {
      if (input.recompact && head.checkpoint && head.checkpointObjectId) {
        const source = JSON.stringify({ summary: head.checkpoint.summary, sourceRefs: head.checkpoint.sourceRefs });
        let offset = 0;
        while (offset < source.length) {
          signal.throwIfAborted();
          let end = Math.min(offset + 8192, source.length);
          if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end--;
          yield [{ objectId: head.checkpointObjectId, role: "assistant", text: source.slice(offset, end), offset }];
          offset = end;
        }
      }
      let cursor: unknown = null;
      do {
        signal.throwIfAborted();
        const page = await commandWithRetry<{ items: CheckpointTextSlice[]; cursor: unknown }>(input.sessionId, "context_messages", {
          fromRevision: head.checkpoint?.throughRevision ?? 0,
          throughRevision: active.throughRevision, generation: active.indexGeneration, cursor,
        }, `messages:${runId}:${cursor ? JSON.stringify(cursor) : "root"}`);
        signal.throwIfAborted();
        if (page.cursor && JSON.stringify(page.cursor) === JSON.stringify(cursor)) throw new Error("checkpoint_cursor_did_not_advance");
        yield page.items;
        cursor = page.cursor;
      } while (cursor);
    }
    let usageSequence = 0;
    const checkpoint = await buildContextCheckpoint({
      identity: { version: 1, id: `cmp_${randomUUID()}`, sessionId: input.sessionId,
        compactionRunId: runId, throughRevision: active.throughRevision, throughStepId: active.throughStepId,
        sourceFingerprint: active.sourceFingerprint, createdAt: new Date().toISOString() },
      previous: input.recompact ? null : head.checkpoint, pages: pages(), budget: input.budget,
      summaryBudget: Math.min(input.summaryBudget, CHECKPOINT_MAX_SUMMARY_TOKENS),
      countTokens: text => countTokens(text, input.model), signal,
      generate: async request => {
        const result = await generateGatewayTextResult({
          projectId: input.projectId, model: input.model, purpose: "context-compaction",
          messages: [{ role: "system", content: request.instructions }, { role: "user", content: request.data }],
          temperature: 0.2, maxTokens: request.maxOutputTokens, maxRetries: 2,
          reasoningEffort: "none", responseOptions: { store: false },
        }, request.signal);
        // Bounded usage records belong to the special run; no summary source
        // or generated tokens are echoed through the UI event stream.
        const usage = { id: `usage_${runId}_${usageSequence++}`, sessionId: input.sessionId, runId,
          purpose: "context-compaction", startedAt: active.startedAt,
          completedAt: new Date().toISOString(), usage: result.usage };
        try {
          await commandWithRetry(input.sessionId, "append_entities", { objects: [{ kind: "runtime.aux_usage", value: usage }] }, `usage:${usage.id}`);
        } catch (error) {
          // Usage telemetry is auxiliary. A telemetry write must never turn a
          // valid checkpoint into a failed compaction.
          logger.warn({ sessionId: input.sessionId, runId, error: String(error) }, "Context checkpoint usage write skipped");
        }
        return { text: result.text, finishReason: result.finishReason };
      },
    });
    signal.throwIfAborted();
    if (!checkpoint || !await input.validate(checkpoint)) {
      await commandWithRetry(input.sessionId, "context_finish", { runId, status: "completed" }, `finish:${runId}`);
      notify(input.sessionId, active, "completed", { compacted: false });
      return null;
    }
    signal.throwIfAborted();
    await commandWithRetry(input.sessionId, "context_commit", { checkpoint, ...authority }, `commit:${runId}`);
    committed = true;
    const contextUsage = await input.onCommitted?.(checkpoint);
    notify(input.sessionId, active, "completed", {
      compacted: true,
      checkpointId: checkpoint.id,
      ...(contextUsage ? { contextUsage } : {}),
    });
    return checkpoint;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A lost commit response must be reconciled before reporting failure or
    // allowing another model call. Never overwrite a completed durable run.
    let current: CheckpointHead | null = null;
    try {
      current = await readCheckpointHead(input.sessionId);
    } catch {
      // The current checkpoint may itself be unreadable after a storage fault.
      // The special run still has a durable identity, so its terminal record
      // can be written without reading the checkpoint head first.
    }
    if (committed || current?.checkpoint?.compactionRunId === runId) {
      notify(input.sessionId, active, "completed", { compacted: true, checkpointId: current?.checkpoint?.id });
      return current?.checkpoint ?? null;
    }
    // Always attempt a terminal write from the run identity captured at
    // context_begin. A failed head read must not leave the UI's special run
    // in `running` forever. If another actor already finished it, the
    // sidecar returns COMPACTION_SUPERSEDED and the desired terminal state is
    // already durable.
    try {
      await commandWithRetry(input.sessionId, "context_finish", {
        runId,
        status: signal.aborted ? "interrupted" : "failed",
        error: message.slice(0, 1000),
      }, `fail:${runId}`);
    } catch (finishError) {
      const finishMessage = finishError instanceof Error ? finishError.message : String(finishError);
      if (!finishMessage.includes("COMPACTION_SUPERSEDED")) {
        // Preserve the original provider/storage error for the caller while
        // retaining a diagnostic for the rare terminal-write failure.
        logger.warn({ sessionId: input.sessionId, runId, error: finishMessage }, "Context checkpoint terminal write failed");
      }
    }
    notify(input.sessionId, active, "failed", { error: message });
    throw error;
  }
}
