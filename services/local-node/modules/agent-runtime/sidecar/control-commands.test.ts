import { afterEach, expect, it, vi } from 'vitest';
import { executeControlCommand, withSessionRevision } from './control-commands.js';
import { RuntimeSidecarClient, RuntimeSidecarError } from './sidecar-client.js';
import { logger } from '../../../infrastructure/runtime/logger.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const conflict = (expected: number, actual: number) => new RuntimeSidecarError({
  type: 'error', code: 'REVISION_CONFLICT', message: 'session revision is stale', expected, actual,
});
const client = (overrides = {}) => ({
  coordinationKey: 'test-runtime',
  connect: vi.fn(async () => ({ capabilities: ['control_current_v1'] })),
  snapshot: vi.fn(async () => ({ epoch: 4, revision: 10 })),
  controlCommand: vi.fn(async () => ({ stateJson: encode({}), epoch: 4, revision: 10 })),
  ...overrides,
}) as unknown as RuntimeSidecarClient;
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(['lease_open', 'lease_close', 'read', 'execution_check'])('executes %s in one RPC without snapshot or CAS retries', async operation => {
  const remote = client();
  const payload = { leaseId: 'l', hostId: 'h' };
  await executeControlCommand(remote, { sessionId: 's', requestId: 'request', operation, payload });
  expect(remote.snapshot).not.toHaveBeenCalled();
  expect(remote.controlCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    epoch: 0, revision: 0,
    operation: operation === 'read' ? 'read_current' : operation === 'execution_check' ? operation : 'lease_update',
  }));
});

it('falls back to fenced operations for older runtimes', async () => {
  const remote = client({ connect: vi.fn(async () => ({ capabilities: [] })) });
  await executeControlCommand(remote, { sessionId: 's', requestId: 'request', operation: 'lease_open', payload: { leaseId: 'l' } });
  expect(remote.snapshot).toHaveBeenCalledOnce();
  expect(remote.controlCommand).toHaveBeenCalledWith(expect.objectContaining({ operation: 'lease_open', epoch: 4, revision: 10 }));
});

it('serializes a complete compare/write across two clients, without serializing different sessions', async () => {
  const revisions = new Map<string, number>();
  const active = new Set<string>();
  let simultaneous = false;
  const make = () => client({
    snapshot: vi.fn(async (id: string) => ({ epoch: 4, revision: revisions.get(id) ?? 0 })),
    controlCommand: vi.fn(async (input: { sessionId: string; revision: number }) => {
      expect(active.has(input.sessionId)).toBe(false);
      active.add(input.sessionId);
      if (active.size > 1) simultaneous = true;
      await new Promise(resolve => setTimeout(resolve, 1));
      expect(input.revision).toBe(revisions.get(input.sessionId) ?? 0);
      revisions.set(input.sessionId, input.revision + 1);
      active.delete(input.sessionId);
      return { stateJson: encode({}), epoch: 4, revision: input.revision + 1 };
    }),
  });
  const clients = [make(), make()];
  await Promise.all(Array.from({ length: 40 }, (_, i) => executeControlCommand(clients[i % 2], {
    sessionId: `s${i % 3}`, requestId: `r${i}`, operation: 'session_patch', payload: {},
  })));
  expect(simultaneous).toBe(true);
  expect([...revisions.values()].reduce((a, b) => a + b, 0)).toBe(40);
  expect(clients.reduce((n, c) => n + vi.mocked(c.controlCommand).mock.calls.length, 0)).toBe(40);
});

it('backs off and uses the conflict revision without issuing another snapshot', async () => {
  vi.useFakeTimers();
  const remote = client({ controlCommand: vi.fn().mockRejectedValueOnce(conflict(10, 12))
    .mockResolvedValue({ stateJson: encode({}) }) });
  const result = executeControlCommand(remote, { sessionId: 's', requestId: 'r', operation: 'run_patch' });
  await vi.advanceTimersByTimeAsync(0);
  expect(remote.controlCommand).toHaveBeenCalledTimes(1);
  await vi.runAllTimersAsync(); await result;
  expect(remote.snapshot).toHaveBeenCalledOnce();
  expect(remote.controlCommand).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'r', epoch: 4, revision: 12 }));
});

it('does not rebase an operation across an epoch change or retry execution failures', async () => {
  vi.useFakeTimers();
  const stale = new RuntimeSidecarError({ type: 'error', code: 'STALE_EPOCH', message: 'owner changed' });
  const remote = client({ controlCommand: vi.fn().mockRejectedValueOnce(conflict(10, 11)).mockRejectedValueOnce(stale) });
  const result = executeControlCommand(remote, { sessionId: 's', requestId: 'r', operation: 'stop_begin' });
  const check = expect(result).rejects.toBe(stale);
  await vi.runAllTimersAsync(); await check;
  expect(remote.snapshot).toHaveBeenCalledOnce();
  expect(remote.controlCommand).toHaveBeenCalledTimes(2);
});

it('keeps critical controls available while ordinary session writes are waiting', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const remote = client();
  const ordinary = withSessionRevision(remote, 's', 'session_patch', async () => { await gate; });
  await executeControlCommand(remote, { sessionId: 's', requestId: 'stop', operation: 'stop_begin' });
  expect(remote.controlCommand).toHaveBeenCalledOnce();
  release(); await ordinary;
});

it('bounds persistent contention and logs exhaustion once', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  const remote = client({ controlCommand: vi.fn(async (input: { revision: number }) => {
    throw conflict(input.revision, input.revision + 1);
  }) });
  const result = executeControlCommand(remote, { sessionId: 's', requestId: 'r', operation: 'session_patch' });
  const check = expect(result).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await vi.runAllTimersAsync(); await check;
  expect(remote.controlCommand).toHaveBeenCalledTimes(8);
  expect(remote.snapshot).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attempts: 8 }), expect.any(String));
});

it('returns entity revision conflicts without rebasing an unrelated session fence', async () => {
  const remote = client({ controlCommand: vi.fn().mockRejectedValue(conflict(2, 3)) });
  await expect(executeControlCommand(remote, { sessionId: 's', requestId: 'r', operation: 'interaction_resolve' }))
    .rejects.toMatchObject({ expected: 2, actual: 3 });
  expect(remote.controlCommand).toHaveBeenCalledOnce();
});

it('releases a failed operation and bounds per-session waiters', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const remote = client();
  const reads = Array.from({ length: 128 }, () => withSessionRevision(remote, 's', 'session_patch', async () => { await gate; }));
  await expect(withSessionRevision(remote, 's', 'session_patch', async () => {})).rejects.toThrow('queue is full');
  release(); await Promise.all(reads);
  await expect(withSessionRevision(remote, 's', 'session_patch', async () => { throw new Error('failure'); })).rejects.toThrow('failure');
  await expect(withSessionRevision(remote, 's', 'session_patch', async () => 42)).resolves.toBe(42);
});
