import { logger } from '../../infrastructure/runtime/logger.js';
import { randomUUID } from 'node:crypto';
import { transcriptStorageEnabled } from "./transcript-repository.js";
import { sessionLogClient } from "../../infrastructure/storage/log-client.js";
import { versionedSession, versionRepository } from "./checkpoints/version-runtime/bridge.js";
import { historyEpoch } from "./checkpoints/guards.js";
import { getRawSqlite } from '../../infrastructure/database/index.js';
import { agentRuntimeStore } from './session-store.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import { runtimeTransaction } from './runtime-transaction.js';
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
  constructor(private readonly sessionId: string, private runId?: string, private readonly current: () => boolean = () => true,
    private readonly persist?: (sessionId: string, runId: string, chunks: AgentRunStreamChunk[], revision: number) => Promise<void>,
  ) { this.revision = historyEpoch(sessionId); }

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
    const persist = this.persist ?? (process.env.SYNAX_STORAGE_OWNER_ENDPOINT
      ? (sessionId: string, id: string, values: AgentRunStreamChunk[], revision: number) => runtimeJournal.appendDurable(sessionId, id, values, revision)
      : undefined);
    if (runtimeFacade.streamMode() === 'authoritative') {
      if (this.sidecarPending >= 128) throw new Error('Runtime sidecar stream queue is full.');
      this.enqueueSidecar(runId, chunks, true);
      return;
    }
    if (persist) {
      const write = persist(this.sessionId, runId, chunks, this.revision)
        .catch(error => { this.writeFailure = error instanceof Error ? error : new Error(String(error)); })
        .finally(() => this.writes.delete(write));
      this.writes.add(write);
      if (runtimeFacade.streamMode() === 'shadow') this.enqueueSidecar(runId, chunks, false);
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
    const state = runtimeRecordState(this.sessionId);
    const producerSequence = ++this.sidecarProducerSequence;
    this.sidecarPending++;
    // Preserve producer order even when multiple flushes overlap. Capture the epoch once;
    // never refresh an old writer to a new epoch after a rollback or completion.
    const write = this.sidecarTail.then(async () => {
      if (this.writeFailure) throw this.writeFailure;
      if (!this.isCurrent()) return;
      this.sidecarFence ??= runtimeFacade.streamFence(this.sessionId, runId);
      const fence = await this.sidecarFence;
      const input = { sessionId: this.sessionId, runId, producerId: this.sidecarProducerId,
        producerSequence, ...fence, chunks, state };
      if (authoritative) await runtimeFacade.appendStreamAuthoritative(input);
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
    if (runtimeFacade.streamMode() === 'authoritative' || !process.env.SYNAX_STORAGE_OWNER_ENDPOINT || !this.runId || !this.isCurrent()) return;
    const step = agentRuntimeStore.listRunSteps(this.runId).at(-1);
    if (!step) return;
    const cursor = await sessionLogClient.cursor(this.sessionId);
    let after = 2 ** 40 + Math.max(0, cursor - 1024);
    const deltas: string[] = [];
    while (after < 2 ** 40 + cursor) {
      const page = await runtimeJournal.readDurable(this.sessionId, after, 256, this.runId);
      if (!page.length) break;
      after = page[page.length - 1].sequence;
      for (const { chunk } of page) {
        if (!("stepId" in chunk) || chunk.stepId !== step.id) continue;
        if (chunk.type === "retry_status" && ["waiting", "group_wait"].includes(chunk.retry.phase)) deltas.length = 0;
        if (chunk.type === "message_delta") { deltas.push(chunk.delta); if (deltas.length > 128) deltas.shift(); }
      }
    }
    this.partialContent = deltas.join('');
    this.partialStepId = step.id;
  }

  finish(): void {
    if(!this.isCurrent()){this.abandon();return;}
    this.flush();
    if (!this.runId) return;
    const partial = runtimeTransaction(() => {
      const run = agentRuntimeStore.getRun(this.runId!);
      if (!['interrupted', 'cancelled', 'failed'].includes(run.status)) return;
      const step = agentRuntimeStore.listRunSteps(run.id).at(-1);
      if (!step) return;
      const db = getRawSqlite();
      const existing = versionedSession(this.sessionId) ? versionRepository().last(this.sessionId, "messages", ["id"], { field: "stepId", value: step.id }) : transcriptStorageEnabled() ? agentRuntimeStore.listMessages(this.sessionId).find(message => message.role === "assistant" && message.runId === run.id && message.stepId === step.id) : db.prepare("SELECT id FROM agent_runtime_messages WHERE run_id = ? AND step_id = ? AND role = 'assistant' LIMIT 1").get(run.id, step.id);
      if (existing) return;
      const records = this.partialStepId === step.id ? [] : db.prepare(`SELECT chunk_json FROM agent_runtime_stream_records WHERE run_id = ? AND kind = 'message_delta'
        AND json_extract(chunk_json, '$.chunk.stepId') = ?
        AND sequence > COALESCE((SELECT MAX(sequence) FROM agent_runtime_stream_records
          WHERE run_id = ? AND kind = 'retry_status' AND json_extract(chunk_json, '$.chunk.stepId') = ?
          AND json_extract(chunk_json, '$.chunk.retry.phase') IN ('waiting', 'group_wait')), 0)
        AND length(CAST(chunk_json AS BLOB))<=65536 ORDER BY sequence DESC LIMIT 128`).all(run.id, step.id, run.id, step.id) as Array<{ chunk_json: string }>;
      const content = this.partialStepId === step.id ? this.partialContent : records.reverse().map(row => (JSON.parse(row.chunk_json) as { chunk: { delta: string } }).chunk.delta).join('');
      if (!content) return;
      return { id: makeRuntimeId('msg'), sessionId: this.sessionId, runId: run.id, stepId: step.id,
        role: 'assistant' as const, content, createdAt: nowIso(), metadata: { source: 'runtime_partial', partial: true, runId: run.id, stepId: step.id } };
    });
    if (partial && this.isCurrent()) agentRuntimeStore.appendMessage(partial);
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
