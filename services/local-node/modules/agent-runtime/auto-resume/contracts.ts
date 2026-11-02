import type { AgentSession } from "../contracts.js";

/**
 * Why a session entered the auto-resume queue.
 *
 * `restart` is leftover work from a previous runtime host (a quit, a crash or a
 * killed worker); `network` is a turn that stopped because the model endpoint
 * could not be reached; `manual` is a user asking for the same continuation.
 */
export type AutoResumeCause = "restart" | "network" | "manual";

/**
 * Where a queued session currently is.
 *
 * `queued` is due now, `retrying` waits for a backoff deadline, and
 * `waiting_network` holds the work without spending attempts until the model
 * endpoint is reachable again.
 */
export type AutoResumePhase = "queued" | "retrying" | "waiting_network";

export interface AutoResumeRecord {
  sessionId: string;
  projectId: string;
  cause: AutoResumeCause;
  phase: AutoResumePhase;
  /** Attempts that ended in a failure the session itself caused. */
  attempts: number;
  /** Connectivity waits: they escalate the probe cadence, not the budget. */
  networkWaits: number;
  enqueuedAt: string;
  updatedAt: string;
  nextAttemptAt: string | null;
  lastError: string | null;
}

/** Wire shape: the journal plus the labels the session list needs. */
export interface AutoResumeItem extends AutoResumeRecord {
  title: string | null;
}

export interface AutoResumeSnapshot {
  online: boolean;
  items: AutoResumeItem[];
}

export interface AutoResumePatch {
  phase: AutoResumePhase;
  attempts: number;
  nextAttemptAt: string | null;
  online: boolean;
}

/** Startup delay: long enough for the session index and runtime recovery. */
export const AUTO_RESUME_START_DELAY_MS = 6_000;
export const AUTO_RESUME_MAX_ATTEMPTS = 6;
export const AUTO_RESUME_MAX_SESSIONS = 12;
export const AUTO_RESUME_JOURNAL_LIMIT = 64;
export const AUTO_RESUME_CONCURRENCY = 2;
/** Work older than this is history, not interrupted work. */
export const AUTO_RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1_000;
export const AUTO_RESUME_MAX_BACKOFF_MS = 15 * 60 * 1_000;
const BACKOFF_STEPS_MS = [15_000, 45_000, 120_000, 300_000, 600_000, 900_000];

/**
 * Transport-level failures only. A provider rejecting the request, an invalid
 * model or a broken tool is a real answer that a retry would just repeat.
 */
const NETWORK_FAILURE_PATTERNS = [
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ECONNABORTED/i,
  /ETIMEDOUT/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
  /ENETDOWN/i,
  /EPIPE/i,
  /UND_ERR/i,
  /fetch failed/i,
  /getaddrinfo/i,
  /socket hang up/i,
  /network error/i,
  /connection error/i,
  /connection (?:refused|reset|closed)/i,
  // reqwest/hyper wording for a request that never reached the provider.
  /error sending request/i,
  /error trying to connect/i,
  /dns error/i,
  /failed to lookup address/i,
  /nodename nor servname/i,
  /tcp connect error/i,
  // A reply stream the provider cut mid-body: reqwest reports the body as
  // undecodable, hyper as an incomplete message. The request was accepted and
  // the turn lost its tail, so a fresh attempt continues the work.
  /error decoding response body/i,
  /incomplete message/i,
  /unexpected end of (?:stream|file)/i,
  /i\/o timeout/i,
  /no route to host/i,
  /network is unreachable/i,
  /connection timed out/i,
  /operation timed out/i,
  /connection closed before message completed/i,
  /request timed out/i,
  /deadline exceeded/i,
  /temporarily unavailable/i,
  /\bHTTP (?:429|500|502|503|504)\b/i,
  /\b(?:502|503|504) (?:Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
];

/** Reasons that mean the user, not the machine, ended the work. */
const USER_STOP_PATTERNS = [
  /User requested session stop/i,
  /Session archived by user/i,
  /deleted by user/i,
  /Archived by user/i,
];

const RESUMABLE_SETTLED = new Set(["interrupted", "paused"]);
const LEFTOVER_ACTIVE = new Set(["running", "queued", "stopping"]);

export function isNetworkFailure(reason: unknown): boolean {
  const text = typeof reason === "string" ? reason : "";
  if (!text.trim()) return false;
  return NETWORK_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isUserStopReason(reason: unknown): boolean {
  const text = typeof reason === "string" ? reason : "";
  if (!text.trim()) return false;
  return USER_STOP_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * A stop the user asked for. The runtime records it in `manualStop` (cleared
 * when the session starts again) and leaves the human-readable reason in
 * `resultSummary`; either one means this work was abandoned on purpose.
 */
export function isUserStoppedSession(session: {
  blockedReason?: string | null;
  resultSummary?: string | null;
  sessionMetadata?: Record<string, unknown> | null;
}): boolean {
  if (session.sessionMetadata?.manualStop) return true;
  return (
    isUserStopReason(session.blockedReason) || isUserStopReason(session.resultSummary)
  );
}

/** Exponential-ish backoff: the first retry is quick, later ones back off. */
export function autoResumeBackoffMs(attempts: number): number {
  const index = Math.max(0, Math.min(attempts - 1, BACKOFF_STEPS_MS.length - 1));
  return BACKOFF_STEPS_MS[index] ?? AUTO_RESUME_MAX_BACKOFF_MS;
}

/**
 * Cooldown between retries that failed without a connectivity verdict. It grows
 * so a long outage costs a handful of probes, not one attempt every few seconds.
 * A monitored reconnect bypasses it entirely.
 */
export function autoResumeNetworkCooldownMs(networkWaits: number): number {
  const steps = [30_000, 60_000, 120_000, 300_000];
  return steps[Math.min(Math.max(networkWaits - 1, 0), steps.length - 1)] ?? 300_000;
}

export type ResumeDecision =
  | { resume: false }
  | { resume: true; cause: AutoResumeCause };

const SKIP: ResumeDecision = { resume: false };

/**
 * Decide whether a session still owns unfinished work worth continuing.
 *
 * The runtime leaves no durable "the user quit here" marker, so the decision
 * leans on the status transition that ended the session: a stop the user asked
 * for is final, a network failure is retryable, and a leftover active status is
 * work a previous host never got to settle.
 */
export function planSessionResume(
  session: AgentSession,
  options: { now?: number; maxAgeMs?: number } = {},
): ResumeDecision {
  if (session.parentSessionId) return SKIP;
  if (session.sessionMetadata?.archivedAt || session.sessionMetadata?.deletedAt)
    return SKIP;
  if (session.sessionMetadata?.subagentKind === "side-chat") return SKIP;

  const status = session.status;
  const reason = session.blockedReason ?? "";

  if (status === "completed" || status === "cancelled") return SKIP;
  if (status === "waiting_permission" || status === "waiting_input") return SKIP;

  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? AUTO_RESUME_MAX_AGE_MS;
  const updatedAt = Date.parse(session.updatedAt);
  // An unparseable timestamp must not make an old session look fresh.
  if (Number.isFinite(updatedAt) && now - updatedAt > maxAge) return SKIP;

  if (isUserStoppedSession(session)) return SKIP;

  if (status === "failed") {
    return isNetworkFailure(reason) ? { resume: true, cause: "network" } : SKIP;
  }
  if (RESUMABLE_SETTLED.has(status)) {
    return { resume: true, cause: isNetworkFailure(reason) ? "network" : "restart" };
  }
  if (LEFTOVER_ACTIVE.has(status)) return { resume: true, cause: "restart" };
  return SKIP;
}

/** A session patch that should clear a queued auto-resume. */
export function clearsAutoResume(
  status: string | undefined,
  reason: string | null | undefined,
): boolean {
  if (status === "completed" || status === "cancelled") return true;
  if (status === "failed") return !isNetworkFailure(reason);
  if (status === "paused" || status === "interrupted")
    return isUserStopReason(reason);
  return false;
}

export function resumeDecisionForPatch(
  status: string | undefined,
  reason: string | null | undefined,
): AutoResumeCause | null {
  if (status === "failed") return isNetworkFailure(reason) ? "network" : null;
  if (status === "paused" || status === "interrupted") {
    if (isUserStopReason(reason)) return null;
    return isNetworkFailure(reason) ? "network" : "restart";
  }
  return null;
}
