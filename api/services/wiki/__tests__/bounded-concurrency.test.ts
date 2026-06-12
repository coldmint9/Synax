import { describe, it, expect } from 'vitest';
import { runBoundedConcurrency } from '../bounded-concurrency.js';

describe('runBoundedConcurrency', () => {
  it('runs all items with a concurrency ceiling', async () => {
    const order: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    await runBoundedConcurrency([0, 1, 2, 3, 4], 2, async (_item, index) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(index);
      await new Promise(r => setTimeout(r, 5));
      inFlight -= 1;
    });

    expect(order.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('propagates worker errors', async () => {
    await expect(
      runBoundedConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
