import type { StreamingLiveBuffers } from "../streamingLiveBlocks";

/**
 * Observable phases of one conversation turn.
 *
 * The runtime only persists a step *after* it finishes, so the final reply is
 * not announced anywhere: the earliest honest signal is the first assistant
 * text delta of a step that has not asked for a tool. A step that turns out to
 * be tool work cancels that phase again, which is why `replying` is a
 * provisional phase rather than "the run is about to finish".
 */
export type SessionPhase = "idle" | "working" | "replying" | "settled";

export type SessionLifecycleTransition =
  | "reply_started"
  | "reply_cancelled"
  | "turn_started"
  | "turn_settled";

export interface SessionLifecycleSnapshot {
  /** A turn is active (running, queued, waiting) and owns the composer. */
  activeTurn: boolean;
  /** The step that is currently streaming, if any. */
  stepId: string | null;
  /** Assistant-visible text has been streamed in the current step. */
  hasReplyText: boolean;
  /** The current step has already requested a tool call. */
  hasToolCall: boolean;
}

export const IDLE_LIFECYCLE: SessionLifecycleSnapshot = {
  activeTurn: false,
  stepId: null,
  hasReplyText: false,
  hasToolCall: false,
};

/** Read the reply signals of the streaming step out of the live buffers. */
export function readReplyActivity(
  live: StreamingLiveBuffers,
  stepId: string | null,
  activeTurn: boolean,
): SessionLifecycleSnapshot {
  if (!stepId)
    return { activeTurn, stepId: null, hasReplyText: false, hasToolCall: false };
  let hasReplyText = Boolean(live.pendingText.trim());
  let hasToolCall = live.pendingToolCalls.length > 0;
  for (const block of live.blocks) {
    if (block.type === "text" && block.content.trim()) hasReplyText = true;
    else if (block.type === "tool_call" || block.type === "tool_call_group")
      hasToolCall = true;
    if (hasReplyText && hasToolCall) break;
  }
  return { activeTurn, stepId, hasReplyText, hasToolCall };
}

const isReplying = (snapshot: SessionLifecycleSnapshot) =>
  snapshot.activeTurn && snapshot.hasReplyText && !snapshot.hasToolCall;

/** `settled` is sticky: an idle composer before the first turn stays `idle`. */
export function sessionPhase(
  snapshot: SessionLifecycleSnapshot,
  previous: SessionPhase,
): SessionPhase {
  if (snapshot.activeTurn) return isReplying(snapshot) ? "replying" : "working";
  return previous === "idle" ? "idle" : "settled";
}

/**
 * One transition per state change, so subscribers never have to remember which
 * phase they last saw.
 *
 * A step switch resets the live buffers (`reply text -> none`) but must not
 * look like a cancelled reply: only the same step turning a reply into tool
 * work cancels it.
 */
export function sessionLifecycleTransition(
  previous: SessionLifecycleSnapshot,
  next: SessionLifecycleSnapshot,
): SessionLifecycleTransition | null {
  if (!previous.activeTurn && next.activeTurn) return "turn_started";
  if (previous.activeTurn && !next.activeTurn) return "turn_settled";
  if (!next.activeTurn || !previous.activeTurn) return null;
  const wasReplying = isReplying(previous);
  const nowReplying = isReplying(next);
  if (!wasReplying && nowReplying) return "reply_started";
  if (wasReplying && !nowReplying && previous.stepId === next.stepId)
    return "reply_cancelled";
  return null;
}
