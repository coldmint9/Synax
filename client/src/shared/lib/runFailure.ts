import { t, type Locale } from "./i18n";

/**
 * Wordings that mean the reply stream was cut mid-body rather than rejected.
 *
 * reqwest reports an undecodable body and hyper an incomplete message; both end
 * a turn that had already started delivering an answer. The provider was
 * reachable and the request was accepted, so the raw text tells the user
 * nothing they can act on.
 */
const TRUNCATED_STREAM_PATTERNS = [
  /error decoding response body/i,
  /incomplete message/i,
  /unexpected end of (?:stream|file)/i,
  /connection closed before message completed/i,
];

/** Whether a run failure means the upstream cut the reply stream. */
export function isTruncatedStreamFailure(reason: unknown): boolean {
  const text = typeof reason === "string" ? reason : "";
  if (!text.trim()) return false;
  return TRUNCATED_STREAM_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The reason a failure surface should show. Transport wording becomes an
 * explanation the user can act on; the original message stays in the runtime
 * log, where the retry verdict is decided.
 */
export function describeRunFailure(
  reason: string | null | undefined,
  locale: Locale,
): string | null {
  const text = reason?.trim();
  if (!text) return null;
  return isTruncatedStreamFailure(text) ? t(locale, "runFailureStreamTruncated") : text;
}
