import { describe, expect, it, vi } from 'vitest'
import {
  computeRetryDelayMs,
  isConnectionError,
  isRateLimitError,
  isRetryableLlmError,
  withRetry,
} from '../middleware/retry.js'

describe('isConnectionError', () => {
  it('detects node network error codes', () => {
    expect(isConnectionError(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }))).toBe(true)
    expect(isConnectionError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))).toBe(true)
  })

  it('detects retryable HTTP status codes', () => {
    expect(isConnectionError(Object.assign(new Error('upstream'), { statusCode: 503 }))).toBe(true)
    expect(isConnectionError(Object.assign(new Error('gateway'), { statusCode: 502 }))).toBe(true)
  })

  it('detects fetch-style connection messages', () => {
    expect(isConnectionError(new TypeError('fetch failed'))).toBe(true)
    expect(isConnectionError(new Error('Connection timeout while calling LLM'))).toBe(true)
  })

  it('walks nested error causes', () => {
    const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    expect(isConnectionError(new Error('request failed', { cause }))).toBe(true)
  })

  it('does not retry auth or validation failures', () => {
    expect(isConnectionError(Object.assign(new Error('Invalid API key'), { statusCode: 401 }))).toBe(false)
    expect(isConnectionError(new Error('Invalid request error'))).toBe(false)
  })

  it('respects explicit isRetryable=false', () => {
    expect(isConnectionError(Object.assign(new Error('failed'), { isRetryable: false, statusCode: 503 }))).toBe(false)
  })
})

describe('isRetryableLlmError', () => {
  it('includes rate limits and connection failures', () => {
    expect(isRetryableLlmError(new Error('rate limit exceeded'))).toBe(true)
    expect(isRetryableLlmError(new TypeError('fetch failed'))).toBe(true)
    expect(isRetryableLlmError(Object.assign(new Error('bad request'), { statusCode: 400 }))).toBe(false)
  })
})

describe('isRateLimitError', () => {
  it('detects 429 and common rate limit messages', () => {
    expect(isRateLimitError(Object.assign(new Error('limited'), { statusCode: 429 }))).toBe(true)
    expect(isRateLimitError(new Error('Too many requests'))).toBe(true)
  })
})

describe('computeRetryDelayMs', () => {
  it('grows exponentially and caps at max delay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(computeRetryDelayMs(0, 1000, 30_000)).toBe(1000)
    expect(computeRetryDelayMs(1, 1000, 30_000)).toBe(2000)
    expect(computeRetryDelayMs(10, 1000, 30_000)).toBe(30_000)
    vi.mocked(Math.random).mockRestore()
  })
})

describe('withRetry', () => {
  it('retries connection failures with exponential backoff', async () => {
    vi.useFakeTimers()
    const fn = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(Object.assign(new Error('503'), { statusCode: 503 }))
      .mockResolvedValue('ok')

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000 })
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('Invalid API key'), { statusCode: 401 }))
    await expect(withRetry(fn)).rejects.toThrow('Invalid API key')
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
