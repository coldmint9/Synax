import type { AgentRunStreamChunk } from "./contracts.js";
import type { RuntimeStreamRecord } from "./runtime-journal.js";
import { normalizeAgentSessionStatus } from "./session-projection.js";

export const runRealtimeEnabled = () => process.env.SYNAX_RUN_REALTIME_CHANNEL !== "0";
export class RealtimeReplayGap extends Error {
  constructor() { super("Run realtime replay expired; reload the durable snapshot."); }
}

/** A bounded, run-local broadcast log. Publishing never awaits readers or storage.
 * Slow readers fail explicitly and recover from a durable snapshot, never skip text.
 * The terminal record stays in the log until the registry retention expires. */
export class RunRealtimeChannel {
  private records: Array<{ record: RuntimeStreamRecord; bytes: number }> = [];
  private bytes = 0;
  private sequence = 0;
  private closed = false;
  private failure?: string;
  private waiters = new Set<() => void>();
  private state: RuntimeStreamRecord["state"];
  get isClosed(): boolean { return this.closed; }
  constructor(readonly runId: string, readonly sessionId: string,
    private readonly maxBytes = 8 * 1024 * 1024, private readonly maxRecords = 4096) {
    this.state = { status: "running", activeRunId: runId, pendingResumeToken: null,
      blockedReason: null, updatedAt: new Date().toISOString() };
  }

  publish(chunk: AgentRunStreamChunk): AgentRunStreamChunk {
    if (this.closed) throw new Error("Run realtime channel is closed.");
    const chunkRunId = "run" in chunk && chunk.run ? chunk.run.id
      : "runId" in chunk ? chunk.runId
      : "step" in chunk ? chunk.step.runId
      : "message" in chunk ? chunk.message?.runId : undefined;
    if (chunkRunId && chunkRunId !== this.runId) throw new Error("Realtime chunk belongs to another run.");
    const stamped = { ...chunk, realtimeSequence: ++this.sequence,
      ...(chunk.firstTokenTiming ? { firstTokenTiming: { ...chunk.firstTokenTiming, realtimeEnqueueAt: Date.now() } } : {}) };
    if ("run" in chunk && chunk.run) {
      const active = ["queued", "running", "waiting_input", "waiting_permission"].includes(chunk.run.status);
      this.state = { ...this.state, status: normalizeAgentSessionStatus(chunk.run.status),
        activeRunId: active ? this.runId : null, blockedReason: chunk.run.stopReason,
        updatedAt: chunk.run.completedAt ?? chunk.run.startedAt };
    }
    const record = { sequence: this.sequence, runId: this.runId, sessionId: this.sessionId,
      chunk: stamped, state: { ...this.state } };
    const bytes = Buffer.byteLength(JSON.stringify(record));
    this.records.push({ record, bytes });
    this.bytes += bytes;
    // Always retain the newest record (including done), even if it is large.
    while (this.records.length > 1 && (this.bytes > this.maxBytes || this.records.length > this.maxRecords))
      this.bytes -= this.records.shift()!.bytes;
    this.wake();
    return stamped;
  }

  close(reason?: string): void { this.closed = true; this.failure ??= reason; this.wake(); }
  private wake(): void { for (const wake of [...this.waiters]) wake(); }
  async *subscribe(after = 0, signal?: AbortSignal): AsyncGenerator<RuntimeStreamRecord> {
    let cursor = after;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.sequence) throw new RealtimeReplayGap();
    while (!signal?.aborted) {
      if (cursor < (this.records[0]?.record.sequence ?? 1) - 1) throw new RealtimeReplayGap();
      const next = this.records.find(item => item.record.sequence > cursor)?.record;
      if (next) { cursor = next.sequence; yield next; continue; }
      if (this.closed) { if (this.failure) throw new Error(this.failure); return; }
      await new Promise<void>(resolve => {
        const wake = () => { this.waiters.delete(wake); signal?.removeEventListener("abort", wake); resolve(); };
        this.waiters.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
        if (signal?.aborted) wake();
      });
    }
  }
}

const channels = new Map<string, RunRealtimeChannel>();
const retention = new Map<string, ReturnType<typeof setTimeout>>();
export function createRunRealtimeChannel(sessionId: string, runId: string): RunRealtimeChannel | undefined {
  if (!runRealtimeEnabled()) return;
  const old = channels.get(runId);
  clearTimeout(retention.get(runId));
  retention.delete(runId);
  if (old && !old.isClosed) return old;
  old?.close();
  const channel = new RunRealtimeChannel(runId, sessionId);
  channels.set(runId, channel);
  return channel;
}
export function getRunRealtimeChannel(sessionId: string, runId: string): RunRealtimeChannel | undefined {
  const channel = channels.get(runId);
  return runRealtimeEnabled() && channel?.sessionId === sessionId ? channel : undefined;
}
export function closeRunRealtimeChannel(channel: RunRealtimeChannel, waiting = false): void {
  if (!waiting) channel.close();
  if (channels.get(channel.runId) !== channel) return;
  const timer = setTimeout(() => {
    channel.close();
    if (channels.get(channel.runId) === channel) channels.delete(channel.runId);
    retention.delete(channel.runId);
  }, 60_000);
  timer.unref();
  retention.set(channel.runId, timer);
  // Bound retained completed/waiting logs across many short runs as well as
  // bounding each log. Active producers are never evicted.
  while (retention.size > 64) {
    const id = retention.keys().next().value!;
    clearTimeout(retention.get(id)); retention.delete(id);
    channels.get(id)?.close(); channels.delete(id);
  }
}
