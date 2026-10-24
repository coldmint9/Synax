export class WorkerQueue {
  private pending: string[] = [];
  private waiters = new Set<() => void>();
  get length(): number { return this.pending.length; }
  push(id: string): void { if (!this.pending.includes(id)) this.pending.push(id); }
  remove(id: string): void { this.pending = this.pending.filter(item => item !== id); this.notify(); }
  first(eligible: (id: string) => boolean): string | undefined { return this.pending.find(eligible); }
  notify(): void { for (const wake of [...this.waiters]) wake(); }
  wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer); this.waiters.delete(wake); signal?.removeEventListener("abort", wake);
        if (signal?.aborted) reject(signal.reason); else resolve();
      };
      // Cleanup includes external resource reconciliation; periodically retry
      // even if an external supervisor, rather than this host, released it.
      const timer = setTimeout(wake, 100);
      this.waiters.add(wake); signal?.addEventListener("abort", wake, { once: true });
      if (signal?.aborted) wake();
    });
  }
}
