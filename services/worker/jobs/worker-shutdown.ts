import { Worker } from 'node:worker_threads';

/**
 * Shutdown timing contract (inner → outer). The parent process escalates from
 * SIGTERM to SIGKILL after 4s (services/local-node/modules/agent-runtime/
 * session-process-manager.ts `CHILD_EXIT_GRACE_MS`), so the graceful budget
 * and the watchdog must both fire first: a worker that is still unwinding when
 * the parent gives up leaves the parent with a cold reconciliation.
 */
export const WORKER_SHUTDOWN_TIMEOUT_MS = 2_500;
export const WORKER_EXIT_WATCHDOG_MS = 3_000;

/** A JS timer cannot fire while native SQLite/IPC blocks the worker's event
 * loop. This watchdog runs in an independent thread and targets only itself. */
export function startExitWatchdog(timeoutMs = WORKER_EXIT_WATCHDOG_MS): () => void {
  const watchdog = new Worker(`
    const { workerData } = require('node:worker_threads');
    setTimeout(() => process.kill(process.pid, 'SIGKILL'), workerData);
  `, { eval: true, workerData: timeoutMs, execArgv: [] });
  watchdog.on('error', () => {});
  return () => { void watchdog.terminate(); };
}

/** Workers must exit even when a provider, browser or storage IPC never settles.
 * Register the deadline before aborting: abort listeners can themselves throw. */
export function createWorkerShutdown(options: {
  abort(reason: string): void;
  cleanup(reason: string): Promise<unknown>[];
  flush?(): Promise<void>;
  report(error: unknown): void;
  exit(code: number): void;
  timeoutMs?: number;
  startWatchdog?(): () => void;
}) {
  let stopping = false;
  return (reason: string) => {
    if (stopping) return;
    stopping = true;
    const stopWatchdog = options.startWatchdog?.();
    let exited = false;
    const finish = (code: number) => {
      if (exited) return;
      exited = true;
      clearTimeout(deadline);
      stopWatchdog?.();
      options.exit(code);
    };
    const deadline = setTimeout(() => {
      try { options.report(new Error(`Worker shutdown timed out: ${reason}`)); }
      finally { finish(1); }
    }, options.timeoutMs ?? WORKER_SHUTDOWN_TIMEOUT_MS);
    // Keep this timer referenced: it is also the exit path for unresolved Promises.
    void (async () => {
      let failed = false;
      try { options.abort(reason); } catch (error) { failed = true; options.report(error); }
      try {
        const results = await Promise.allSettled(options.cleanup(reason));
        for (const result of results) if (result.status === 'rejected') {
          failed = true; options.report(result.reason);
        }
      } catch (error) { failed = true; options.report(error); }
      try { await options.flush?.(); } catch (error) { failed = true; options.report(error); }
      finish(failed ? 1 : 0);
    })().catch(error => {
      try { options.report(error); } finally { finish(1); }
    });
  };
}
