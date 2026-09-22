import { historyEpoch } from "./checkpoints/guards.js";
import { getRawSqlite } from '../../db/index.js';
import { agentRuntimeStore } from './session-store.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import { runtimeTransaction } from './runtime-transaction.js';
import type { AgentRunStreamChunk } from './contracts.js';
import { runtimeJournal } from './runtime-journal.js';
import { invalidateSessionEnvironment } from './session-environment.js';

/** Shared by background runs and embedded hosts; it never moves a host or takes ownership of its tools. */
export class RuntimeStreamWriter {
  private pending: AgentRunStreamChunk[] = [];
  private delta?: Extract<AgentRunStreamChunk, { type: 'message_delta' | 'thought_delta' }>;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly revision: number;
  constructor(private readonly sessionId: string, private runId?: string, private readonly current: () => boolean = () => true) { this.revision = historyEpoch(sessionId); }

  private isCurrent(): boolean { return this.current() && historyEpoch(this.sessionId) === this.revision; }

  write(chunk: AgentRunStreamChunk): void {
    if (!this.isCurrent()) { this.abandon(); return; }
    const commit: AgentRunStreamChunk[] = [];
    if (!this.runId) {
      if ('run' in chunk) this.runId = chunk.run.id;
      else if ('runId' in chunk) this.runId = chunk.runId;
      else if (chunk.type === 'step_started') this.runId = chunk.step.runId;
      if (!this.runId) { this.pending.push(chunk); return; }
      commit.push(...this.pending);
      this.pending = [];
    }
    if (chunk.type === 'message_delta' || chunk.type === 'thought_delta') {
      if (this.delta && (this.delta.type !== chunk.type || this.delta.stepId !== chunk.stepId)) this.drainDelta(commit);
      this.delta = this.delta ? { ...this.delta, delta: this.delta.delta + chunk.delta } : { ...chunk, event: undefined };
      if (this.delta.delta.length >= 8192) this.drainDelta(commit);
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), 40);
    } else {
      this.drainDelta(commit);
      commit.push(chunk);
    }
    this.commit(commit);
    // A completed write-class tool call invalidates the cached workspace
    // snapshot so the next environment poll reflects the edit immediately.
    if (chunk.type === 'tool_result' && chunk.toolCall && (chunk.toolCall as { mutability?: string }).mutability === 'write') {
      invalidateSessionEnvironment(this.sessionId);
    }
  }

  /** Move the buffered delta into the pending burst, clearing its pending timer. */
  private drainDelta(sink: AgentRunStreamChunk[]): void {
    if (!this.delta) return;
    sink.push(this.delta);
    this.delta = undefined;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }

  /** Append the burst in one transaction; a lone chunk keeps the plain append path. */
  private commit(chunks: AgentRunStreamChunk[]): void {
    const runId = this.runId;
    if (!runId || chunks.length === 0) return;
    if (chunks.length === 1) runtimeJournal.append(this.sessionId, runId, chunks[0]);
    else runtimeJournal.appendBatch(this.sessionId, runId, chunks);
  }

  finish(): void {
    this.flush();
    if (!this.runId) return;
    runtimeTransaction(() => {
      const run = agentRuntimeStore.getRun(this.runId!);
      if (!['interrupted', 'cancelled', 'failed'].includes(run.status)) return;
      const step = agentRuntimeStore.listRunSteps(run.id).at(-1);
      if (!step) return;
      const db = getRawSqlite();
      const existing = db.prepare("SELECT id FROM agent_runtime_messages WHERE run_id = ? AND step_id = ? AND role = 'assistant' LIMIT 1").get(run.id, step.id);
      if (existing) return;
      const records = db.prepare(`SELECT chunk_json FROM agent_runtime_stream_records WHERE run_id = ? AND kind = 'message_delta'
        AND json_extract(chunk_json, '$.chunk.stepId') = ?
        AND sequence > COALESCE((SELECT MAX(sequence) FROM agent_runtime_stream_records
          WHERE run_id = ? AND kind = 'retry_status' AND json_extract(chunk_json, '$.chunk.stepId') = ?
          AND json_extract(chunk_json, '$.chunk.retry.phase') IN ('waiting', 'group_wait')), 0)
        ORDER BY sequence`).all(run.id, step.id, run.id, step.id) as Array<{ chunk_json: string }>;
      const content = records.map(row => (JSON.parse(row.chunk_json) as { chunk: { delta: string } }).chunk.delta).join('');
      if (!content) return;
      agentRuntimeStore.appendMessage({ id: makeRuntimeId('msg'), sessionId: this.sessionId, runId: run.id, stepId: step.id,
        role: 'assistant', content, createdAt: nowIso(), metadata: { source: 'runtime_partial', partial: true, runId: run.id, stepId: step.id } });
    });
  }

  abandon(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.delta = undefined; this.pending = [];
  }

  flush(): void {
    if (!this.isCurrent()) { this.abandon(); return; }
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (this.delta && this.runId) {
      runtimeJournal.append(this.sessionId, this.runId, this.delta);
      this.delta = undefined;
    }
  }
}

export async function* recordRuntimeStream(sessionId: string, source: AsyncGenerator<AgentRunStreamChunk>): AsyncGenerator<AgentRunStreamChunk> {
  const writer = new RuntimeStreamWriter(sessionId);
  try { for await (const chunk of source) { writer.write(chunk); yield chunk; } }
  finally { writer.finish(); }
}
