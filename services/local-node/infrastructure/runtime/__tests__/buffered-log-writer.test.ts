import { expect, it, vi } from 'vitest';
import { BufferedLogWriter } from '../buffered-log-writer.js';

it('batches a log burst by destination and preserves each file order', async () => {
  const append = vi.fn(async () => {});
  const writer = new BufferedLogWriter(append);
  for (let i = 0; i < 1000; i++) {
    writer.write('api.log', `${i}\n`);
    writer.write('events.jsonl', `${i}\n`);
  }
  expect(append).not.toHaveBeenCalled();
  await writer.flush();
  expect(append).toHaveBeenCalledTimes(2);
  const expected = Array.from({ length: 1000 }, (_, i) => `${i}\n`).join('');
  expect(append.mock.calls.map(call => (call as unknown as [string, Buffer])[1].toString())).toEqual([expected, expected]);
});

it('counts in-flight bytes against the bound, reports overflow and recovers', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const append = vi.fn(async (_file: string, _data: Buffer) => { await gate; });
  const report = vi.fn();
  const writer = new BufferedLogWriter(append, report, 8);
  writer.write('log', '12345678');
  const flushed = writer.flush();
  await Promise.resolve();
  for (let i = 0; i < 1000; i++) writer.write('log', 'x');
  const second = writer.flush();
  expect(second).toBe(flushed);
  expect(append).toHaveBeenCalledOnce();
  release();
  await second;
  expect(report).toHaveBeenCalledExactlyOnceWith('Diagnostic log buffer full: dropped 1000 entries.');
  writer.write('log', 'recovery');
  await writer.flush();
  expect(append).toHaveBeenCalledTimes(2);
});

it('fences a flush without waiting for later producers or reordering writes', async () => {
  const releases: Array<() => void> = [];
  const append = vi.fn(async (_file: string, _data: Buffer) => new Promise<void>(resolve => releases.push(resolve)));
  const writer = new BufferedLogWriter(append);
  writer.write('log', 'before');
  const first = writer.flush();
  await Promise.resolve();
  writer.write('log', 'after');
  const last = writer.flush();
  expect(append).toHaveBeenCalledOnce();
  releases.shift()!();
  await first;
  expect(append.mock.calls.map(call => call[1].toString())).toEqual(['before', 'after']);
  releases.shift()!();
  await last;
});

it('continues after a failed write even if error reporting fails', async () => {
  const append = vi.fn(async (_file: string, _data: Buffer) => {});
  append.mockRejectedValueOnce(new Error('disk full'));
  const report = vi.fn(() => { throw new Error('stderr closed'); });
  const writer = new BufferedLogWriter(append, report);
  writer.write('log', 'first');
  await writer.flush();
  writer.write('log', 'second');
  await writer.flush();
  expect(append).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledOnce();
});
