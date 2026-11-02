import { afterEach, expect, it, vi } from 'vitest';
import { WorkerAdmission } from '../worker-admission.js';
afterEach(() => vi.unstubAllEnvs());
it('retains the three newest idle workers and evicts older ones under normal load', () => {
  vi.stubEnv('SYNAX_IDLE_WORKER_MAX', undefined);
  const admission = new WorkerAdmission(16);
  const leases = Array.from({ length: 5 }, (_, index) => {
    const lease = admission.lifecycle.start(`s-${index}`);
    admission.lifecycle.running(lease); admission.lifecycle.idle(lease);
    lease.idleAt = index;
    return lease;
  });
  expect(admission.idleLimit).toBe(3);
  expect(admission.evictions()).toEqual(leases.slice(0, 2));
  // Reusing the oldest session makes it the newest idle entry.
  admission.lifecycle.running(leases[0]); admission.lifecycle.idle(leases[0]);
  expect(admission.evictions()).toEqual([leases[1], leases[2]]);
  expect(admission.evictions(true)).toHaveLength(5);
});
it.each([['99', 3], ['1', 1], ['0', 0], ['-2', 0], ['bad', 3]])('bounds idle pool setting %s to %i', (setting, expected) => {
  vi.stubEnv('SYNAX_IDLE_WORKER_MAX', setting);
  expect(new WorkerAdmission(16).idleLimit).toBe(expected);
  expect(new WorkerAdmission(2).idleLimit).toBe(Math.min(2, expected));
});
it('counts starting/releasing workers and rejects late generations after confirmed exit', () => {
  const admission = new WorkerAdmission(1);
  const lifecycle = admission.lifecycle;
  const first = lifecycle.start('s');
  expect(admission.canStart('other', lifecycle.physicalCount, () => true)).toBe(false);
  expect(admission.canStart('s', lifecycle.physicalCount, () => true)).toBe(false);
  lifecycle.running(first); lifecycle.release(first);
  expect(lifecycle.physicalCount).toBe(1);
  lifecycle.exited(first);
  expect(lifecycle.physicalCount).toBe(0);
  expect(admission.canStart('s', 0, () => true)).toBe(false);
  lifecycle.recovered(first);
  const second = lifecycle.start('s');
  expect(second.generation).toBeGreaterThan(first.generation);
  lifecycle.exited(first); lifecycle.recovered(first);
  expect(lifecycle.current(second)).toBe(true);
  expect(() => lifecycle.running(first)).toThrow();
});
it('separates same-session idle reuse from capacity, and admission alone selects eviction', () => {
  vi.stubEnv('SYNAX_IDLE_WORKER_MAX', '1');
  const admission = new WorkerAdmission(1);
  const lease = admission.lifecycle.start('s');
  admission.lifecycle.running(lease); admission.lifecycle.idle(lease);
  expect(admission.canStart('s', 1, () => true)).toBe(true);
  expect(admission.canStart('other', 1, () => true)).toBe(false);
  expect(admission.evictions()).toEqual([]);
  expect(admission.evictions(true)).toEqual([lease]);
  vi.stubEnv('SYNAX_IDLE_WORKER_MAX', '0');
  expect(admission.evictions()).toEqual([lease]);
});
it('removes cancelled queue requests before any worker can start', async () => {
  const admission = new WorkerAdmission(1);
  admission.queue.push('cancelled'); admission.queue.push('next');
  const abort = new AbortController();
  const pending = admission.queue.wait(abort.signal);
  abort.abort(new Error('cancelled'));
  await expect(pending).rejects.toThrow('cancelled');
  admission.queue.remove('cancelled');
  expect(admission.canStart('next', 0, () => true)).toBe(true);
  expect(admission.lifecycle.physicalCount).toBe(0);
});
