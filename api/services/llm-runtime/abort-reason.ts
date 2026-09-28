/**
 * Abort semantics for LLM calls.
 *
 * `AbortController.abort()` without a reason makes Node reject with the runtime
 * default `DOMException: This operation was aborted`. That message says nothing
 * about who cancelled the call, so a timeout becomes indistinguishable from a
 * provider failure and the retry middleware has to treat it as terminal — the
 * raw runtime string then reaches the UI as an "LLM provider error".
 *
 * Every abort on the LLM path therefore carries one of the typed reasons below:
 * a timeout (retryable network-class) or a deliberate cancellation (terminal,
 * silent). Both keep the `name` that existing callers already check, so abort
 * detection elsewhere keeps working.
 */
export const LLM_ABORT_KIND = 'llmAbortKind'

export type LlmAbortKind = 'timeout' | 'cancel'

export interface LlmAbortReason extends Error {
  name: 'TimeoutError' | 'AbortError'
  [LLM_ABORT_KIND]: LlmAbortKind
}

/** Runtime default abort messages. They are never actionable, so never surface them. */
const BARE_ABORT_MESSAGES = [
  'this operation was aborted',
  'the operation was aborted',
  'operation was aborted',
  'signal is aborted without reason',
  'the user aborted a request',
]

const TIMEOUT_HINTS = ['timeout', 'timed out', '超时']

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  // A pending request deadline must never keep the process alive.
  const candidate = timer as unknown as { unref?: () => void }
  if (typeof candidate.unref === 'function') candidate.unref()
}

function taggedKind(error: unknown): LlmAbortKind | undefined {
  if (error == null || typeof error !== 'object') return undefined
  const kind = (error as Record<string, unknown>)[LLM_ABORT_KIND]
  return kind === 'timeout' || kind === 'cancel' ? kind : undefined
}

function errorCause(error: unknown): unknown {
  if (error == null || typeof error !== 'object') return undefined
  const cause = (error as { cause?: unknown }).cause
  return cause === error ? undefined : cause
}

function readName(error: unknown): string | undefined {
  if (error == null || typeof error !== 'object') return undefined
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' ? name : undefined
}

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error != null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return ''
}

function untaggedKind(error: unknown): LlmAbortKind | undefined {
  const name = readName(error)
  if (name === 'TimeoutError') return 'timeout'
  if (name !== 'AbortError') return undefined
  // `AbortSignal.timeout()` and undici timeouts abort with the runtime default
  // AbortError; their message still identifies the cause.
  const message = readMessage(error).toLowerCase()
  return TIMEOUT_HINTS.some((hint) => message.includes(hint))
    ? 'timeout'
    : 'cancel'
}

/**
 * Classifies an error as a timeout abort, a deliberate cancellation, or neither.
 * Untagged runtime aborts are inferred from the error and its cause so existing
 * (and third-party) abort sites keep a meaningful classification.
 */
export function abortKindOf(error: unknown): LlmAbortKind | undefined {
  const tagged = taggedKind(error)
  if (tagged) return tagged
  const direct = untaggedKind(error)
  if (direct) return direct
  return untaggedKind(errorCause(error))
}

export function isTimeoutAbort(error: unknown): boolean {
  return abortKindOf(error) === 'timeout'
}

export function isCancelAbort(error: unknown): boolean {
  return abortKindOf(error) === 'cancel'
}

/** Abort message for logging/UI mapping; `null` when the error is not an abort. */
export function describeAbort(error: unknown): { kind: LlmAbortKind; message: string } | null {
  const kind = abortKindOf(error)
  if (!kind) return null
  return { kind, message: readMessage(error) || BARE_ABORT_MESSAGES[0] }
}

/** True for the runtime default abort text, which must never reach a user. */
export function isBareAbortMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase().replace(/[.!。]+$/, '')
  return BARE_ABORT_MESSAGES.includes(normalized)
}

/** Timeout reason: network-class retryable, and never reported as a provider fault. */
export function timeoutAbortReason(message: string): LlmAbortReason {
  const error = new Error(message) as Error & NodeJS.ErrnoException
  error.name = 'TimeoutError'
  error.code = 'ETIMEDOUT'
  return tag(error, 'timeout')
}

/** Deliberate cancellation: terminal, and quiet (it is not a provider failure). */
export function cancelAbortReason(message: string): LlmAbortReason {
  const error = new Error(message)
  error.name = 'AbortError'
  return tag(error, 'cancel')
}

function tag<T extends Error>(error: T, kind: LlmAbortKind): T & LlmAbortReason {
  Object.defineProperty(error, LLM_ABORT_KIND, {
    value: kind,
    enumerable: false,
    configurable: true,
  })
  return error as T & LlmAbortReason
}

export interface TimeoutAbort {
  readonly signal: AbortSignal
  readonly message: string
  readonly timeoutMs: number
  /** True once the deadline fired; distinguishes a timeout from an external abort. */
  readonly timedOut: boolean
  dispose(): void
}

/**
 * Deadline-bound abort signal. On expiry the signal aborts with the typed
 * timeout reason instead of the runtime default, so the failure can be retried
 * and explained instead of surfacing as "This operation was aborted".
 */
export function createTimeoutAbort(timeoutMs: number, message: string): TimeoutAbort {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(timeoutAbortReason(message))
  }, timeoutMs)
  unrefTimer(timer)
  return {
    signal: controller.signal,
    message,
    timeoutMs,
    get timedOut() {
      return timedOut
    },
    dispose() {
      clearTimeout(timer)
    },
  }
}
