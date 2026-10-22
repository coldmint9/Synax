/** Background workers and interactive requests share a per-session recovery.
 * The interactive path bypasses the background queue, so a slow old session
 * cannot delay a newly opened one. Failed sessions remain fenced and retryable. */
export class SessionRecovery {
  private readonly completed = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();
  private stopping = false;
  constructor(private readonly recover: (sessionId: string) => Promise<void>) {}

  created(sessionId: string): void { this.completed.add(sessionId); }

  ensure(sessionId: string): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('Session recovery is stopping.'));
    if (this.completed.has(sessionId)) return Promise.resolve();
    const existing = this.pending.get(sessionId);
    if (existing) return existing;
    const task = Promise.resolve().then(() => this.recover(sessionId)).then(() => {
      this.completed.add(sessionId);
    }).finally(() => { this.pending.delete(sessionId); });
    this.pending.set(sessionId, task);
    return task;
  }

  async warm(sessionIds: string[], failed: (sessionId: string, error: unknown) => void): Promise<void> {
    let cursor = 0;
    const worker = async () => {
      while (!this.stopping && cursor < sessionIds.length) {
        const id = sessionIds[cursor++];
        try { await this.ensure(id); } catch (error) { failed(id, error); }
        // Let the HTTP event loop process interactive requests between sessions.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    await Promise.all([worker(), worker()]);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled(this.pending.values());
  }
}

let active: SessionRecovery | undefined;
export function installSessionRecovery(recovery: SessionRecovery): void { active = recovery; }
export function ensureSessionRecovered(sessionId: string): Promise<void> {
  return active?.ensure(sessionId) ?? Promise.resolve();
}
export function stopSessionRecovery(): Promise<void> { return active?.stop() ?? Promise.resolve(); }
export function markSessionCreated(sessionId: string): void { active?.created(sessionId); }
