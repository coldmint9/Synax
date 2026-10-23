import { describe, expect, it, vi } from 'vitest';
import { BoundedEventWriter } from './bounded-event-writer.js';

describe('BoundedEventWriter', () => {
  it('coalesces slow observer updates while retaining the newest terminal state', async () => {
    let release!: () => void;
    const write = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; })).mockResolvedValue(undefined);
    const failed = vi.fn();
    const writer = new BoundedEventWriter(write, failed);
    writer.push({ event: 'state', data: 'first' }, 'task');
    for (let i = 0; i < 1000; i++) writer.push({ event: 'state', data: String(i) }, 'task');
    writer.push({ event: 'state', data: 'completed' }, 'task', 1001);
    writer.push({ event: 'state', data: 'late stale progress' }, 'task', 1000);
    expect(write).toHaveBeenCalledTimes(1);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(write.mock.calls.map(call => call[0].data)).toEqual(['first', 'completed']);
    expect(failed).not.toHaveBeenCalled();
    writer.dispose();
  });

  it('disconnects once on byte overflow and never drains discarded events', async () => {
    let release!: () => void;
    const write = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const failed = vi.fn();
    const writer = new BoundedEventWriter(write, failed, 12, 3);
    writer.push({ event: 's', data: '12345' });
    writer.push({ event: 's', data: '123456' });
    writer.push({ event: 's', data: 'ignored' });
    expect(failed).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('isolates a rejected write from the producer and releases queued payloads', async () => {
    const write = vi.fn().mockRejectedValue(new Error('connection closed'));
    const failed = vi.fn();
    const writer = new BoundedEventWriter(write, failed);
    writer.push({ event: 's', data: 'one' });
    writer.push({ event: 's', data: 'two' });
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
