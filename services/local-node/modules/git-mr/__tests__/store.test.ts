import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GitMrError } from '../errors.js';
import { GitMrStore } from '../store.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'synax-git-lock-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function hold(store: GitMrStore) {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const pending = store.exclusive('task', async () => { entered(); await stopped; });
  await started;
  return { release, pending };
}

it('waits for another store owner to release a short metadata transaction', async () => {
  const first = new GitMrStore(directory);
  const second = new GitMrStore(directory);
  const held = await hold(first);
  const action = vi.fn(async () => 'updated');
  const waiting = second.exclusive('task', action, { waitMs: 2_000 });
  try {
    await delay(60);
    expect(action).not.toHaveBeenCalled();
    const lock = (await readdir(path.join(directory, 'locks'))).find(name => /^[a-f0-9]{64}$/.test(name))!;
    expect(JSON.parse(await readFile(path.join(directory, 'locks', lock, 'owner.json'), 'utf8')).pid).toBe(process.pid);
  } finally { held.release(); await held.pending; }
  expect(await waiting).toBe('updated');
  expect(action).toHaveBeenCalledTimes(1);
  expect(await first.operationActive('task')).toBe(false);
});

it('keeps a live owner locked when waiting expires or is not requested', async () => {
  const first = new GitMrStore(directory);
  const second = new GitMrStore(directory);
  const held = await hold(first);
  const action = vi.fn(async () => undefined);
  try {
    await expect(second.exclusive('task', action)).rejects.toMatchObject({ code: 'REPOSITORY_BUSY' });
    await expect(second.exclusive('task', action, { waitMs: 60 })).rejects.toMatchObject({ code: 'REPOSITORY_BUSY' });
    expect(action).not.toHaveBeenCalled();
    expect(await first.operationActive('task')).toBe(true);
  } finally { held.release(); await held.pending; }
});

it('never retries an action that reports a busy repository after acquiring its lock', async () => {
  const store = new GitMrStore(directory);
  const action = vi.fn(async () => { throw new GitMrError('Another repository operation is active.', 'REPOSITORY_BUSY'); });
  await expect(store.exclusive('task', action, { waitMs: 1_000 })).rejects.toMatchObject({ code: 'REPOSITORY_BUSY' });
  expect(action).toHaveBeenCalledTimes(1);
  expect(await store.operationActive('task')).toBe(false);
});
