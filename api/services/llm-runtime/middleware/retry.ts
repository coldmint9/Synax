import { setTimeout as delay } from "node:timers/promises";
import { logger } from "../../../lib/logger.js";

import type { LlmRetryState } from "../retry-state.js";
export type { LlmRetryState } from "../retry-state.js";

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (error: unknown) => boolean;
  signal?: AbortSignal;
  repeatNetworkGroups: boolean;
  networkGroupDelayMs: number;
  onRetry?: (state: LlmRetryState) => void;
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 2000,
  maxDelayMs: 32_500,
  shouldRetry: isRetryableLlmError,
  repeatNetworkGroups: false,
  networkGroupDelayMs: 120_000,
};

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524])

const NON_RETRYABLE_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 409, 422])

const NETWORK_ERROR_CODES = new Set([
  'EPIPE',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
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
  let result!: T;
  for await (const event of withRetryStream(async function* () {
    yield await fn();
  }, config)) {
    if (event.type === "value") result = event.value;
    else config.onRetry?.(event.retry);
  }
  return result;
}

/** Retry the entire consumption, not just creation of a lazy SDK stream. */
export async function* withRetryStream<T>(
  fn: () => AsyncIterable<T>,
  config: Partial<RetryConfig> = {},
): AsyncGenerator<
  { type: "value"; value: T } | { type: "retry_status"; retry: LlmRetryState }
> {
  const options = { ...DEFAULT_CONFIG, ...config };
  const { maxRetries, baseDelayMs, maxDelayMs, signal } = options;
  let attempt = 0;
  let group = 1;
  let upstreamRetries = 0;
  let state: LlmRetryState | undefined;
  while (true) {
    signal?.throwIfAborted();
    if (state)
      yield {
        type: "retry_status",
        retry: { ...state, phase: "retrying", nextRetryAt: null },
      };
    try {
      for await (const value of fn()) {
        signal?.throwIfAborted();
        yield { type: "value", value };
      }
      signal?.throwIfAborted();
      if (state)
        yield {
          type: "retry_status",
          retry: { ...state, phase: "recovered", nextRetryAt: null },
        };
      return;
    } catch (error) {
      signal?.throwIfAborted();
      if (isAbortError(error) || !options.shouldRetry(error)) throw error;
      const reason = isNetworkError(error)
        ? "network"
        : isRateLimitError(error)
          ? "rate_limit"
          : "upstream";
      // Once an HTTP response arrives the network is reachable; upstream failures
      // have a separate finite budget and must never inherit infinite network retries.
      if (reason !== state?.reason)
        attempt = reason === "network" ? 0 : upstreamRetries;
      if (reason !== "network") attempt = upstreamRetries;
      state = {
        reason,
        phase: "waiting",
        group: reason === "network" ? group : 1,
        attempt,
        maxRetries,
        nextRetryAt: null,
        error: errorMessage(error).slice(0, 1000),
      };
      if (attempt >= maxRetries) {
        if (
          reason !== "network" ||
          !options.repeatNetworkGroups ||
          maxRetries === 0
        ) {
          yield {
            type: "retry_status",
            retry: { ...state, phase: "exhausted" },
          };
          if (maxRetries === 0) throw error;
          throw new Error(
            `${state.error} (retried ${maxRetries} times; 已重试 ${maxRetries} 次)`,
            { cause: error },
          );
        }
        group++;
        attempt = 0;
        state = {
          ...state,
          phase: "group_wait",
          group,
          attempt,
          nextRetryAt: Date.now() + options.networkGroupDelayMs,
        };
        yield { type: "retry_status", retry: state };
        await delay(Math.max(0, state.nextRetryAt! - Date.now()), undefined, {
          signal,
        });
      }
      const waitMs = computeRetryDelayMs(attempt, baseDelayMs, maxDelayMs);
      attempt++;
      if (reason !== "network") upstreamRetries++;
      state = {
        ...state,
        phase: "waiting",
        attempt,
        nextRetryAt: Date.now() + waitMs,
      };
      logger.warn(
        { attempt, maxRetries, group: state.group, delay: waitMs, reason },
        "[llm-runtime] transient LLM error, retrying with exponential backoff",
      );
      yield { type: "retry_status", retry: state };
      await delay(Math.max(0, state.nextRetryAt! - Date.now()), undefined, {
        signal,
      });
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    (error as { name?: string }).name === "AbortError"
  );
}

/** Transport failures only. HTTP 5xx/429 are upstream errors, not an offline network. */
export function isNetworkError(error: unknown): boolean {
  if (
    isAbortError(error) ||
    isExplicitlyNonRetryable(error) ||
    (errorStatusCode(error) ?? 0) >= 400
  )
    return false;
  if (hasNetworkErrorCode(error)) return true;
  if (
    CONNECTION_MESSAGE_PATTERNS.some((pattern) =>
      errorMessage(error).toLowerCase().includes(pattern),
    )
  )
    return true;
  const cause = readErrorCause(error);
  return Boolean(cause && cause !== error && isNetworkError(cause));
}

export function isRetryableLlmError(err: unknown): boolean {
  if (isAbortError(err) || isExplicitlyNonRetryable(err)) return false
  if (errorMessage(err).toLowerCase().includes('overload')) return true
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
  if (['overload', 'temporarily unavailable', 'service unavailable', 'bad gateway', 'gateway timeout'].some(pattern => msg.includes(pattern))) return true

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
    msg.includes('invalid_request_error') ||
    msg.includes('invalid request error')
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
