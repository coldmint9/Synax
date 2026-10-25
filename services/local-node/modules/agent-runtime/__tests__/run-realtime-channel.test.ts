import { describe, expect, it } from 'vitest';
import { RunRealtimeChannel, RealtimeReplayGap } from '../run-realtime-channel.js';
import type { AgentRunStreamChunk } from '../contracts.js';
const delta = (text: string): AgentRunStreamChunk => ({ type: 'message_delta', runId: 'r', stepId: 'step', delta: text });
const collect = async (source: AsyncIterable<unknown>) => { const out = []; for await (const value of source) out.push(value); return out; };
describe('run realtime channel', () => {
  it('turns an oversized preview into an explicit replay gap without blocking execution', async () => {
    const channel = new RunRealtimeChannel('r', 's', 1024);
    expect(channel.publish(delta('x'.repeat(2048)))).toMatchObject({ realtimeSequence: 1 });
    await expect(channel.subscribe().next()).rejects.toBeInstanceOf(RealtimeReplayGap);
    channel.publish(delta('next')); channel.close();
    expect(await collect(channel.subscribe(1))).toHaveLength(1);
    channel.clearReplay();
  });
  it('evicts replay across channels when the shared 64 MiB payload budget fills', async () => {
    const channels = Array.from({ length: 36 }, () => new RunRealtimeChannel('r', 's'));
    const text = 'x'.repeat(1_900_000);
    try {
      for (const channel of channels) channel.publish(delta(text));
      await expect(channels[0].subscribe().next()).rejects.toBeInstanceOf(RealtimeReplayGap);
      channels.at(-1)!.close();
      expect(await collect(channels.at(-1)!.subscribe())).toHaveLength(1);
    } finally { for (const channel of channels) { channel.close(); channel.clearReplay(); } }
  });
  it('publishes immediately, sequences replay once, and retains terminal for late subscribers', async () => {
    const channel = new RunRealtimeChannel('r', 's');
    const reader = channel.subscribe();
    const first = reader.next();
    channel.publish(delta('漢🙂'));
    expect(await first).toMatchObject({ value: { sequence: 1, chunk: { delta: '漢🙂', realtimeSequence: 1 } } });
    channel.publish(delta('next'));
    channel.publish({ type: 'done', sessionId: 's', runId: 'r' });
    channel.close();
    expect((await collect(channel.subscribe(1))).map((r: any) => r.sequence)).toEqual([2, 3]);
    expect(await collect(channel.subscribe(3))).toEqual([]);
    await reader.return(undefined);
  });
  it('detaches a cancelled reader without cancelling the producer or other readers', async () => {
    const channel = new RunRealtimeChannel('r', 's');
    const controller = new AbortController();
    const reader = channel.subscribe(0, controller.signal);
    const pending = reader.next(); controller.abort();
    expect((await pending).done).toBe(true);
    channel.publish(delta('retained')); channel.close();
    expect(await collect(channel.subscribe())).toHaveLength(1);
  });
  it('rejects cross-run output, expired cursors and slow-reader gaps instead of dropping tokens', async () => {
    const channel = new RunRealtimeChannel('r', 's', 1024, 2);
    expect(() => channel.publish({ ...delta('a'), runId: 'other' } as AgentRunStreamChunk)).toThrow('another run');
    channel.publish(delta('a')); channel.publish(delta('b')); channel.publish(delta('c'));
    await expect(channel.subscribe().next()).rejects.toBeInstanceOf(RealtimeReplayGap);
    await expect(channel.subscribe(99).next()).rejects.toBeInstanceOf(RealtimeReplayGap);
    channel.close('persistence failed');
    const reader = channel.subscribe(2);
    expect(await reader.next()).toMatchObject({ value: { chunk: { delta: 'c' } } });
    await expect(reader.next()).rejects.toThrow('persistence failed');
  });
});

it('keeps a waiting run cursor across a new execution lease and supports the independent rollback switch', async () => {
  const { createRunRealtimeChannel, closeRunRealtimeChannel, getRunRealtimeChannel } = await import('../run-realtime-channel.js');
  const { vi } = await import('vitest');
  vi.useFakeTimers();
  try {
    const channel = createRunRealtimeChannel('s', 'waiting')!;
    channel.publish({ type: 'execution_status', runId: 'waiting', execution: { phase: 'waiting_model' } });
    closeRunRealtimeChannel(channel, true);
    const resumed = createRunRealtimeChannel('s', 'waiting')!;
    expect(resumed).toBe(channel);
    resumed.publish({ type: 'done', sessionId: 's', runId: 'waiting' });
    closeRunRealtimeChannel(resumed);
    expect(await collect(resumed.subscribe(1))).toMatchObject([{ sequence: 2, chunk: { type: 'done' } }]);
    vi.stubEnv('SYNAX_RUN_REALTIME_CHANNEL', '0');
    expect(getRunRealtimeChannel('s', 'waiting')).toBeUndefined();
    expect(createRunRealtimeChannel('s', 'disabled')).toBeUndefined();
    vi.unstubAllEnvs();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getRunRealtimeChannel('s', 'waiting')).toBeUndefined();
  } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
});
