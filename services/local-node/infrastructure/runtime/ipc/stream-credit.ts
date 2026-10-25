import type { AgentRunStreamChunk } from '../../../modules/agent-runtime/contracts.js';
import { streamChunkBytes } from '../../../modules/agent-runtime/stream-queue.js';

/** Flow-control credit is unrelated to the durable Runtime event acknowledgement. */
export class WorkerStreamCredits {
  private sequence = 0;
  private waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  grant(id: string, error?: string): void {
    const waiting = this.waiting.get(id);
    if (!waiting) return;
    this.waiting.delete(id);
    if (error) waiting.reject(new Error(error)); else waiting.resolve();
  }
  async reserve(streamId: string, chunk: AgentRunStreamChunk, signal: AbortSignal,
    send: (message: { type: 'stream:reserve'; streamId: string; deliveryId: string; bytes: number }) => boolean,
  ): Promise<string> {
    signal.throwIfAborted();
    const deliveryId = `${streamId}:${++this.sequence}`;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { this.waiting.delete(deliveryId); reject(signal.reason); };
      const complete = (error?: Error) => {
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      this.waiting.set(deliveryId, { resolve: () => complete(), reject: error => complete(error) });
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (!send({ type: 'stream:reserve', streamId, deliveryId, bytes: streamChunkBytes(chunk) }))
          this.grant(deliveryId, 'Parent is unavailable.');
      } catch (error) { this.grant(deliveryId, String(error)); }
      if (signal.aborted) abort();
    });
    return deliveryId;
  }
}
