/**
 * Live output-token counter for the streaming throughput readout.
 *
 * Counted at the single place where a live SSE stream fans out inside the
 * renderer (see lib/api/sessionLiveClient), keyed by session: the transcript
 * store and the dock stream both consume the same deltas, so counting inside
 * either consumer would double count or miss events depending on which is
 * attached. Deltas are counted as they arrive, so the total never goes
 * backwards when a step boundary clears the visible live buffer.
 */

/** CJK ranges where one character is roughly one token, not a quarter. */
const CJK_CHAR = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * Rough token estimate for a streamed chunk: CJK ≈ 1 token per character,
 * latin/whitespace ≈ 4 characters per token. Deliberately cheap and local —
 * provider usage still owns every billed number the UI shows.
 */
export function estimateStreamTokens(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += CJK_CHAR.test(char) ? 1 : 0.25;
  return tokens;
}

const counters = new Map<string, number>();

/** Count streamed model output; text and reasoning share the output budget. */
export function noteStreamedOutput(sessionId: string, text: string): void {
  if (!sessionId || !text) return;
  counters.set(
    sessionId,
    (counters.get(sessionId) ?? 0) + estimateStreamTokens(text),
  );
}

/** Count the delta-bearing live events; everything else is not output. */
export function noteLiveEvent(
  sessionId: string,
  event: { type: string; delta?: unknown },
): void {
  if (event.type !== "message_delta" && event.type !== "thought_delta") return;
  if (typeof event.delta !== "string") return;
  noteStreamedOutput(sessionId, event.delta);
}

/** Monotonic estimate of the output tokens this session has streamed. */
export function readStreamedTokens(sessionId: string): number {
  return counters.get(sessionId) ?? 0;
}

/** Test helper — the counters are module state, not store state. */
export function resetStreamedTokensForTests(): void {
  counters.clear();
}
