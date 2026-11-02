import { afterEach, expect, it, vi } from 'vitest';
import { ProjectBadgeRefresh } from './projectBadgeRefresh';

afterEach(() => vi.useRealTimers());

it('coalesces slow reads and preserves one trailing event without starvation', async () => {
  vi.useFakeTimers();
  let release!: (value: number) => void;
  const read = vi.fn(() => new Promise<number>(resolve => { release = resolve; }));
  const accept = vi.fn();
  const owner = new ProjectBadgeRefresh(read, accept);
  const first = owner.refresh();
  await Promise.resolve();
  for (let index = 0; index < 50; index++) owner.invalidate();
  expect(owner.refresh()).toBe(first);
  await vi.advanceTimersByTimeAsync(2000);
  expect(read).toHaveBeenCalledTimes(1);
  release(1);
  await first;
  await vi.advanceTimersByTimeAsync(300);
  expect(read).toHaveBeenCalledTimes(2);
  release(2);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(accept.mock.calls).toEqual([[1], [2]]);
  expect(read).toHaveBeenCalledTimes(2);
  owner.dispose();
});

it('does not publish a late result or schedule a retry after disposal', async () => {
  vi.useFakeTimers();
  let release!: (value: number) => void;
  const read = vi.fn(() => new Promise<number>(resolve => { release = resolve; }));
  const accept = vi.fn();
  const owner = new ProjectBadgeRefresh(read, accept);
  const pending = owner.refresh();
  await Promise.resolve();
  owner.invalidate();
  owner.dispose();
  release(1);
  await pending;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(accept).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
});

it('recovers after a failed request and throttles a sustained event stream', async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(2);
  const accept = vi.fn();
  const owner = new ProjectBadgeRefresh(read, accept);
  await owner.refresh();
  for (let index = 0; index < 20; index++) {
    owner.invalidate();
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(read).toHaveBeenCalledTimes(3);
  expect(accept).toHaveBeenLastCalledWith(2);
  owner.dispose();
});
