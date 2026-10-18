import { logger } from '../../infrastructure/runtime/logger.js';
import { randomUUID } from 'node:crypto';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import type { AgentRunStreamChunk } from './contracts.js';
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
  private writes = new Set<Promise<void>>();
  private writeFailure?: Error;
  private runStatus?: string;
  private partialContent = '';
  private partialStepId?: string;
  private partialPublished = false;
  private sidecarProducerSequence = 0;
  private readonly sidecarProducerId = `node:${process.pid}:${randomUUID()}`;
  private sidecarTail: Promise<void> = Promise.resolve();
  private sidecarFence?: Promise<{ epoch: number; revision: number }>;
  private sidecarPending = 0;
  constructor(private readonly sessionId: string, private runId?: string, private readonly current: () => boolean = () => true) {}

  /** Acknowledgement barrier, including failures from a timer-driven delta flush. */
  async settled(): Promise<void> {
    await Promise.all(this.writes);
    if (this.writeFailure) throw this.writeFailure;
  }

  private isCurrent(): boolean { return this.current(); }

  write(chunk: AgentRunStreamChunk): void {
    if (!this.isCurrent()) { this.abandon(); return; }
    if ('run' in chunk && chunk.run) this.runStatus = chunk.run.status;
    if (chunk.type === 'step_started') {
      this.partialStepId = chunk.step.id;
      this.partialContent = '';
      this.partialPublished = false;
    }
    if ('stepId' in chunk && chunk.stepId === this.partialStepId) {
      if (chunk.type === 'message_delta') this.partialContent += chunk.delta;
      if (chunk.type === 'retry_status' && ['waiting', 'group_wait'].includes(chunk.retry.phase)) this.partialContent = '';
    }
    if (chunk.type === 'message' && chunk.message.role === 'assistant' && chunk.message.stepId === this.partialStepId)
      this.partialPublished = true;
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
    if (this.sidecarPending >= 128) throw new Error('Runtime sidecar stream queue is full.');
    this.enqueueSidecar(runId, chunks);
  }

  private enqueueSidecar(runId: string, chunks: AgentRunStreamChunk[]): void {
    if (this.sidecarPending >= 128) {
      throw new Error('Runtime sidecar stream queue is full.');
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
      const state = await runtimeFacade.authoritativeRecordState(this.sessionId);
      const input = { sessionId: this.sessionId, runId, producerId: this.sidecarProducerId,
        producerSequence, ...fence, chunks, state };
      const receiptThrough = await runtimeFacade.appendStreamAuthoritative(input);
      await runtimeFacade.persistStreamHistory(this.sessionId, chunks, receiptThrough);
    }).catch(error => {
      this.writeFailure = error instanceof Error ? error : new Error(String(error));
      logger.error({ sessionId: this.sessionId, runId, error: this.writeFailure.message }, '[runtime-sidecar] authoritative stream stopped');
    }).finally(() => { this.sidecarPending--; this.writes.delete(write); });
    this.sidecarTail = write;
    // Finalization must wait for the Rust tail before finish.
    this.writes.add(write);
  }

  async prepareFinish(): Promise<void> {
    await this.settled();
  }

  finish(): void {
    if (!this.isCurrent()) { this.abandon(); return; }
    if (!this.runId || !this.partialStepId || !this.partialContent || this.partialPublished ||
        !['interrupted', 'cancelled', 'failed'].includes(this.runStatus ?? '')) return;
    this.write({
      type: 'message',
      message: {
        id: makeRuntimeId('msg'), sessionId: this.sessionId, runId: this.runId,
        stepId: this.partialStepId, role: 'assistant', content: this.partialContent,
        createdAt: nowIso(), metadata: { source: 'runtime_partial', partial: true, runId: this.runId, stepId: this.partialStepId },
      },
    });
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
  finally { writer.flush(); await writer.settled(); await writer.prepareFinish(); writer.finish(); await writer.settled(); }
}
