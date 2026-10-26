import { runtimeBus, type RuntimeBusEvent } from '../runtime-bus.js';

export const MERGE_WORKER_PROGRESS_TIMEOUT_MS = 10 * 60_000;
interface Watch {
  lastProgressAt: number;
  seen: Set<string>;
  deadlineMs: number;
  timer?: ReturnType<typeof setTimeout>;
  expired: boolean;
  onExpired: () => Promise<void>;
  settle: (error?: Error) => void;
}

/** One shared listener and one deadline per active child. No heartbeat polling. */
export class MergeWorkerWatchdog {
  private readonly watches = new Map<string, Watch>();
  private unsubscribe?: () => void;
  constructor(private readonly events: Pick<typeof runtimeBus, 'subscribe'> = runtimeBus) {}
  get size(): number { return this.watches.size; }

  watch(childId: string, onExpired: () => Promise<void>, deadlineMs = MERGE_WORKER_PROGRESS_TIMEOUT_MS) {
    if (this.watches.has(childId)) throw new Error('Merge worker is already supervised.');
    if (this.watches.size >= 64) throw new Error('Merge watchdog capacity reached.');
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error('Invalid merge progress deadline.');
    let settle!: (error?: Error) => void;
    const expired = new Promise<Error | undefined>(resolve => { settle = resolve; });
    const watch: Watch = { lastProgressAt: Date.now(), seen: new Set(), deadlineMs, expired: false, onExpired, settle };
    this.watches.set(childId, watch);
    this.unsubscribe ??= this.events.subscribe(event => this.onEvent(event));
    const schedule = () => {
      watch.timer = setTimeout(() => {
        if (this.watches.get(childId) !== watch) return;
        const remaining = watch.deadlineMs - (Date.now() - watch.lastProgressAt);
        if (remaining > 0) { schedule(); return; }
        watch.expired = true;
        dispose();
        // Detach supervision before an async stop so progress cannot resurrect
        // the lease and one hung shutdown cannot retain the shared listener.
        void watch.onExpired().then(() => settle(), error => settle(error instanceof Error ? error : new Error(String(error))));
      }, Math.max(1, watch.deadlineMs - (Date.now() - watch.lastProgressAt)));
      watch.timer.unref?.();
    };
    const dispose = () => {
      if (watch.timer) clearTimeout(watch.timer);
      watch.timer = undefined;
      if (this.watches.get(childId) === watch) this.watches.delete(childId);
      if (!this.watches.size) { this.unsubscribe?.(); this.unsubscribe = undefined; }
    };
    schedule();
    return { expired, dispose, get timedOut() { return watch.expired; } };
  }

  progress(childId: string, identity: string): void {
    const watch = this.watches.get(childId);
    if (!watch || watch.expired || watch.seen.has(identity)) return;
    watch.seen.add(identity);
    // Bound supervision memory even for very large, productive merges.
    if (watch.seen.size > 1024) watch.seen.delete(watch.seen.values().next().value!);
    watch.lastProgressAt = Date.now();
  }
  private onEvent(event: RuntimeBusEvent): void {
    if (event.type === 'merge_worker_progress' && event.childSessionId && typeof event.patch?.identity === 'string')
      this.progress(event.childSessionId, event.patch.identity);
  }
}
export const mergeWorkerWatchdog = new MergeWorkerWatchdog();
