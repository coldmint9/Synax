import { projectSessionState } from './session-projection.js';
import { getRawSqlite } from '../../db/index.js';
import type { AgentRunStreamChunk, AgentSession } from './contracts.js';
import { agentRuntimeStore } from './session-store.js';
import { AgentValidationError } from './runtime-errors.js';
import { nowIso } from './runtime-ids.js';

export interface RuntimeStreamRecord {
  sequence: number;
  sessionId: string;
  runId: string;
  chunk: AgentRunStreamChunk;
  state: Pick<AgentSession, 'status' | 'activeRunId' | 'pendingResumeToken' | 'blockedReason' | 'updatedAt'>;
}
interface JournalRow { sequence: number; session_id: string; run_id: string; chunk_json: string }
const mapRow = (row: JournalRow): RuntimeStreamRecord => {
  const payload = JSON.parse(row.chunk_json) as { chunk: AgentRunStreamChunk; state: RuntimeStreamRecord['state'] };
  return { sequence: row.sequence, sessionId: row.session_id, runId: row.run_id, ...payload };
};

class RuntimeJournal {
  private readonly waiters = new Map<string, Set<() => void>>();

  append(sessionId: string, runId: string, chunk: AgentRunStreamChunk): RuntimeStreamRecord {
    const record = getRawSqlite().transaction(() => {
      const run = agentRuntimeStore.getRun(runId);
      if (run.sessionId !== sessionId) throw new AgentValidationError('Stream Run belongs to another session.');
      const session = projectSessionState(agentRuntimeStore.getSession(sessionId));
      const state: RuntimeStreamRecord['state'] = { status: session.status, activeRunId: session.activeRunId,
        pendingResumeToken: session.pendingResumeToken, blockedReason: session.blockedReason, updatedAt: session.updatedAt };
      const [row] = getRawSqlite().prepare(`INSERT INTO agent_runtime_stream_records
        (session_id, run_id, kind, chunk_json, created_at) VALUES (?, ?, ?, ?, ?) RETURNING sequence`)
        .all(sessionId, runId, chunk.type, JSON.stringify({ chunk, state }), nowIso()) as Array<{ sequence: number }>;
      return { sequence: row.sequence, sessionId, runId, chunk, state };
    })();
    for (const wake of [...this.waiters.get(sessionId) ?? []]) wake();
    return record;
  }

  cursor(sessionId: string): number {
    const row = getRawSqlite().prepare('SELECT MAX(sequence) AS value FROM agent_runtime_stream_records WHERE session_id = ?')
      .get(sessionId) as { value: number | null };
    return row.value ?? 0;
  }

  read(sessionId: string, after = 0, limit = 256, runId?: string): RuntimeStreamRecord[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new AgentValidationError('Invalid stream cursor.');
    const rows = getRawSqlite().prepare(`SELECT sequence, session_id, run_id, chunk_json FROM agent_runtime_stream_records
      WHERE session_id = ? AND sequence > ? ${runId ? 'AND run_id = ?' : ''} ORDER BY sequence LIMIT ?`)
      .all(...(runId ? [sessionId, after, runId, limit] : [sessionId, after, limit])) as JournalRow[];
    return rows.map(mapRow);
  }

  async *observe(sessionId: string, after = 0, signal?: AbortSignal): AsyncGenerator<RuntimeStreamRecord> {
    let cursor = after;
    while (!signal?.aborted) {
      const records = this.read(sessionId, cursor);
      for (const record of records) {
        if (signal?.aborted) return;
        cursor = record.sequence;
        yield record;
      }
      if (records.length === 0) await this.wait(sessionId, signal);
    }
  }

  wait(sessionId: string, signal?: AbortSignal, ms = 150): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this.waiters.get(sessionId) ?? new Set<() => void>();
      let timer: ReturnType<typeof setTimeout>;
      const wake = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', wake);
        waiters.delete(wake);
        if (waiters.size === 0) this.waiters.delete(sessionId);
        resolve();
      };
      waiters.add(wake); this.waiters.set(sessionId, waiters);
      timer = setTimeout(wake, ms);
      signal?.addEventListener('abort', wake, { once: true });
    });
  }

  snapshot(sessionId: string) {
    return getRawSqlite().transaction(() => {
      const session = projectSessionState(agentRuntimeStore.getSession(sessionId));
      const run = session.activeRunId ? agentRuntimeStore.getRun(session.activeRunId) : agentRuntimeStore.listRuns(sessionId)[0] ?? null;
      const cursor = this.cursor(sessionId);
      const steps = run ? agentRuntimeStore.listRunSteps(run.id) : [];
      const current = steps.at(-1);
      const liveChunks: AgentRunStreamChunk[] = [];
      if (run && current && !current.completedAt && ['running', 'waiting_permission', 'waiting_input'].includes(run.status)) {
        const start = getRawSqlite().prepare(`SELECT sequence FROM agent_runtime_stream_records WHERE run_id = ?
          AND kind = 'step_started' AND json_extract(chunk_json, '$.chunk.step.id') = ? ORDER BY sequence DESC LIMIT 1`)
          .get(run.id, current.id) as { sequence: number } | undefined;
        liveChunks.push({ type: 'step_started', step: current });
        if (start) {
          const rows = getRawSqlite().prepare(`SELECT sequence, session_id, run_id, chunk_json FROM agent_runtime_stream_records
            WHERE run_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence`)
            .all(run.id, start.sequence, cursor) as JournalRow[];
          for (const row of rows) {
            const chunk = mapRow(row).chunk;
            if ('stepId' in chunk && chunk.stepId === current.id) {
              if (chunk.type === 'retry_status' && ['waiting', 'group_wait'].includes(chunk.retry.phase)) liveChunks.length = 1;
              liveChunks.push(chunk);
            }
          }
        }
      }
      return { session, run, cursor, liveChunks, completedStepIds: steps.filter(step => Boolean(step.completedAt)).map(step => step.id) };
    })();
  }
}

export const runtimeJournal = new RuntimeJournal();
