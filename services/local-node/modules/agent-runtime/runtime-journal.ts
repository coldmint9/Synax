import { decodeRuntimePayload } from '../../../../packages/runtime-protocol/stream.js';
import { randomUUID } from 'node:crypto';
import { normalizeAgentSessionStatus } from './session-projection.js';
import type { AgentRunStreamChunk, AgentSession } from './contracts.js';
import { AgentValidationError } from './runtime-errors.js';
import { runtimeFacade } from './sidecar/runtime-facade.js';

const durableProducerId = `runtime-journal:${process.pid}:${randomUUID()}`;
export interface RuntimeStreamRecord {
  sequence: number;
  sessionId: string;
  runId: string;
  chunk: AgentRunStreamChunk;
  state: Pick<AgentSession, 'status' | 'activeRunId' | 'pendingResumeToken' | 'blockedReason' | 'updatedAt'>;
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

/** Async adapter for the Rust event log. Node keeps no replay copy. */
class RuntimeJournal {
  private readonly producerSequences = new Map<string, number>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Set<() => void>>();

  async appendDurable(sessionId: string, runId: string, chunks: AgentRunStreamChunk[]): Promise<void> {
    if (!chunks.length) return;
    const write = (this.pending.get(sessionId) ?? Promise.resolve()).then(async () => {
      const fence = await runtimeFacade.streamFence(sessionId, runId);
      const sequence = (this.producerSequences.get(sessionId) ?? 0) + 1;
      this.producerSequences.set(sessionId, sequence);
      const through = await runtimeFacade.appendStreamAuthoritative({
        sessionId, runId, producerId: durableProducerId, producerSequence: sequence,
        ...fence, chunks, state: await runtimeFacade.authoritativeRecordState(sessionId),
      });
      await runtimeFacade.persistStreamHistory(sessionId, chunks, through);
      this.notifyCommitted(sessionId);
    });
    this.pending.set(sessionId, write);
    try { await write; }
    finally { if (this.pending.get(sessionId) === write) this.pending.delete(sessionId); }
  }

  async readDurable(sessionId: string, after = 0, limit = 256, runId?: string): Promise<RuntimeStreamRecord[]> {
    return readAuthoritative(sessionId, after, limit, runId);
  }

  async snapshotDurable(sessionId: string) {
    return runtimeFacade.uiSnapshotAuthoritative(sessionId);
  }

  notifyCommitted(sessionId: string): void { for (const wake of [...(this.waiters.get(sessionId) ?? [])]) wake(); }

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

 }

export const runtimeJournal = new RuntimeJournal();
