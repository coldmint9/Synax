import { spawnOwnedProcess } from './owned-process.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function withDeadline<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  stop(): Promise<void>;
}

/** Each protocol host has its own process group; shutdown waits for that group, not just a sent signal. */
export function spawnManagedProcess(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; inheritEnv?: boolean; graceMs?: number; stopTimeoutMs?: number;
} = {}): ManagedProcess {
  const grouped = process.platform !== 'win32';
  const child = spawnOwnedProcess(command, args, { cwd: options.cwd, env: options.env, inheritEnv: options.inheritEnv }) as ChildProcessWithoutNullStreams;
  let ended = false;
  let released = false;
  let stopOnExit = () => {};
  const closed = new Promise<void>(resolve => {
    const done = () => {
      if (ended) return;
      ended = true; resolve();
      if (grouped && child.pid && alive()) stopOnExit();
      else released = true;
    };
    child.once('close', done); child.once('error', done);
  });
  let stopping: Promise<void> | undefined;
  const signal = (kind: NodeJS.Signals) => {
    if (!child.pid) return;
    try { if (grouped) process.kill(-child.pid, kind); else child.kill(kind); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const alive = () => {
    if (!child.pid) return false;
    if (!grouped) return !ended;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  };
  const managed: ManagedProcess = { child, closed, stop() {
    if (stopping) return stopping;
    // Natural exit also releases surviving descendants before the PID can be forgotten.
    if (released) return Promise.resolve();
    stopping = (async () => {
      if (!child.pid) { await closed; return; }
      if (!grouped) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        await withDeadline(new Promise<void>((resolve, reject) => {
          killer.once('error', reject); killer.once('exit', () => resolve());
        }), options.stopTimeoutMs ?? 4000, 'Process-tree termination could not be confirmed.');
      } else {
        signal('SIGTERM');
        const start = Date.now(); let forced = false;
        while (alive()) {
          if (!forced && Date.now() - start >= (options.graceMs ?? 1500)) { signal('SIGKILL'); forced = true; }
          if (Date.now() - start > (options.stopTimeoutMs ?? 4000)) throw new Error('Process-group termination could not be confirmed.');
          await delay(20);
        }
      }
      await withDeadline(closed, options.stopTimeoutMs ?? 4000, 'Process stream closure could not be confirmed.');
      released = true;
    })();
    return stopping;
  } };
  stopOnExit = () => { void managed.stop().catch(() => { /* stop() retains the rejection for its owner. */ }); };
  return managed;
}
