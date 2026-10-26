import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkerShutdown,
  WORKER_SHUTDOWN_TIMEOUT_MS,
} from './worker-shutdown.js';

afterEach(() => vi.useRealTimers());
describe('bounded worker shutdown', () => {
  it('drains diagnostic logs after cleanup and retains the shutdown deadline', async () => {
    vi.useFakeTimers();
    const exit = vi.fn(), report = vi.fn();
    const flush = vi.fn(() => new Promise<void>(() => {}));
    const shutdown = createWorkerShutdown({ abort() {}, cleanup: () => [Promise.reject(Error('cleanup failed'))], exit, report, flush });
    shutdown('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
  it('aborts immediately, starts independent cleanup, and exits once', async () => {
    vi.useFakeTimers();
    const exit = vi.fn(), abort = vi.fn(), report = vi.fn();
    const cleanup = vi.fn(() => [Promise.resolve()]);
    const shutdown = createWorkerShutdown({ abort, cleanup, exit, report });
    shutdown('disconnect'); shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(abort).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('exits despite a provider or cleanup promise that ignores cancellation', async () => {
    vi.useFakeTimers();
    const exit = vi.fn(), report = vi.fn();
    let finish!: () => void;
    const stuck = new Promise<void>(resolve => { finish = resolve; });
    const shutdown = createWorkerShutdown({ abort: vi.fn(), cleanup: () => [stuck], exit, report });
    shutdown('parent lost');
    await vi.advanceTimersByTimeAsync(WORKER_SHUTDOWN_TIMEOUT_MS - 1); expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledOnce(); expect(report).toHaveBeenCalledOnce();
  });
  it('does not turn cleanup failure into an unhandled rejection', async () => {
    vi.useFakeTimers();
    const exit = vi.fn(), report = vi.fn();
    createWorkerShutdown({ abort: () => { throw Error('abort failed'); }, cleanup: () => [Promise.reject(Error('cleanup failed'))], exit, report })('stop');
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1); expect(report).toHaveBeenCalledTimes(2);
  });
});

it('exits a real orphaned IPC worker even with a stuck provider', async () => {
  const { fork } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const module = fileURLToPath(new URL('./worker-shutdown.ts', import.meta.url));
  const proc = fork(module, [], {
    execArgv: ['--import', 'tsx', '--input-type=module', '-e', `
      import {createWorkerShutdown} from ${JSON.stringify(module)};
      const stop=createWorkerShutdown({abort(){},cleanup:()=>[new Promise(()=>{})],report(){},exit:code=>process.exit(code),timeoutMs:100});
      process.on('disconnect',()=>stop('parent disconnected'));
      setInterval(()=>{},1000);
      process.send('ready');
    `], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const exit = new Promise<number | null>(resolve => proc.once('exit', resolve));
  let stderr = '';
  proc.stderr!.on('data', data => { stderr += data; });
  const deadline = setTimeout(() => proc.kill('SIGKILL'), 5_000);
  try {
    await new Promise<void>((resolve, reject) => {
      proc.once('message', () => resolve());
      proc.once('error', reject);
      proc.once('exit', () => reject(Error(stderr || 'Worker exited before readiness')));
    });
    proc.disconnect();
    expect(await exit).toBe(1);
  } finally { clearTimeout(deadline); if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }
}, 10_000);

it('the independent watchdog terminates shutdown blocked in a native-style wait', async () => {
  const { fork } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const module = fileURLToPath(new URL('./worker-shutdown.ts', import.meta.url));
  const proc = fork(module, [], {
    execArgv: ['--import', 'tsx', '--input-type=module', '-e', `
      import {createWorkerShutdown,startExitWatchdog} from ${JSON.stringify(module)};
      const stop=createWorkerShutdown({
        startWatchdog:()=>startExitWatchdog(150), abort(){},
        cleanup(){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);return []},
        report(){},exit:code=>process.exit(code),timeoutMs:100
      });
      process.on('disconnect',()=>stop('parent disconnected'));
      process.send('ready');
    `], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const exit = new Promise<NodeJS.Signals | null>(resolve => proc.once('exit', (_code, signal) => resolve(signal)));
  const emergency = setTimeout(() => proc.kill('SIGTERM'), 4_000);
  try {
    await new Promise<void>((resolve, reject) => {
      proc.once('message', () => resolve()); proc.once('error', reject);
      proc.once('exit', () => reject(Error('Worker exited before readiness')));
    });
    proc.disconnect();
    expect(await exit).toBe('SIGKILL');
  } finally { clearTimeout(emergency); if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }
}, 8_000);
