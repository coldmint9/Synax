import type { AgentRunStreamChunk } from "./contracts.js";
import { RuntimeStreamWriter } from "./runtime-stream-writer.js";

/** Reuse the authoritative writer's ordered, bounded 40ms delta batches and
 * producer IDs. A failed append is never replayed into the realtime channel. */
export class DurableDeltaBuffer {
  readonly writer: RuntimeStreamWriter;
  constructor(readonly sessionId: string, readonly runId: string, current: () => boolean) {
    this.writer = new RuntimeStreamWriter(sessionId, runId, current);
  }
  append(chunk: AgentRunStreamChunk): void { this.writer.write(chunk); }
  async flush(runId = this.runId): Promise<void> {
    if (runId !== this.runId) throw new Error("Durable buffer belongs to another run.");
    this.writer.flush();
    await this.writer.settled();
  }
  async abort(runId: string, _reason: string): Promise<void> { await this.flush(runId); }
}
