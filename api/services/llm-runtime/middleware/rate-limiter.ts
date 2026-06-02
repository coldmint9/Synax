import { logger } from '../../../lib/logger.js'

const DEFAULT_CAPACITY_TPM = 80_000
const REFILL_INTERVAL_MS = 60_000

interface Waiter {
  tokens: number
  resolve: () => void
}

export class TokenBucket {
  private tokensRemaining: number
  private capacity: number
  private resetAt: number
  private waiters: Waiter[] = []
  private calibrated = false

  constructor(capacity = DEFAULT_CAPACITY_TPM) {
    this.capacity = capacity
    this.tokensRemaining = capacity
    this.resetAt = Date.now() + REFILL_INTERVAL_MS
  }

  async acquire(estimatedTokens: number): Promise<void> {
    this.maybeRefill()

    if (this.tokensRemaining >= estimatedTokens && this.waiters.length === 0) {
      this.tokensRemaining -= estimatedTokens
      return
    }

    return new Promise<void>((resolve) => {
      this.waiters.push({ tokens: estimatedTokens, resolve })
      this.scheduleFlush()
    })
  }

  release(actualTokens: number, estimatedTokens: number): void {
    const diff = estimatedTokens - actualTokens
    if (diff > 0) {
      this.tokensRemaining = Math.min(this.capacity, this.tokensRemaining + diff)
      this.flushWaiters()
    }
  }

  get hasWaiters(): boolean {
    return this.waiters.length > 0
  }

  syncFromProvider(remaining: number, resetAt: number, capacity?: number): void {
    this.tokensRemaining = remaining
    this.resetAt = resetAt
    if (capacity != null) {
      this.capacity = capacity
    }
    this.calibrated = true
    this.flushWaiters()
  }

  private maybeRefill(): void {
    const now = Date.now()
    if (now >= this.resetAt) {
      this.tokensRemaining = this.capacity
      this.resetAt = now + REFILL_INTERVAL_MS
      this.flushWaiters()
    }
  }

  private flushWaiters(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters[0]
      if (this.tokensRemaining >= next.tokens) {
        this.waiters.shift()
        this.tokensRemaining -= next.tokens
        next.resolve()
      } else {
        break
      }
    }
  }

  private flushTimer: ReturnType<typeof setTimeout> | null = null

  private scheduleFlush(): void {
    if (this.flushTimer) return
    const delay = Math.max(0, this.resetAt - Date.now())
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.maybeRefill()
    }, delay)
  }
}

// --- Bucket Registry (module-level singleton) ---

const buckets = new Map<string, TokenBucket>()

function bucketKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`
}

export function getOrCreateBucket(providerId: string, modelId: string): TokenBucket {
  const key = bucketKey(providerId, modelId)
  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = new TokenBucket()
    buckets.set(key, bucket)
  }
  return bucket
}

/**
 * Returns true if ANY bucket has waiters queued.
 * This is the L2 backpressure signal — callers can use it to
 * throttle new work submission when the provider is saturated.
 */
export function isSaturated(providerId?: string, modelId?: string): boolean {
  if (providerId && modelId) {
    const bucket = buckets.get(bucketKey(providerId, modelId))
    return bucket?.hasWaiters ?? false
  }
  for (const bucket of buckets.values()) {
    if (bucket.hasWaiters) return true
  }
  return false
}

// --- Sync from provider response headers ---

export function syncFromResponseHeaders(
  providerId: string,
  modelId: string,
  headers: Record<string, string | string[] | undefined>,
): void {
  const bucket = getOrCreateBucket(providerId, modelId)
  const h = normalizeHeaders(headers)

  // Anthropic format
  let remaining = parseNum(h['anthropic-ratelimit-tokens-remaining'])
  let resetRaw = h['anthropic-ratelimit-tokens-reset']
  let limit = parseNum(h['anthropic-ratelimit-tokens-limit'])

  // OpenAI format fallback
  if (remaining == null) {
    remaining = parseNum(h['x-ratelimit-remaining-tokens'])
    resetRaw = h['x-ratelimit-reset-tokens']
    limit = parseNum(h['x-ratelimit-limit-tokens'])
  }

  if (remaining == null) return

  const resetAt = parseResetTime(resetRaw)
  bucket.syncFromProvider(remaining, resetAt, limit ?? undefined)
  logger.debug({ providerId, modelId, remaining, resetAt }, '[rate-limiter] synced from headers')
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
  }
  return out
}

function parseNum(val: string | undefined): number | null {
  if (!val) return null
  const n = Number(val)
  return Number.isFinite(n) ? n : null
}

function parseResetTime(val: string | undefined): number {
  if (!val) return Date.now() + REFILL_INTERVAL_MS
  // ISO 8601 timestamp
  const ts = Date.parse(val)
  if (Number.isFinite(ts)) return ts
  // Duration format like "6s" or "1m30s"
  const match = val.match(/(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/)
  if (match) {
    const mins = Number(match[1] || 0)
    const secs = Number(match[2] || 0)
    return Date.now() + (mins * 60 + secs) * 1000
  }
  return Date.now() + REFILL_INTERVAL_MS
}

// --- withRateLimit wrapper ---

const INPUT_TOKEN_ESTIMATE_RATIO = 0.5

/**
 * Wraps an LLM call with token bucket rate limiting.
 * Acquires estimated tokens before calling fn, then reconciles after.
 * This should be the INNER wrapper (inside withRetry).
 */
export async function withRateLimit<T>(
  providerId: string,
  modelId: string,
  maxTokens: number,
  fn: () => Promise<T>,
): Promise<T> {
  const bucket = getOrCreateBucket(providerId, modelId)
  const estimatedInput = Math.ceil(maxTokens * INPUT_TOKEN_ESTIMATE_RATIO)
  const estimatedTotal = estimatedInput + maxTokens

  await bucket.acquire(estimatedTotal)

  try {
    const result = await fn()
    // Best-effort reconciliation: if the result carries usage info, release the diff
    const usage = extractUsage(result)
    if (usage != null) {
      bucket.release(usage, estimatedTotal)
    }
    return result
  } catch (err) {
    // On failure, release the full estimate back (no tokens were consumed)
    bucket.release(0, estimatedTotal)
    throw err
  }
}

function extractUsage(result: unknown): number | null {
  if (result == null || typeof result !== 'object') return null
  // Vercel AI SDK results have usage.totalTokens
  const r = result as Record<string, unknown>
  if (r.usage && typeof r.usage === 'object') {
    const usage = r.usage as Record<string, unknown>
    if (typeof usage.totalTokens === 'number') return usage.totalTokens
  }
  return null
}

/**
 * Stream-aware rate limit wrapper.
 * Acquires tokens before the call (backpressure), then schedules release
 * on the stream's usage promise instead of trying to extract usage synchronously.
 * Vercel AI SDK's streamText() returns an object with a `usage` Promise that
 * resolves only after the stream is fully consumed.
 */
export async function withStreamRateLimit<T>(
  providerId: string,
  modelId: string,
  maxTokens: number,
  fn: () => Promise<T>,
): Promise<T> {
  const bucket = getOrCreateBucket(providerId, modelId)
  const estimatedInput = Math.ceil(maxTokens * INPUT_TOKEN_ESTIMATE_RATIO)
  const estimatedTotal = estimatedInput + maxTokens

  await bucket.acquire(estimatedTotal)

  try {
    const result = await fn()
    // Vercel AI SDK stream results expose a `usage` Promise<{totalTokens}>
    const r = result as Record<string, unknown>
    if (r && typeof r === 'object' && 'usage' in r) {
      const usagePromise = r.usage
      if (usagePromise && typeof (usagePromise as Promise<unknown>).then === 'function') {
        (usagePromise as Promise<Record<string, unknown>>)
          .then((u) => {
            const total = typeof u?.totalTokens === 'number' ? u.totalTokens : 0
            bucket.release(total, estimatedTotal)
          })
          .catch(() => {
            bucket.release(0, estimatedTotal)
          })
        return result
      }
    }
    // Fallback: no usage promise found, release full estimate to avoid deadlock
    bucket.release(0, estimatedTotal)
    return result
  } catch (err) {
    bucket.release(0, estimatedTotal)
    throw err
  }
}
