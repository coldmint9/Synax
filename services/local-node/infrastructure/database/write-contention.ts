/**
 * SQLite write-lock contention policy for the runtime database.
 *
 * Every connection to `context.db` shares a single write lock. The API host
 * keeps its busy timeout short (see `HOST_BUSY_TIMEOUT_MS`) because a wait there
 * also blocks HTTP and IPC. The dedicated journal writer child owns no event
 * loop, so it may wait out a contended lock instead of turning a transient lock
 * into a failed Run that quarantines its session.
 *
 * `SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS` overrides the per-attempt wait. The total
 * wait is always clamped below the parent's acknowledgement deadline, so the
 * parent never discards a commit the child is still retrying.
 */
import { env } from "../runtime/env.js";

/** Parent-side deadline for one journal commit acknowledgement. */
export const JOURNAL_COMMIT_DEADLINE_MS = 30_000;

const DEFAULT_LOCK_WAIT_MS = 2_500;
const LOCK_ATTEMPTS = 3;
const LOCK_BACKOFF_MS = 250;
const DEFAULT_RUNTIME_LOCK_WAIT_MS = 2_500;
const RUNTIME_LOCK_ATTEMPTS = 3;
const RUNTIME_LOCK_BACKOFF_MS = 250;

/** Commits the parent admits while the child waits. The stream writer emits at
 * most one coalesced delta per `DELTA_FLUSH_MS`, so this limit must outlast a
 * full lock-wait budget at that ceiling; otherwise a patient child would be
 * replaced by a full admission queue — the same failed Run under a new name. */
export const MAX_PENDING_JOURNAL_COMMITS = 256;

export interface WriteLockPolicy {
  /** Longest single wait for the write lock before SQLITE_BUSY is reported. */
  waitMs: number;
  /** Attempts per commit, including the first. */
  attempts: number;
  /** Blocking pause between attempts. */
  backoffMs: number;
}

export function journalWriteLockPolicy(): WriteLockPolicy {
  const raw = env("SYNAX_JOURNAL_WRITE_LOCK_WAIT_MS").trim();
  const parsed = Number(raw);
  const requested =
    raw !== "" && Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : DEFAULT_LOCK_WAIT_MS;
  const reservable =
    JOURNAL_COMMIT_DEADLINE_MS - LOCK_BACKOFF_MS * (LOCK_ATTEMPTS - 1);
  return {
    waitMs: Math.min(requested, Math.floor(reservable / LOCK_ATTEMPTS)),
    attempts: LOCK_ATTEMPTS,
    backoffMs: LOCK_BACKOFF_MS,
  };
}

/**
 * Runtime control writes are short and idempotent at the transaction boundary,
 * but they can briefly overlap bounded history maintenance. Keep a separate
 * policy so ordinary execution writes can wait for that maintenance without
 * inheriting the journal writer's acknowledgement budget.
 */
export function runtimeWriteLockPolicy(): WriteLockPolicy {
  const raw = env("SYNAX_RUNTIME_WRITE_LOCK_WAIT_MS").trim();
  const parsed = Number(raw);
  const requested =
    raw !== "" && Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : DEFAULT_RUNTIME_LOCK_WAIT_MS;
  return {
    waitMs: Math.min(requested, 10_000),
    attempts: RUNTIME_LOCK_ATTEMPTS,
    backoffMs: RUNTIME_LOCK_BACKOFF_MS,
  };
}

/** Worst-case time one commit may spend waiting for the write lock. */
export function journalWriteLockBudgetMs(
  policy: WriteLockPolicy = journalWriteLockPolicy(),
): number {
  return (
    policy.waitMs * policy.attempts +
    policy.backoffMs * Math.max(0, policy.attempts - 1)
  );
}

const CONTENTION_CODES = ["SQLITE_BUSY", "SQLITE_LOCKED"];
const CONTENTION_MESSAGES = [
  "database is locked",
  "database table is locked",
  "database schema is locked",
  "database is busy",
];

/** libsql's native binding reports the primary result code, but the journal child
 * only forwards message text across IPC, so both are classified. */
export function isWriteContentionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (
    typeof code === "string" &&
    CONTENTION_CODES.some((candidate) =>
      code.toUpperCase().startsWith(candidate),
    )
  )
    return true;
  const message = (error as { message?: unknown }).message;
  const text = typeof message === "string" ? message.toLowerCase() : "";
  return CONTENTION_MESSAGES.some((candidate) => text.includes(candidate));
}

/** Blocking pause. Only a process that serves no event loop may call this: the
 * runtime host must keep answering HTTP and IPC while a lock is contended. */
export function sleepSync(ms: number): void {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Replays a failed *lock acquisition* only. `didWrite` must report whether an
 * attempt executed any statement: a commit that fails after writing cannot be
 * replayed, because it may already be durable.
 */
export function retryWriteLockAcquisition<Result>(
  policy: WriteLockPolicy,
  attempt: () => Result,
  didWrite: () => boolean,
): Result {
  const attempts = Math.max(1, policy.attempts);
  for (let index = 1; ; index++) {
    try {
      return attempt();
    } catch (error) {
      if (index >= attempts || didWrite() || !isWriteContentionError(error))
        throw error;
      sleepSync(policy.backoffMs);
    }
  }
}
