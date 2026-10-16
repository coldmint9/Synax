import { decodeRuntimePayload } from '../../../../packages/runtime-protocol/stream.js';
import { projectReplayChunk } from './runtime-stream-projection.js';
import { assertBatchInput } from './checkpoints/version-runtime/batch-input.js';
import { normalizeAgentSessionStatus, projectSessionState } from './session-projection.js';
import type { AgentRun, AgentRunStreamChunk, AgentSession } from './contracts.js';
import { agentRuntimeStore } from './session-store.js';
import { AgentValidationError } from './runtime-errors.js';
import { runtimeFacade } from './sidecar/runtime-facade.js';

const RETENTION = 1024;
const MAX_READ_BYTES = 1024 * 1024;

export interface RuntimeStreamRecord {
  sequence: number;
  sessionId: string;
  runId: string;
  chunk: AgentRunStreamChunk;
  state: Pick<AgentSession, 'status' | 'activeRunId' | 'pendingResumeToken' | 'blockedReason' | 'updatedAt'>;
}

export function runtimeRecordState(sessionId: string): RuntimeStreamRecord['state'] {
  const session = projectSessionState(agentRuntimeStore.getSession(sessionId));
  return { status: session.status, activeRunId: session.activeRunId, pendingResumeToken: session.pendingResumeToken, blockedReason: session.blockedReason, updatedAt: session.updatedAt };
}

async function readAuthoritative(sessionId: string, after: number, limit: number, runId?: string): Promise<RuntimeStreamRecord[]> {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new AgentValidationError('Invalid stream cursor.');
  const records: RuntimeStreamRecord[] = [];
  let position = after;
  for (let page = 0; page < 64; page++) {
    const events = await runtimeFacade.replayAuthoritative(sessionId, position);
    if (!events.length) break;
    if (events.at(-1)!.sequence <= position) throw new AgentValidationError('Runtime replay cursor did not advance.');
    position = events.at(-1)!.sequence;
    for (const event of events) {
      if (runId && event.runId !== runId) continue;
      try {
        const payload = decodeRuntimePayload(event.payload);
        records.push({ sequence: event.sequence, sessionId, runId: event.runId, chunk: payload.chunk as AgentRunStreamChunk, state: { ...payload.state, status: normalizeAgentSessionStatus(payload.state.status) } });
        if (records.length === limit) return records;
      } catch (error) {
        throw new AgentValidationError(`Invalid sidecar stream payload: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (records.length) break;
  }
  return records;
}

class RuntimeJournal {
  private readonly records = new Map<string, RuntimeStreamRecord[]>();
  private readonly cursors = new Map<string, number>();
  private readonly producerSequences = new Map<string, number>();
  private readonly waiters = new Map<string, Set<() => void>>();

  append(sessionId: string, runId: string, chunk: AgentRunStreamChunk): RuntimeStreamRecord { return this.appendBatch(sessionId, runId, [chunk])[0]; }

  appendBatch(sessionId: string, runId: string, chunks: AgentRunStreamChunk[]): RuntimeStreamRecord[] {
    if (runtimeFacade.streamMode() === 'authoritative') throw new AgentValidationError('Authoritative runtime stream writes must use the Rust sidecar append command.');
    if (!chunks.length) return [];
    if (chunks.length > 256) throw new AgentValidationError('Replay burst limit exceeded.');
    const run = agentRuntimeStore.getRun(runId);
    if (run.sessionId !== sessionId) throw new AgentValidationError('Stream Run belongs to another session.');
    const projected = chunks.map(projectReplayChunk);
    assertBatchInput(projected);
    const state = runtimeRecordState(sessionId);
    let cursor = this.cursors.get(sessionId) ?? 0;
    const sessionRecords = this.records.get(sessionId) ?? [];
    const committed = projected.map(chunk => {
      if (Buffer.byteLength(JSON.stringify({ chunk, state })) > 64 * 1024) throw new AgentValidationError('Replay record exceeds its byte budget.');
      cursor += 1;
      return { sequence: cursor, sessionId, runId, chunk, state } satisfies RuntimeStreamRecord;
    });
    sessionRecords.push(...committed);
    if (sessionRecords.length > RETENTION) sessionRecords.splice(0, sessionRecords.length - RETENTION);
    this.records.set(sessionId, sessionRecords);
    this.cursors.set(sessionId, cursor);
    this.notifyCommitted(sessionId);
    return committed;
  }

  async appendDurable(sessionId: string, runId: string, chunks: AgentRunStreamChunk[], _revision?: number, _requestId?: string): Promise<void> {
    if (!chunks.length) return;
    if (runtimeFacade.streamMode() === 'authoritative') {
      const fence = await runtimeFacade.streamFence(sessionId, runId);
      const key = `producer:${sessionId}`;
      const sequence = (this.producerSequences.get(key) ?? 0) + 1;
      this.producerSequences.set(key, sequence);
      await runtimeFacade.appendStreamAuthoritative({ sessionId, runId, producerId: `runtime-journal:${process.pid}`, producerSequence: sequence, epoch: fence.epoch, revision: fence.revision, chunks, state: await runtimeFacade.authoritativeRecordState(sessionId) });
      return;
    }
    this.appendBatch(sessionId, runId, chunks);
  }

  async readDurable(sessionId: string, after = 0, limit = 256, runId?: string): Promise<RuntimeStreamRecord[]> { return runtimeFacade.streamMode() === 'authoritative' ? readAuthoritative(sessionId, after, limit, runId) : this.read(sessionId, after, limit, runId); }
  async snapshotDurable(sessionId: string): Promise<ReturnType<RuntimeJournal['snapshot']>> { return runtimeFacade.streamMode() === 'authoritative' ? runtimeFacade.uiSnapshotAuthoritative(sessionId) : this.snapshot(sessionId); }
  notifyCommitted(sessionId: string): void { for (const wake of [...(this.waiters.get(sessionId) ?? [])]) wake(); }
  cursor(sessionId: string): number { return this.cursors.get(sessionId) ?? 0; }

  read(sessionId: string, after = 0, limit = 256, runId?: string): RuntimeStreamRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256 || !Number.isSafeInteger(after) || after < 0) throw new AgentValidationError('Invalid stream cursor.');
    const result: RuntimeStreamRecord[] = [];
    let bytes = 0;
    for (const record of this.records.get(sessionId) ?? []) {
      if (record.sequence <= after || (runId && record.runId !== runId)) continue;
      const recordBytes = Buffer.byteLength(JSON.stringify(record));
      if (recordBytes > MAX_READ_BYTES || bytes + recordBytes > MAX_READ_BYTES) break;
      bytes += recordBytes;
      result.push(record);
      if (result.length === limit) break;
    }
    return result;
  }

  async *observe(sessionId: string, after = 0, signal?: AbortSignal): AsyncGenerator<RuntimeStreamRecord> {
    let cursor = after;
    while (!signal?.aborted) {
      const records = await this.readDurable(sessionId, cursor);
      for (const record of records) { if (signal?.aborted) return; cursor = record.sequence; yield record; }
      if (!records.length) await this.wait(sessionId, signal);
    }
  }

  wait(sessionId: string, signal?: AbortSignal, ms = 150): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this.waiters.get(sessionId) ?? new Set<() => void>();
      let timer: ReturnType<typeof setTimeout>;
      const wake = () => { clearTimeout(timer); signal?.removeEventListener('abort', wake); waiters.delete(wake); if (!waiters.size) this.waiters.delete(sessionId); resolve(); };
      waiters.add(wake); this.waiters.set(sessionId, waiters); timer = setTimeout(wake, ms); signal?.addEventListener('abort', wake, { once: true });
    });
  }

  snapshot(sessionId: string): { session: AgentSession; run: AgentRun | null; cursor: number; liveChunks: AgentRunStreamChunk[]; completedStepIds: string[] } {
    const session = projectSessionState(agentRuntimeStore.getSession(sessionId));
    const run = session.activeRunId ? agentRuntimeStore.getRun(session.activeRunId) : (agentRuntimeStore.listRuns(sessionId)[0] ?? null);
    const steps = run ? agentRuntimeStore.listRunSteps(run.id) : [];
    const current = steps.at(-1);
    const liveChunks: AgentRunStreamChunk[] = [];
    if (run && current && !current.completedAt && ['running', 'waiting_permission', 'waiting_input'].includes(run.status)) {
      liveChunks.push({ type: 'step_started', step: current });
      for (const record of this.read(sessionId, 0, RETENTION, run.id)) {
        const chunk = record.chunk;
        if (!('stepId' in chunk) || chunk.stepId !== current.id) continue;
        if (chunk.type === 'retry_status' && ['waiting', 'group_wait'].includes(chunk.retry.phase)) liveChunks.length = 1;
        liveChunks.push(chunk);
      }
    }
    return { session, run, cursor: this.cursor(sessionId), liveChunks, completedStepIds: steps.filter(step => Boolean(step.completedAt)).map(step => step.id) };
  }
}

export const runtimeJournal = new RuntimeJournal();
