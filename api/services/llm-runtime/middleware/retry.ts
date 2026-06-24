import { logger } from '../../../lib/logger.js'

export interface RetryConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  shouldRetry: (error: unknown) => boolean
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  shouldRetry: isRetryableLlmError,
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524])

const NON_RETRYABLE_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 409, 422])

const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])

const CONNECTION_MESSAGE_PATTERNS = [
  'fetch failed',
  'network error',
  'network request failed',
  'socket hang up',
  'connection reset',
  'connection refused',
  'connection error',
  'connection timeout',
  'connect timeout',
  'timed out',
  'timeout',
  'temporarily unavailable',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'failed to fetch',
  'unable to connect',
  'dns',
  'getaddrinfo',
  'econnrefused',
  'econnreset',
  'etimedout',
  'enotfound',
  'eai_again',
]

export function computeRetryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** attempt
  const jitter = Math.random() * 500
  return Math.min(exponential + jitter, maxDelayMs)
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs, shouldRetry } = { ...DEFAULT_CONFIG, ...config }
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < maxRetries && shouldRetry(err)) {
        const delay = computeRetryDelayMs(attempt, baseDelayMs, maxDelayMs)
        logger.warn(
          { attempt: attempt + 1, maxRetries, delay, reason: retryReason(err) },
          '[llm-runtime] transient LLM error, retrying with exponential backoff',
        )
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw lastError
}

export function isRetryableLlmError(err: unknown): boolean {
  if (isExplicitlyNonRetryable(err)) return false
  if (isRateLimitError(err)) return true
  if (isConnectionError(err)) return true
  return false
}

export function isRateLimitError(err: unknown): boolean {
  const status = errorStatusCode(err)
  if (status === 429) return true
  const msg = errorMessage(err).toLowerCase()
  return msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests') ||
    msg.includes('concurrency limit')
}

export function isConnectionError(err: unknown): boolean {
  if (isExplicitlyNonRetryable(err)) return false

  const explicit = readExplicitRetryable(err)
  if (explicit === true) return true
  if (explicit === false) return false

  const status = errorStatusCode(err)
  if (status != null) {
    if (NON_RETRYABLE_HTTP_STATUSES.has(status)) return false
    if (RETRYABLE_HTTP_STATUSES.has(status)) return true
  }

  if (hasNetworkErrorCode(err)) return true

  const msg = errorMessage(err).toLowerCase()
  if (CONNECTION_MESSAGE_PATTERNS.some(pattern => msg.includes(pattern))) return true

  const cause = readErrorCause(err)
  if (cause && cause !== err && isConnectionError(cause)) return true

  return false
}

function isExplicitlyNonRetryable(err: unknown): boolean {
  const status = errorStatusCode(err)
  if (status != null && NON_RETRYABLE_HTTP_STATUSES.has(status)) return true

  const msg = errorMessage(err).toLowerCase()
  return msg.includes('invalid api key') ||
    msg.includes('incorrect api key') ||
    msg.includes('authentication') ||
    msg.includes('unauthorized') ||
    msg.includes('permission denied') ||
    msg.includes('content filter') ||
    msg.includes('content_policy') ||
    msg.includes('invalid_request_error')
}

function readExplicitRetryable(err: unknown): boolean | undefined {
  if (err == null || typeof err !== 'object') return undefined
  const value = (err as Record<string, unknown>).isRetryable
  return typeof value === 'boolean' ? value : undefined
}

function hasNetworkErrorCode(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const code = (err as NodeJS.ErrnoException).code
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code)
}

function errorStatusCode(err: unknown): number | undefined {
  if (err == null || typeof err !== 'object') return undefined
  const obj = err as Record<string, unknown>
  if (typeof obj.statusCode === 'number') return obj.statusCode
  if (typeof obj.status === 'number') return obj.status
  const response = obj.response
  if (response != null && typeof response === 'object') {
    const status = (response as Record<string, unknown>).status
    if (typeof status === 'number') return status
  }
  return undefined
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err != null && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
    return (err as Record<string, unknown>).message as string
  }
  return String(err)
}

function readErrorCause(err: unknown): unknown {
  if (err == null || typeof err !== 'object') return undefined
  return (err as Record<string, unknown>).cause
}

function retryReason(err: unknown): string {
  if (isRateLimitError(err)) return 'rate_limit'
  if (hasNetworkErrorCode(err)) return 'network_code'
  const status = errorStatusCode(err)
  if (status != null) return `http_${status}`
  return 'connection'
}
