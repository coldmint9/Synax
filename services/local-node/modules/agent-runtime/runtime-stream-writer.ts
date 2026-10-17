import { logger } from '../../infrastructure/runtime/logger.js';
import { randomUUID } from 'node:crypto';
import { historyEpoch } from "./checkpoints/guards.js";
import { agentRuntimeStore } from './session-store.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import type { AgentRunStreamChunk } from './contracts.js';
import { runtimeJournal, runtimeRecordState } from './runtime-journal.js';
import { invalidateSessionEnvironment } from './session-environment.js';
import { runtimeFacade } from './sidecar/runtime-facade.js';

/**
 * The journal admission budget uses this conservative upper bound for the
 * coalesced stream cadence. The writer itself no longer schedules a delta timer.
 */
export const DELTA_FLUSH_MS = 40;

/** Shared by background runs and embedded hosts; it never moves a host or takes ownership of its tools. */
export class RuntimeStreamWriter {
  private pending: AgentRunStreamChunk[] = [];
  private readonly revision: number;
  private writes = new Set<Promise<void>>();
  private writeFailure?: Error;
  private partialContent?: string;
  private partialStepId?: string;
  private sidecarProducerSequence = 0;
  private readonly sidecarProducerId = `node:${process.pid}:${randomUUID()}`;
  private sidecarTail: Promise<void> = Promise.resolve();
  private sidecarFence?: Promise<{ epoch: number; revision: number }>;
  private sidecarPending = 0;
  private shadowStopped = false;
  constructor(private readonly sessionId: string, private runId?: string, private readonly current: () => boolean = () => true) { this.revision = historyEpoch(sessionId); }

  /** Acknowledgement barrier, including failures from a timer-driven delta flush. */
  async settled(): Promise<void> {
    await Promise.all(this.writes);
    if (this.writeFailure) throw this.writeFailure;
  }

  private isCurrent(): boolean { return this.current() && historyEpoch(this.sessionId) === this.revision; }

  write(chunk: AgentRunStreamChunk): void {
    if (!this.isCurrent()) { this.abandon(); return; }
    const commit: AgentRunStreamChunk[] = [];
    if (!this.runId) {
      if ('run' in chunk && chunk.run) this.runId = chunk.run.id;
      else if ('runId' in chunk) this.runId = chunk.runId;
      else if (chunk.type === 'step_started') this.runId = chunk.step.runId;
      if (!this.runId) { if (this.pending.length >= 64) throw new Error("Run identity was not established before the bounded stream queue filled."); this.pending.push(chunk); return; }
      commit.push(...this.pending);
      this.pending = [];
    }
    // loop-delta-bursts already coalesces model deltas before they reach the
    // runtime writer. Persist each coalesced event directly so this layer does
    // not concatenate the same stream a second time or schedule another timer.
    commit.push(chunk);
    this.commit(commit);
    // A completed write-class tool call invalidates the cached workspace
    // snapshot so the next environment poll reflects the edit immediately.
    if (chunk.type === 'tool_result' && chunk.toolCall && (chunk.toolCall as { mutability?: string }).mutability === 'write') {
      invalidateSessionEnvironment(this.sessionId);
    }
  }

  /** Append the burst in one transaction; a lone chunk keeps the plain append path. */
  private commit(chunks: AgentRunStreamChunk[]): void {
    const runId = this.runId;
    if (!runId || chunks.length === 0) return;
    if (this.writeFailure) throw this.writeFailure;
    if (runtimeFacade.streamMode() === 'authoritative') {
      if (this.sidecarPending >= 128) throw new Error('Runtime sidecar stream queue is full.');
      this.enqueueSidecar(runId, chunks, true);
      return;
    }
    if (chunks.length === 1) runtimeJournal.append(this.sessionId, runId, chunks[0]);
    else runtimeJournal.appendBatch(this.sessionId, runId, chunks);
    if (runtimeFacade.streamMode() === 'shadow') this.enqueueSidecar(runId, chunks, false);
  }

  private enqueueSidecar(runId: string, chunks: AgentRunStreamChunk[], authoritative: boolean): void {
    if (!authoritative && this.shadowStopped) return;
    if (this.sidecarPending >= 128) {
      if (authoritative) throw new Error('Runtime sidecar stream queue is full.');
      this.shadowStopped = true;
      logger.warn({ sessionId: this.sessionId, runId }, '[runtime-sidecar] shadow stream queue full; mirroring stopped');
      return;
    }
    const producerSequence = ++this.sidecarProducerSequence;
    this.sidecarPending++;
    // Preserve producer order even when multiple flushes overlap. Capture the epoch once;
    // never refresh an old writer to a new epoch after a rollback or completion.
    const write = this.sidecarTail.then(async () => {
      if (this.writeFailure) throw this.writeFailure;
      if (!this.isCurrent()) return;
      this.sidecarFence ??= runtimeFacade.streamFence(this.sessionId, runId);
      const fence = await this.sidecarFence;
      const state = authoritative
        ? await runtimeFacade.authoritativeRecordState(this.sessionId)
        : runtimeRecordState(this.sessionId);
      const input = { sessionId: this.sessionId, runId, producerId: this.sidecarProducerId,
        producerSequence, ...fence, chunks, state };
      if (authoritative) {
        const receiptThrough = await runtimeFacade.appendStreamAuthoritative(input);
        await runtimeFacade.persistStreamHistory(this.sessionId, chunks, receiptThrough);
      }
      else await runtimeFacade.shadowAppendStream(input);
    }).catch(error => {
      if (authoritative) {
        this.writeFailure = error instanceof Error ? error : new Error(String(error));
        logger.error({ sessionId: this.sessionId, runId, error: this.writeFailure.message }, '[runtime-sidecar] authoritative stream stopped');
      }
      else {
        this.shadowStopped = true;
        logger.warn({ sessionId: this.sessionId, runId, error }, '[runtime-sidecar] shadow stream stopped');
      }
    }).finally(() => { this.sidecarPending--; this.writes.delete(write); });
    this.sidecarTail = write;
    // Finalization must wait for the shadow tail too, otherwise completion fences its writes.
    this.writes.add(write);
  }

  async prepareFinish(): Promise<void> {
    if (!this.runId || !this.isCurrent()) return;
    const step = agentRuntimeStore.listRunSteps(this.runId).at(-1);
    if (!step) return;
    let after = 0;
    const deltas: string[] = [];
    for (let pageNumber = 0; pageNumber < 64; pageNumber++) {
      const page = await runtimeJournal.readDurable(this.sessionId, after, 256, this.runId);
      if (!page.length) break;
      after = page[page.length - 1].sequence;
      for (const { chunk } of page) {
        if (!("stepId" in chunk) || chunk.stepId !== step.id) continue;
        if (chunk.type === "retry_status" && ["waiting", "group_wait"].includes(chunk.retry.phase)) deltas.length = 0;
        if (chunk.type === "message_delta") { deltas.push(chunk.delta); if (deltas.length > 128) deltas.shift(); }
      }
      if (page.length < 256) break;
    }
    this.partialContent = deltas.join('');
    this.partialStepId = step.id;
  }

  finish(): void {
    if(!this.isCurrent()){this.abandon();return;}
    this.flush();
    if (!this.runId) return;
    const partial = (() => {
      const run = agentRuntimeStore.getRun(this.runId!);
      if (!['interrupted', 'cancelled', 'failed'].includes(run.status)) return;
      const step = agentRuntimeStore.listRunSteps(run.id).at(-1);
      if (!step) return;
      const existing = agentRuntimeStore.listMessages(this.sessionId).find(message => message.role === 'assistant' && message.runId === run.id && message.stepId === step.id);
      if (existing) return;
      const content = this.partialStepId === step.id ? this.partialContent : '';
      if (!content) return;
      return { id: makeRuntimeId('msg'), sessionId: this.sessionId, runId: run.id, stepId: step.id,
        role: 'assistant' as const, content, createdAt: nowIso(), metadata: { source: 'runtime_partial', partial: true, runId: run.id, stepId: step.id } };
    })();
    if (partial && this.isCurrent()) {
      if (runtimeFacade.streamMode() === 'authoritative')
        this.write({ type: 'message', message: partial });
      else agentRuntimeStore.appendMessage(partial);
    }
  }

  abandon(): void {
    this.pending = [];
  }

  flush(): void {
    if (!this.isCurrent()) { this.abandon(); return; }
  }
}

export async function* recordRuntimeStream(sessionId: string, source: AsyncGenerator<AgentRunStreamChunk>): AsyncGenerator<AgentRunStreamChunk> {
  const writer = new RuntimeStreamWriter(sessionId);
  try { for await (const chunk of source) { writer.write(chunk); yield chunk; await writer.settled(); } }
  finally { writer.flush(); await writer.settled(); await writer.prepareFinish(); writer.finish(); }
}
