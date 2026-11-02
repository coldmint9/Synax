import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeWorkerPool } from "./worker-pool.js";

const clean = { wasmBytes: 16 * 1024 * 1024 };
class FakeWorker extends EventEmitter {
  threadId = 1;
  ref = vi.fn();
  unref = vi.fn();
  autoExit = true;
  private exited = Promise.withResolvers<number>();
  terminate = vi.fn(() => {
    if (this.autoExit) queueMicrotask(() => this.exit());
    return this.exited.promise;
  });
  exit() {
    if (this.threadId < 0) return;
    this.threadId = -1;
    this.emit("exit", 0);
    this.exited.resolve(0);
  }
}
const pools: CodeWorkerPool[] = [];
function fixture(options: ConstructorParameters<typeof CodeWorkerPool>[0] = {}) {
  const workers: FakeWorker[] = [];
  const pool = new CodeWorkerPool({ ...options, createWorker: options.createWorker ?? (() => {
    const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker;
  }) });
  pools.push(pool);
  return { pool, workers };
}
async function acquire(pool: CodeWorkerPool) {
  const result = await pool.acquire(1_000);
  if (result.status !== "acquired") throw new Error(result.error);
  return result.lease;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.close()));
  vi.useRealTimers();
});

describe("Code Mode worker pool", () => {
  it("reuses clean workers and never releases a new lease through an old one", async () => {
    const { pool, workers } = fixture({ maxWorkers: 1 });
    const first = await acquire(pool);
    await first.release(clean);
    expect(workers[0].unref).toHaveBeenCalled();
    const second = await acquire(pool);
    expect(second.worker).toBe(first.worker);
    expect(second.runId).not.toBe(first.runId);
    await first.release();
    expect(pool.snapshot()).toMatchObject({ workers: 1, leased: 1, reused: 1 });
    await second.release(clean);
    expect(workers[0].listenerCount("error")).toBe(1);
    expect(workers[0].listenerCount("exit")).toBe(1);
  });

  it("bounds waiters and hands reusable workers off in FIFO order", async () => {
    const { pool } = fixture({ maxWorkers: 1, maxWaiting: 2 });
    const first = await acquire(pool);
    const second = pool.acquire(1_000), third = pool.acquire(1_000);
    expect((await pool.acquire(1_000)).status).toBe("unavailable");
    await first.release(clean);
    const acquired = await second;
    expect(acquired.status).toBe("acquired");
    const fourth = pool.acquire(1_000);
    let fourthStarted = false;
    void fourth.then(() => { fourthStarted = true; });
    if (acquired.status === "acquired") await acquired.lease.release(clean);
    const next = await third;
    expect(next.status).toBe("acquired");
    expect(fourthStarted).toBe(false);
    if (next.status === "acquired") await next.lease.release(clean);
    const last = await fourth;
    if (last.status === "acquired") await last.lease.release(clean);
    expect(pool.snapshot().created).toBe(1);
  });

  it("removes cancelled and expired waiters without leaking capacity", async () => {
    vi.useFakeTimers();
    const { pool } = fixture({ maxWorkers: 1 });
    expect((await pool.acquire(1_000, AbortSignal.abort())).status).toBe("cancelled");
    const first = await acquire(pool);
    const controller = new AbortController();
    const cancelled = pool.acquire(1_000, controller.signal), expired = pool.acquire(25);
    controller.abort();
    expect((await cancelled).status).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(25);
    expect((await expired).status).toBe("timed_out");
    await first.release(clean);
    await (await acquire(pool)).release(clean);
    expect(pool.snapshot()).toMatchObject({ waiting: 0, idle: 1, created: 1 });
  });

  it("keeps retiring threads in the capacity bound until their actual exit", async () => {
    const { pool, workers } = fixture({ maxWorkers: 1 });
    const first = await acquire(pool);
    workers[0].autoExit = false;
    const released = first.release();
    const waiting = pool.acquire(1_000);
    expect(pool.snapshot()).toMatchObject({ workers: 1, retiring: 1, waiting: 1, created: 1 });
    workers[0].exit();
    await released;
    const next = await waiting;
    expect(next.status).toBe("acquired");
    expect(pool.snapshot().created).toBe(2);
    if (next.status === "acquired") await next.lease.release(clean);
  });

  it("retains at most one idle worker and expires it", async () => {
    vi.useFakeTimers();
    const { pool, workers } = fixture({ idleTimeoutMs: 20, maxIdle: 1 });
    const first = await acquire(pool), second = await acquire(pool);
    await first.release(clean);
    await second.release(clean);
    expect(pool.snapshot()).toMatchObject({ workers: 1, idle: 1 });
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(workers[1].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(pool.snapshot().workers).toBe(0);
    expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets the idle timer on reuse without retiring an active run", async () => {
    vi.useFakeTimers();
    const { pool } = fixture({ idleTimeoutMs: 20 });
    await (await acquire(pool)).release(clean);
    await vi.advanceTimersByTimeAsync(10);
    const lease = await acquire(pool);
    await vi.advanceTimersByTimeAsync(100);
    expect(pool.snapshot()).toMatchObject({ leased: 1, retiring: 0 });
    await lease.release(clean);
    await vi.advanceTimersByTimeAsync(20);
    expect(pool.snapshot().workers).toBe(0);
  });

  it("retires oversized heaps and workers at their reuse limit", async () => {
    const { pool } = fixture({ maxUses: 2 });
    await (await acquire(pool)).release(clean);
    await (await acquire(pool)).release(clean);
    expect(pool.snapshot().workers).toBe(0);
    await (await acquire(pool)).release({ wasmBytes: clean.wasmBytes + 65536 });
    expect(pool.snapshot()).toMatchObject({ workers: 0, created: 2 });
  });

  it("recovers from startup failures and idle worker crashes", async () => {
    const worker = new FakeWorker();
    const createWorker = vi.fn<() => Worker>().mockImplementationOnce(() => { throw new Error("launch failed"); })
      .mockImplementation(() => worker as unknown as Worker);
    const { pool } = fixture({ createWorker });
    expect((await pool.acquire(1_000)).status).toBe("unavailable");
    await (await acquire(pool)).release(clean);
    worker.emit("error", new Error("idle crash"));
    await pool.close();
    expect(pool.snapshot()).toMatchObject({ workers: 0, waiting: 0 });
  });

  it("closes active and queued work and rejects future admission", async () => {
    const { pool } = fixture({ maxWorkers: 1 });
    const lease = await acquire(pool);
    const waiting = pool.acquire(1_000);
    await pool.close();
    expect(lease.signal.aborted).toBe(true);
    expect((await waiting).status).toBe("cancelled");
    expect((await pool.acquire(1_000)).status).toBe("unavailable");
    expect(pool.snapshot()).toMatchObject({ workers: 0, waiting: 0 });
    await lease.release(clean);
  });
});
