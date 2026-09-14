import { getRawSqlite } from '../../db/index.js';
import { agentRuntimeStore } from './session-store.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import { runtimeTransaction } from './runtime-transaction.js';
import type { AgentRunStreamChunk } from './contracts.js';
import { runtimeJournal } from './runtime-journal.js';

/** Shared by background runs and embedded hosts; it never moves a host or takes ownership of its tools. */
export class RuntimeStreamWriter {
  private pending: AgentRunStreamChunk[] = [];
  private delta?: Extract<AgentRunStreamChunk, { type: 'message_delta' | 'thought_delta' }>;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly sessionId: string, private runId?: string, private readonly current: () => boolean = () => true) {}

  write(chunk: AgentRunStreamChunk): void {
    if (!this.current()) { this.abandon(); return; }
    if (!this.runId) {
      if ('run' in chunk) this.runId = chunk.run.id;
      else if ('runId' in chunk) this.runId = chunk.runId;
      else if (chunk.type === 'step_started') this.runId = chunk.step.runId;
      if (!this.runId) { this.pending.push(chunk); return; }
      for (const pending of this.pending) runtimeJournal.append(this.sessionId, this.runId, pending);
      this.pending = [];
    }
    if (chunk.type === 'message_delta' || chunk.type === 'thought_delta') {
      if (this.delta && (this.delta.type !== chunk.type || this.delta.stepId !== chunk.stepId)) this.flush();
      this.delta = this.delta ? { ...this.delta, delta: this.delta.delta + chunk.delta } : { ...chunk, event: undefined };
      if (this.delta.delta.length >= 8192) this.flush();
      else if (!this.timer) this.timer = setTimeout(() => this.flush(), 40);
    } else {
      this.flush(); runtimeJournal.append(this.sessionId, this.runId, chunk);
    }
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
        AND json_extract(chunk_json, '$.chunk.stepId') = ? ORDER BY sequence`).all(run.id, step.id) as Array<{ chunk_json: string }>;
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
    if (!this.current()) { this.abandon(); return; }
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
