/**
 * The run-state dot one session shows — in its own row and, summarised, on its
 * group heading. One rule for both, so a category never claims state the rows
 * underneath it do not show.
 *
 * Tones reuse the colour tokens the rows already paint with (destructive /
 * warning / run / success); the order below is the triage the project badges
 * use: a session blocked on the user outranks a failed one, which outranks work
 * in flight, which outranks finished work.
 */
export type SessionStatusTone = "warning" | "danger" | "running" | "success";

export const SESSION_STATUS_TONE_ORDER: readonly SessionStatusTone[] = [
  "warning",
  "danger",
  "running",
  "success",
];

const TONE_BY_STATUS: Record<string, SessionStatusTone> = {
  failed: "danger",
  // A run parked on a permission form or a question needs the user to move.
  waiting_permission: "warning",
  waiting_input: "warning",
  // Resting states that only continue once the user resumes them.
  interrupted: "warning",
  paused: "warning",
  running: "running",
  stopping: "running",
  queued: "running",
  completed: "success",
  // `cancelled` is neither pending nor in flight: it adds no dot.
};

/** Results that stop asking for attention once the session has been read. */
const READ_ONCE_STATUSES = new Set<string>(["completed", "failed"]);

export function sessionStatusTone(status: string): SessionStatusTone | null {
  return TONE_BY_STATUS[status] ?? null;
}

export interface SessionDotState {
  status: string;
  /** Whether the session is unread, per `isSessionUnread` in the session store. */
  unread: boolean;
}

/**
 * Tone of the dot this session contributes, or null for no dot.
 *
 * Yellow and blue describe a condition that lasts as long as the status does.
 * A finished result — green or red — is news: it stops showing once read.
 */
export function sessionStatusDot(state: SessionDotState): SessionStatusTone | null {
  const tone = sessionStatusTone(state.status);
  if (!tone) return null;
  if (READ_ONCE_STATUSES.has(state.status) && !state.unread) return null;
  return tone;
}

export type SessionStatusCounts = Partial<Record<SessionStatusTone, number>>;

/** Count the dots a group's sessions contribute, ignoring ones without a dot. */
export function summarizeSessionDots(
  states: Iterable<SessionDotState>,
): SessionStatusCounts {
  const counts: SessionStatusCounts = {};
  for (const state of states) {
    const tone = sessionStatusDot(state);
    if (!tone) continue;
    counts[tone] = (counts[tone] ?? 0) + 1;
  }
  return counts;
}

/** Tones to draw, in urgency order, skipping tones absent from the group. */
export function orderedSessionStatusTones(
  counts: SessionStatusCounts,
): SessionStatusTone[] {
  return SESSION_STATUS_TONE_ORDER.filter((tone) => (counts[tone] ?? 0) > 0);
}
