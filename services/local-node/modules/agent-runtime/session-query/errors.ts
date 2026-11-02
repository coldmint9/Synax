export type SessionQueryErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'RUNTIME_UNAVAILABLE';

/**
 * A read-model failure the model can act on. Anything else stays an internal
 * error: a bug must not be reported as "session missing" or "runtime offline".
 */
export class SessionQueryError extends Error {
  constructor(
    readonly code: SessionQueryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionQueryError';
  }
}
