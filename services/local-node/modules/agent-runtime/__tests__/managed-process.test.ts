import { describe, expect, it } from 'vitest';
import { spawnManagedProcess, withDeadline } from '../managed-process.js';

describe('owned protocol process termination', () => {
  it('waits until a real owned process is gone', async () => {
    const process = spawnManagedProcess(globalThis.process.execPath, ['-e', "console.log('ready');setInterval(()=>{},1000)"], { graceMs: 50 });
    try {
      await withDeadline(new Promise<void>(resolve => process.child.stdout.once('data', () => resolve())), 2000, 'Not ready');
      const pid = process.child.pid!;
      await process.stop();
      expect(() => globalThis.process.kill(pid, 0)).toThrow();
    } finally { await process.stop(); }
  });
  it.skipIf(globalThis.process.platform === 'win32')('escalates for a process which ignores SIGTERM', async () => {
    const process = spawnManagedProcess(globalThis.process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"], { graceMs: 50 });
    try {
      await withDeadline(new Promise<void>(resolve => process.child.stdout.once('data', () => resolve())), 2000, 'Not ready');
      await process.stop();
      expect(process.child.signalCode).toBe('SIGKILL');
    } finally { await process.stop(); }
  });
  it.skipIf(globalThis.process.platform === 'win32')('cleans up descendants even if their protocol host exits first', async () => {
    const childCode = "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)";
    const parentCode = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>{console.log(c.pid);process.exit(0)})`;
    const managed = spawnManagedProcess(globalThis.process.execPath, ['-e', parentCode], { graceMs: 50 });
    try {
      const childPid = await withDeadline(new Promise<number>(resolve => managed.child.stdout.once('data', data => resolve(Number(String(data).trim())))), 2000, 'Child not ready');
      await managed.closed;
      await managed.stop();
      expect(() => globalThis.process.kill(childPid, 0)).toThrow();
    } finally { await managed.stop(); }
  });

  it('settles a failed spawn without leaving an unhandled process error', async () => {
    const process = spawnManagedProcess('/not/a/synax/executable', []);
    await process.closed;
    await process.stop();
    expect(process.child.exitCode).toBe(127);
  });
});
