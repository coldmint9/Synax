import { expect, it, vi } from 'vitest';
import { SessionRecovery } from '../session-recovery.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('interactive sessions bypass blocked background work and share their own recovery', async () => {
  const slow = gate();
  const entered = gate();
  let waiting = 0;
  const recover = vi.fn(async (id: string) => {
    if (id.startsWith('old')) { if (++waiting === 2) entered.resolve(); await slow.promise; }
  });
  const recovery = new SessionRecovery(recover);
  const warming = recovery.warm(['old-1', 'old-2', 'interactive'], () => {});
  await entered.promise;
  try {
    await Promise.all([recovery.ensure('interactive'), recovery.ensure('interactive')]);
    expect(recover.mock.calls.filter(([id]) => id === 'interactive')).toHaveLength(1);
    slow.resolve(); await warming;
    expect(recover.mock.calls.filter(([id]) => id === 'interactive')).toHaveLength(1);
  } finally { slow.resolve(); await warming; }
});

it('a failed session does not stop healthy recovery and can be retried on demand', async () => {
  const recover = vi.fn(async (id: string) => { if (id === 'broken') throw new Error('corrupt'); });
  const failed = vi.fn();
  const recovery = new SessionRecovery(recover);
  await recovery.warm(['broken', 'healthy'], failed);
  expect(failed).toHaveBeenCalledExactlyOnceWith('broken', expect.any(Error));
  await recovery.ensure('healthy');
  expect(recover.mock.calls.filter(([id]) => id === 'healthy')).toHaveLength(1);
  recover.mockResolvedValue(undefined);
  await recovery.ensure('broken');
  expect(recover.mock.calls.filter(([id]) => id === 'broken')).toHaveLength(2);
});

it('does not recover sessions created by the current host even if later listed by the background scan', async () => {
  const recover = vi.fn(async () => {});
  const recovery = new SessionRecovery(recover);
  recovery.created('new-session');
  await recovery.ensure('new-session');
  await recovery.warm(['new-session'], () => {});
  expect(recover).not.toHaveBeenCalled();
});

it('shutdown drains only active recovery and does not start queued sessions', async () => {
  const slow = gate();
  const entered = gate();
  let count = 0;
  const recover = vi.fn(async () => { if (++count === 2) entered.resolve(); await slow.promise; });
  const recovery = new SessionRecovery(recover);
  const warming = recovery.warm(['one', 'two', 'three'], () => {});
  await entered.promise;
  const stopping = recovery.stop();
  await expect(recovery.ensure('new')).rejects.toThrow('stopping');
  slow.resolve();
  await Promise.all([warming, stopping]);
  expect(recover).toHaveBeenCalledTimes(2);
});
