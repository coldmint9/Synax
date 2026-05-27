import { logger } from '../../../lib/logger.js'

export interface RetryConfig {
  maxRetries: number
  baseDelayMs: number
  shouldRetry: (error: unknown) => boolean
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  shouldRetry: isRateLimitError,
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
): Promise<T> {
  const { maxRetries, baseDelayMs, shouldRetry } = { ...DEFAULT_CONFIG, ...config }
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < maxRetries && shouldRetry(err)) {
        const delay = baseDelayMs * 2 ** attempt + Math.random() * 500
        logger.warn({ attempt, delay }, '[llm-runtime] rate limited, retrying')
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw lastError
}

export function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests') ||
    msg.includes('concurrency limit') ||
    msg.includes('429')
}
