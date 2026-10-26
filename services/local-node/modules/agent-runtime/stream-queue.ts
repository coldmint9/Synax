import type { AgentRunStreamChunk } from './contracts.js';

export type StreamQueueItem =
  | { kind: 'parked' }
  | { kind: 'chunk'; chunk: AgentRunStreamChunk }
  | { kind: 'done' }
  | { kind: 'error'; error: string; code?: string };

/** A byte permit is held until the consumer takes the item, not until IPC accepts it. */
export class StreamByteBudget {
  used = 0;
  private waiters: Array<{ bytes: number; grant: () => void }> = [];
  constructor(readonly capacity: number) {}
  tryAcquire(bytes: number): (() => void) | undefined {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.capacity) throw new Error('Stream event exceeds its byte budget.');
    if (this.used + bytes > this.capacity) return undefined;
    this.used += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true; this.used -= bytes;
      this.drain();
    };
  }
  private drain(): void {
    while (this.waiters.length && this.used + this.waiters[0].bytes <= this.capacity) this.waiters.shift()!.grant();
  }
  async acquire(bytes: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.capacity) throw new Error('Stream event exceeds its byte budget.');
    if (!this.waiters.length) { const release = this.tryAcquire(bytes); if (release) return release; }
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        signal.removeEventListener('abort', abort); reject(signal.reason); this.drain();
      };
      const waiter = { bytes, grant: () => { signal.removeEventListener('abort', abort); resolve(this.tryAcquire(bytes)!); } };
      this.waiters.push(waiter); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

const sharedBudget = new StreamByteBudget(64 * 1024 * 1024);
export const STREAM_ITEM_OVERHEAD = 256;
export function streamChunkBytes(chunk: AgentRunStreamChunk): number {
  return Buffer.byteLength(JSON.stringify(chunk)) + STREAM_ITEM_OVERHEAD;
}

export class StreamQueue {
  private pending: Array<{ item: StreamQueueItem; release?: () => void }> = [];
  private resolvers: Array<(item: StreamQueueItem) => void> = [];
  private credits = new Map<string, { bytes: number; release: () => void }>();
  private reserving = new Set<string>();
  private closed = false;
  private lifetime = new AbortController();
  private local: StreamByteBudget;
  constructor(private global = sharedBudget, capacity = 2 * 1024 * 1024) { this.local = new StreamByteBudget(capacity); }

  async reserve(id: string, bytes: number): Promise<void> {
    if (!id || id.length > 256 || this.reserving.has(id) || this.credits.has(id) || this.reserving.size >= 128)
      throw new Error('Invalid stream credit request.');
    this.reserving.add(id);
    let local: (() => void) | undefined;
    let global: (() => void) | undefined;
    try {
      local = await this.local.acquire(bytes, this.lifetime.signal);
      global = await this.global.acquire(bytes, this.lifetime.signal);
      this.lifetime.signal.throwIfAborted();
      const releaseLocal = local; const releaseGlobal = global;
      this.credits.set(id, { bytes, release: () => { releaseLocal(); releaseGlobal(); } });
      local = global = undefined;
    } finally { local?.(); global?.(); this.reserving.delete(id); }
  }

  push(item: StreamQueueItem, creditId?: string): void {
    if (this.closed) {
      if (item.kind !== 'chunk') return; // Duplicate exit/stop notices after terminal delivery.
      throw new Error('Stream queue is closed.');
    }
    let release: (() => void) | undefined;
    if (item.kind === 'chunk') {
      const bytes = streamChunkBytes(item.chunk);
      if (creditId) {
        const credit = this.credits.get(creditId);
        if (!credit || bytes > credit.bytes) throw new Error('Stream event exceeded its reserved credit.');
        this.credits.delete(creditId); release = credit.release;
      } else {
        // Older embedded hosts may send directly. They are bounded too, and fail explicitly at capacity.
        const local = this.local.tryAcquire(bytes);
        if (!local) throw new Error('Stream queue byte budget is full.');
        let global: (() => void) | undefined;
        try { global = this.global.tryAcquire(bytes); } catch (error) { local(); throw error; }
        if (!global) { local(); throw new Error('Global stream queue byte budget is full.'); }
        release = () => { local(); global!(); };
      }
    }
    const resolve = this.resolvers.shift();
    if (resolve) { release?.(); resolve(item); }
    else this.pending.push({ item, release });
  }
  async next(): Promise<StreamQueueItem> {
    const next = this.pending.shift();
    if (next) { next.release?.(); return next.item; }
    if (this.closed) return { kind: 'done' };
    return new Promise(resolve => this.resolvers.push(resolve));
  }
  close(): void {
    this.closed = true; this.lifetime.abort(new Error('Stream queue closed.'));
    for (const credit of this.credits.values()) credit.release();
    this.credits.clear();
    for (const resolve of this.resolvers.splice(0)) resolve({ kind: 'done' });
  }
  dispose(): void {
    this.close();
    for (const pending of this.pending.splice(0)) pending.release?.();
  }
}
