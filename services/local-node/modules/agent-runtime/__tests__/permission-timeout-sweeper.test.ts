import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  listSessionProjection: vi.fn(), controlState: vi.fn(), controlCommand: vi.fn(),
}));
vi.mock('../sidecar/runtime-facade.js', () => ({ runtimeFacade: runtime }));
vi.mock('../../../infrastructure/runtime/env.js', () => ({ PERMISSION_TIMEOUT_MS: 60_000 }));
vi.mock('../../../infrastructure/runtime/logger.js', () => ({ logger: {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
} }));
import { startPermissionTimeoutSweeper, stopPermissionTimeoutSweeper, sweepExpiredPermissionsAuthoritative } from '../permission-timeout-sweeper.js';

beforeEach(() => {
  vi.clearAllMocks();
  runtime.controlState.mockResolvedValue({ permissions: [] });
  runtime.controlCommand.mockResolvedValue({});
});
afterEach(async () => { await stopPermissionTimeoutSweeper(); vi.useRealTimers(); });

it('does not load historical sessions with no pending permissions', async () => {
  runtime.listSessionProjection.mockResolvedValue(Array.from({ length: 500 }, (_, id) => ({ id: `idle-${id}`, pendingPermissionCount: 0 })));
  expect(await sweepExpiredPermissionsAuthoritative()).toBe(0);
  expect(runtime.controlState).not.toHaveBeenCalled();
});

it('sweeps authoritative pending permissions even on a completed session and supports old sidecars', async () => {
  runtime.listSessionProjection.mockResolvedValue([
    { id: 'idle', pendingPermissionCount: 0 },
    { id: 'pending', status: 'completed', pendingPermissionCount: 1 },
    { id: 'legacy' },
  ]);
  runtime.controlState.mockResolvedValue({ permissions: [
    { id: 'expired', action: 'ask', resolvedAt: null, createdAt: new Date(Date.now() - 120_000).toISOString() },
    { id: 'fresh', action: 'ask', createdAt: new Date().toISOString() },
    { id: 'resolved', action: 'ask', resolvedAt: new Date().toISOString(), createdAt: '2020-01-01' },
  ] });
  expect(await sweepExpiredPermissionsAuthoritative()).toBe(2);
  expect(runtime.controlState.mock.calls).toEqual([['pending'], ['legacy']]);
  expect(runtime.controlCommand).toHaveBeenCalledTimes(2);
  expect(runtime.controlCommand).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 'pending', operation: 'permission_reply', payload: expect.objectContaining({ id: 'expired', reply: 'reject' }),
  }));
});

it('does not accumulate scans when one pass lasts longer than multiple timer ticks', async () => {
  vi.useFakeTimers();
  let release!: (sessions: unknown[]) => void;
  runtime.listSessionProjection.mockReturnValue(new Promise(resolve => { release = resolve; }));
  startPermissionTimeoutSweeper();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(runtime.listSessionProjection).toHaveBeenCalledTimes(1);
  const pending = sweepExpiredPermissionsAuthoritative();
  expect(sweepExpiredPermissionsAuthoritative()).toBe(pending);
  release([]);
  await pending;
  runtime.listSessionProjection.mockResolvedValue([]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(runtime.listSessionProjection).toHaveBeenCalledTimes(2);
});

it('allows the next pass after a failed scan', async () => {
  runtime.listSessionProjection.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue([]);
  await expect(sweepExpiredPermissionsAuthoritative()).rejects.toThrow('unavailable');
  await expect(sweepExpiredPermissionsAuthoritative()).resolves.toBe(0);
});

it('drains an in-flight read without mutating permissions after shutdown begins', async () => {
  runtime.listSessionProjection.mockResolvedValue([{ id: 's', pendingPermissionCount: 1 }]);
  let release!: (state: unknown) => void;
  runtime.controlState.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const running = sweepExpiredPermissionsAuthoritative();
  await Promise.resolve();
  const stopped = stopPermissionTimeoutSweeper();
  release({ permissions: [{ id: 'expired', action: 'ask', createdAt: '2020-01-01' }] });
  await Promise.all([running, stopped]);
  expect(runtime.controlCommand).not.toHaveBeenCalled();
});
