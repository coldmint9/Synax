import { afterEach, describe, expect, it, vi } from "vitest";
import { coalesceLoopDeltas } from "../loop-delta-bursts.js";
import type { LoopModelStreamEvent } from "../contracts.js";
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const collect = async (source: AsyncIterable<LoopModelStreamEvent>) => {
  const out: LoopModelStreamEvent[] = [];
  for await (const event of source) out.push(event);
  return out;
};
describe("bounded native delta bursts", () => {
  it("does not wait for another upstream read or a timer for the first non-empty text", async () => {
    vi.useFakeTimers();
    let pulls = 0;
    const stream = coalesceLoopDeltas(async function* () {
      yield { type: "text_delta", delta: "" };
      pulls++;
      yield { type: "text_delta", delta: "first" };
      pulls++;
      yield { type: "text_delta", delta: "second" };
      yield { type: "text_delta", delta: "third" };
    });
    expect(await stream.next()).toMatchObject({ value: { delta: "first" } });
    expect(pulls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(await stream.next()).toMatchObject({ value: { delta: "secondthird" } });
    await stream.return();
  });
  it("coalesces adjacent deltas but preserves control/type boundaries and exact text", async () => {
    vi.useFakeTimers();
    const usage = {
      type: "usage",
      usage: { inputTokens: 1 },
    } as LoopModelStreamEvent;
    const events = await collect(
      coalesceLoopDeltas(async function* () {
        for (let n = 0; n < 100; n++)
          yield { type: "thought_delta", delta: "🙂" };
        yield usage;
        yield { type: "text_delta", delta: "a" };
        yield { type: "text_delta", delta: "b" };
        yield { type: "thought_delta", delta: "tail" };
      }),
    );
    expect(
      events
        .filter((e) => e.type === "thought_delta")
        .slice(0, -1)
        .map((e) => (e as { delta: string }).delta)
        .join(""),
    ).toBe("🙂".repeat(100));
    expect(events).toHaveLength(6);
    expect(events[2]).toBe(usage);
    expect(events[3]).toEqual({ type: "text_delta", delta: "a" });
    expect(events[4]).toEqual({ type: "text_delta", delta: "b" });
    expect(events[5]).toEqual({ type: "thought_delta", delta: "tail" });
  });
  it("flushes the first non-empty text delta immediately when enabled", async () => {
    vi.useFakeTimers();
    const events = await collect(coalesceLoopDeltas(async function* () {
      yield { type: "text_delta", delta: "first" };
      yield { type: "text_delta", delta: "second" };
    }));
    expect(events[0]).toEqual({ type: "text_delta", delta: "first" });
    expect(events[1]).toEqual({ type: "text_delta", delta: "second" });
  });
  it("splits large Unicode deltas into bounded output without cutting code points", async () => {
    const value = "漢🙂".repeat(5000);
    const events = await collect(
      coalesceLoopDeltas(async function* () {
        yield { type: "text_delta", delta: value };
      }),
    );
    expect(events.map((e) => (e as { delta: string }).delta).join("")).toBe(
      value,
    );
    for (const event of events) {
      const delta = (event as { delta: string }).delta;
      expect(delta.isWellFormed()).toBe(true);
      expect(Buffer.byteLength(delta)).toBeLessThanOrEqual(8192);
    }
  });
  it("keeps the previous merge deadline when first flush is disabled", async () => {
    vi.stubEnv("SYNAX_STREAM_FIRST_FLUSH", "0");
    vi.useFakeTimers();
    let release!: () => void;
    let pulls = 0;
    const stream = coalesceLoopDeltas(async function* () {
      pulls++;
      yield { type: "text_delta", delta: "first" };
      pulls++;
      await new Promise<void>((resolve) => (release = resolve));
      yield { type: "text_delta", delta: "last" };
    });
    const first = stream.next();
    await vi.advanceTimersByTimeAsync(40);
    expect(await first).toMatchObject({ value: { delta: "first" } });
    expect(pulls).toBe(2);
    release();
    const second = stream.next();
    await vi.advanceTimersByTimeAsync(40);
    expect(await second).toMatchObject({ value: { delta: "last" } });
    expect((await stream.next()).done).toBe(true);
  });
  it("delivers already received text before forwarding an upstream failure", async () => {
    const stream = coalesceLoopDeltas(async function* () {
      yield { type: "text_delta", delta: "partial" };
      throw new Error("upstream failed");
    });
    expect(await stream.next()).toMatchObject({ value: { delta: "partial" } });
    await expect(stream.next()).rejects.toThrow("upstream failed");
  });
  it("aborts a prefetched step and closes its generator when the consumer returns early", async () => {
    vi.useFakeTimers();
    let closed = false,
      aborted = false;
    const stream = coalesceLoopDeltas(async function* (signal) {
      try {
        yield { type: "thought_delta", delta: "ready" };
        await new Promise<void>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
      } finally {
        closed = true;
      }
    });
    const first = stream.next();
    await vi.advanceTimersByTimeAsync(40);
    expect(await first).toMatchObject({ value: { delta: "ready" } });
    await stream.return();
    expect(aborted).toBe(true);
    expect(closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects oversized input rather than allocating an unbounded accumulator", async () => {
    await expect(
      collect(
        coalesceLoopDeltas(async function* () {
          yield { type: "thought_delta", delta: "x".repeat(65537) };
        }),
      ),
    ).rejects.toThrow(/limit|budget/i);
  });
  it("caps aggregate pending reservations and releases them on early consumer return", async () => {
    const streams: ReturnType<typeof coalesceLoopDeltas>[] = [];
    try {
      for (let n = 0; n < 127; n++) {
        const stream = coalesceLoopDeltas(async function* () {
          yield { type: "text_delta", delta: "x".repeat(65536) };
        });
        streams.push(stream);
        expect((await stream.next()).done).toBe(false);
      }
      await expect(
        collect(
          coalesceLoopDeltas(async function* () {
            yield { type: "text_delta", delta: "x".repeat(65536) };
          }),
        ),
      ).rejects.toThrow(/budget/i);
    } finally {
      for (const stream of streams) await stream.return();
    }
    expect(
      await collect(
        coalesceLoopDeltas(async function* () {
          yield { type: "text_delta", delta: "recovered" };
        }),
      ),
    ).toEqual([{ type: "text_delta", delta: "recovered" }]);
  });
});
