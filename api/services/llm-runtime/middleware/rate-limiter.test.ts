import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../../lib/logger.js'
import {
  RateLimitCapacityError,
  TokenBucket,
  getOrCreateBucket,
  isSaturated,
  withRateLimit,
} from './rate-limiter.js'

// The local limiter is disabled by default (AGENT_LLM_RATE_LIMITER); the legacy
// wrapper/bucket-registry tests below opt in explicitly.
beforeEach(() => {
  process.env.AGENT_LLM_RATE_LIMITER = 'on'
})

afterEach(() => {
  delete process.env.AGENT_LLM_RATE_LIMITER
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('TokenBucket oversized requests', () => {
  it('rejects deterministically without queueing or growing capacity', async () => {
    vi.useFakeTimers()
    const bucket = new TokenBucket(1000)

    const err = await bucket.acquire(1500).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitCapacityError)
    expect(err).toMatchObject({
      name: 'RateLimitCapacityError',
      estimatedTokens: 1500,
      capacity: 1000,
      isRetryable: false,
    })

    // Rejected request must not sit in the queue or leave a pending timer.
    expect(bucket.hasWaiters).toBe(false)
    expect(vi.getTimerCount()).toBe(0)

    // Capacity is untouched: an in-capacity request still succeeds.
    await expect(bucket.acquire(1000)).resolves.toBeUndefined()
  })

  it('rejects a queued waiter when calibration shrinks capacity below it', async () => {
    vi.useFakeTimers()
    const bucket = new TokenBucket(1000)
    await bucket.acquire(1000) // drain

    const waiter = bucket.acquire(800)
    expect(bucket.hasWaiters).toBe(true)

    // Provider reports a smaller limit than the queued estimate.
    bucket.syncFromProvider(0, Date.now() + 60_000, 500)

    await expect(waiter).rejects.toBeInstanceOf(RateLimitCapacityError)
    expect(bucket.hasWaiters).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('TokenBucket cancellation', () => {
  it('rejects an already-aborted signal immediately', async () => {
    const bucket = new TokenBucket(1000)
    const ac = new AbortController()
    ac.abort()
    await expect(bucket.acquire(10, ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('removes an aborted waiter from the queue and cleans up its timer', async () => {
    vi.useFakeTimers()
    const bucket = new TokenBucket(1000)
    await bucket.acquire(1000) // drain

    const ac = new AbortController()
    const queued = bucket.acquire(500, ac.signal)
    expect(bucket.hasWaiters).toBe(true)
    expect(vi.getTimerCount()).toBe(1)

    ac.abort()
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(bucket.hasWaiters).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not dispatch when the signal aborts after acquire is granted', async () => {
    const bucket = getOrCreateBucket('grant-then-abort', 'model')
    bucket.syncFromProvider(0, Date.now() + 60_000, 80_000)
    const fn = vi.fn(async () => 'ok')
    const ac = new AbortController()

    const pending = withRateLimit('grant-then-abort', 'model', 1000, fn, ac.signal)
    expect(bucket.hasWaiters).toBe(true)

    // Grant exactly the estimate so acquire resolves, then abort before the
    // awaiting continuation (and therefore fn) can run.
    bucket.release(0, 1500)
    expect(bucket.hasWaiters).toBe(false)
    ac.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('unblocks a follower when the aborted waiter was at the head', async () => {
    vi.useFakeTimers()
    const bucket = new TokenBucket(1000)
    await bucket.acquire(1000) // drain

    const ac = new AbortController()
    const head = bucket.acquire(700, ac.signal)
    const follower = bucket.acquire(300)

    let followerDone = false
    void follower.then(() => {
      followerDone = true
    })

    ac.abort()
    await expect(head).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(followerDone).toBe(false)

    // Provider reports exactly enough headroom for the follower.
    bucket.syncFromProvider(300, Date.now() + 60_000, 1000)
    await expect(follower).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('TokenBucket refill lifecycle', () => {
  it('keeps waking up across multiple refill cycles until the queue drains', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const bucket = new TokenBucket(1000)
    await bucket.acquire(1000) // drain

    let firstDone = false
    let secondDone = false
    const first = bucket.acquire(600)
    const second = bucket.acquire(600)
    void first.then(() => {
      firstDone = true
    })
    void second.then(() => {
      secondDone = true
    })

    await vi.advanceTimersByTimeAsync(59_999)
    expect(firstDone).toBe(false)
    expect(secondDone).toBe(false)

    await vi.advanceTimersByTimeAsync(1) // first refill satisfies only the head
    expect(firstDone).toBe(true)
    expect(secondDone).toBe(false)
    expect(bucket.hasWaiters).toBe(true)

    await vi.advanceTimersByTimeAsync(60_000) // second refill satisfies the rest
    expect(secondDone).toBe(true)
    expect(bucket.hasWaiters).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the flush timer once the queue drains via release', async () => {
    vi.useFakeTimers()
    const bucket = new TokenBucket(1000)
    await bucket.acquire(1000)

    const waiter = bucket.acquire(400)
    expect(vi.getTimerCount()).toBe(1)

    bucket.release(0, 400) // refund partial estimate -> enough for the waiter
    await expect(waiter).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unrefs the flush timer so a pending refill cannot hold the process open', async () => {
    const unref = vi.fn()
    const fakeTimer = { unref } as unknown as ReturnType<typeof setTimeout>
    const stub = vi.fn(() => fakeTimer)
    vi.stubGlobal('setTimeout', stub)

    try {
      const bucket = new TokenBucket(1000)
      await bucket.acquire(1000)
      const waiter = bucket.acquire(100)

      expect(stub).toHaveBeenCalled()
      expect(unref).toHaveBeenCalledTimes(1)

      bucket.release(0, 100)
      await expect(waiter).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('wait observability', () => {
  it('emits one structured log per wait transition', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => logger)
    try {
      const bucket = new TokenBucket(1000)
      await bucket.acquire(1000) // drain

      const ac = new AbortController()
      const cancelled = bucket.acquire(600, ac.signal)
      const granted = bucket.acquire(400)
      cancelled.catch(() => undefined)

      ac.abort()
      await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
      bucket.syncFromProvider(400, Date.now() + 60_000, 1000)
      await expect(granted).resolves.toBeUndefined()

      const eventNames = debug.mock.calls
        .map((ce) => (ce[0] as Record<string, unknown>)?.event)
        .filter((e): e is string => typeof e === 'string')
      expect(eventNames).toEqual(['queued', 'queued', 'cancelled', 'granted'])
      for (const [payload] of debug.mock.calls) {
        const p = payload as Record<string, unknown>
        if (typeof p?.event === 'string') {
          expect(typeof p.tokens).toBe('number')
          expect(typeof p.queueDepth).toBe('number')
          expect(typeof p.elapsedMs).toBe('number')
        }
      }
    } finally {
      debug.mockRestore()
    }
  })
})

describe('reconciliation', () => {
  it('refunds the estimate/actual difference and flushes waiters', async () => {
    const bucket = new TokenBucket(1000)
    await bucket.acquire(1000)
    const waiter = bucket.acquire(300)
    bucket.release(200, 500) // diff 300 refunded
    await expect(waiter).resolves.toBeUndefined()
  })
})

describe('withRateLimit', () => {
  it('rejects an already-aborted signal without dispatching fn', async () => {
    const bucket = getOrCreateBucket('abort-pre', 'model')
    bucket.syncFromProvider(80_000, Date.now() + 60_000, 80_000)
    const fn = vi.fn(async () => 'ok')
    const ac = new AbortController()
    ac.abort()

    await expect(
      withRateLimit('abort-pre', 'model', 1000, fn, ac.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('cancels a queued call on abort and never dispatches fn', async () => {
    vi.useFakeTimers()
    const bucket = getOrCreateBucket('abort-queued', 'model')
    bucket.syncFromProvider(0, Date.now() + 60_000, 80_000)
    const fn = vi.fn(async () => 'ok')
    const ac = new AbortController()

    const pending = withRateLimit('abort-queued', 'model', 1000, fn, ac.signal)
    expect(bucket.hasWaiters).toBe(true)

    ac.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fn).not.toHaveBeenCalled()
    expect(bucket.hasWaiters).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects oversized requests deterministically without dispatching fn', async () => {
    const bucket = getOrCreateBucket('oversize', 'model')
    bucket.syncFromProvider(80_000, Date.now() + 60_000, 80_000)
    const fn = vi.fn(async () => 'ok')

    // maxTokens 100_000 -> estimate 150_000 > capacity 80_000
    await expect(
      withRateLimit('oversize', 'model', 100_000, fn),
    ).rejects.toBeInstanceOf(RateLimitCapacityError)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('local limiter disabled by default', () => {
  beforeEach(() => {
    delete process.env.AGENT_LLM_RATE_LIMITER
  })

  it('passes through without queueing even when the bucket is drained', async () => {
    getOrCreateBucket('disabled-passthrough', 'model').syncFromProvider(
      0,
      Date.now() + 60_000,
    )
    const fn = vi.fn(async () => 'sent')
    await expect(
      withRateLimit('disabled-passthrough', 'model', 1000, fn),
    ).resolves.toBe('sent')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('still honours abort signals in pass-through mode', async () => {
    const ac = new AbortController()
    ac.abort()
    const fn = vi.fn(async () => 'sent')
    await expect(
      withRateLimit('disabled-abort', 'model', 1000, fn, ac.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('reports no saturation even while an internal queue exists', () => {
    const bucket = getOrCreateBucket('disabled-saturated', 'model')
    bucket.syncFromProvider(0, Date.now() + 60_000)
    void bucket.acquire(5000).catch(() => undefined)
    expect(bucket.hasWaiters).toBe(true)
    expect(isSaturated('disabled-saturated', 'model')).toBe(false)
    expect(isSaturated()).toBe(false)
  })
})
