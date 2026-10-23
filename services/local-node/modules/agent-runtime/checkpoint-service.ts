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
}): Promise<ContextCheckpoint | null> {
  const timeout = AbortSignal.timeout(300_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  signal.throwIfAborted();
  const head = input.head ?? await readCheckpointHead(input.sessionId);
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
        const page = await command<{ items: CheckpointTextSlice[]; cursor: unknown }>(input.sessionId, "context_messages", {
          fromRevision: head.checkpoint?.throughRevision ?? 0,
          throughRevision: active.throughRevision, generation: active.indexGeneration, cursor,
        });
        signal.throwIfAborted();
        if (page.cursor && JSON.stringify(page.cursor) === JSON.stringify(cursor)) throw new Error("checkpoint_cursor_did_not_advance");
        yield page.items;
        cursor = page.cursor;
      } while (cursor);
    }
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
        await command(input.sessionId, "append_entities", { objects: [{ kind: "runtime.aux_usage", value: {
          id: `usage_${randomUUID()}`, sessionId: input.sessionId, runId, purpose: "context-compaction",
          startedAt: active.startedAt, completedAt: new Date().toISOString(), usage: result.usage,
        } }] });
        return { text: result.text, finishReason: result.finishReason };
      },
    });
    signal.throwIfAborted();
    if (!checkpoint || !await input.validate(checkpoint)) {
      await command(input.sessionId, "context_finish", { runId, status: "completed" }, `finish:${runId}`);
      notify(input.sessionId, active, "completed", { compacted: false });
      return null;
    }
    signal.throwIfAborted();
    await command(input.sessionId, "context_commit", { checkpoint, ...authority }, `commit:${runId}`);
    committed = true;
    notify(input.sessionId, active, "completed", { compacted: true, checkpointId: checkpoint.id });
    return checkpoint;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A lost commit response must be reconciled before reporting failure or
    // allowing another model call. Never overwrite a completed durable run.
    const current = await readCheckpointHead(input.sessionId);
    if (committed || current.checkpoint?.compactionRunId === runId) {
      notify(input.sessionId, active, "completed", { compacted: true, checkpointId: current.checkpoint?.id });
      return current.checkpoint;
    }
    if (current.active?.runId === runId && current.active.status === "running")
      await command(input.sessionId, "context_finish", { runId, status: signal.aborted ? "interrupted" : "failed", error: message.slice(0, 1000) }, `fail:${runId}`);
    notify(input.sessionId, active, "failed", { error: message });
    throw error;
  }
}
