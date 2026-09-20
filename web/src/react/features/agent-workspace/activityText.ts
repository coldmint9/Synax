export { hasDisplayableReasoning } from "../../../../../api/services/agent-runtime/reasoning-display";

/**
 * Compact character-count label for activity rows: `812`, `7.2k`, `99k`.
 *
 * Reasoning bodies routinely run to tens of thousands of characters, so the
 * collapsed row reports the size instead of rendering any of it.
 */
export function formatCharCount(length: number): string {
  if (!Number.isFinite(length) || length <= 0) return "0";
  if (length < 1000) return String(length);
  if (length >= 1_000_000) return `${(length / 1_000_000).toFixed(1)}M`;
  if (length < 100_000) return `${(length / 1000).toFixed(1)}k`;
  return `${Math.round(length / 1000)}k`;
}

/**
 * Duration label for a folded run of turns: `820ms`, `12.3s`, `2m 3s`, `1h 7m`.
 * Returns null when there is nothing meaningful to show.
 */
export function formatDurationMs(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * One-line teaser for a collapsed activity row. Kept short on purpose: the
 * preview is the only part of the body that stays in the DOM while collapsed.
 */
export function activityPreview(content: string, max = 90): string {
  const firstLine =
    content
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.replace(/\s+/g, " ")
      .trim() ?? "";
  if (firstLine.length <= max) return firstLine;
  return `${firstLine.slice(0, max - 1)}…`;
}

/**
 * One-line teaser for a row that folds records: the newest one, not the oldest.
 *
 * `activityPreview` reports where the text started, which is the oldest thing
 * the model said. A folded row is read as "where is this now", so the newest
 * non-empty record is previewed instead, and an over-long record keeps its tail
 * so the freshest part stays visible.
 */
export function latestActivityPreview(content: string, max = 90): string {
  const lines = content
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
  const latest = lines[lines.length - 1] ?? "";
  if (latest.length <= max) return latest;
  const tail = latest.slice(-max);
  // Never open the teaser in the middle of a word.
  const boundary = tail.search(/\s/);
  return `…${boundary > 0 && boundary < 12 ? tail.slice(boundary + 1) : tail}`;
}

/**
 * Longest `**phrase**` payload still treated as a reasoning headline.
 *
 * Real reasoning text is written in paragraphs; a model that only emits a
 * wrapped one-liner is reporting loop state, not thinking out loud.
 */
const THINKING_BANNER_MAX_CHARS = 120;

/**
 * Remote models running a tool loop often send their reasoning as one or more
 * adjacent `**Inspecting backend metadata**` strings. There is no reasoning
 * text to read, so the transcript promotes each payload to a banner chunk.
 *
 * Returns every bare phrase, or null when any non-headline content is present.
 */
export function thinkingBannerPhrases(content: string): string[] | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const phrases: string[] = [];
  let cursor = 0;
  while (cursor < trimmed.length) {
    while (/\s/.test(trimmed[cursor] ?? "")) cursor += 1;
    if (cursor >= trimmed.length) break;
    if (!trimmed.startsWith("**", cursor)) return null;
    cursor += 2;

    const closing = trimmed.indexOf("**", cursor);
    let rawPhrase = trimmed.slice(cursor, closing < 0 ? undefined : closing);
    // A single trailing asterisk is an in-flight closing marker.
    if (closing < 0 && rawPhrase.endsWith("*"))
      rawPhrase = rawPhrase.slice(0, -1);
    const phrase = rawPhrase.trim();
    if (
      !phrase ||
      phrase.includes("*") ||
      phrase.length > THINKING_BANNER_MAX_CHARS
    )
      return null;
    phrases.push(phrase);

    if (closing < 0) break;
    cursor = closing + 2;
  }

  return phrases.length > 0 ? phrases : null;
}

/** Latest headline, used by compact previews that only have room for one. */
export function thinkingBannerPhrase(content: string): string | null {
  const phrases = thinkingBannerPhrases(content);
  return phrases ? (phrases[phrases.length - 1] ?? null) : null;
}

/**
 * How much of a reasoning body is rendered when the reader expands a row.
 *
 * Real sessions contain single reasoning messages over 90k characters; laying
 * out all of them on expand freezes the scroll for a payload almost nobody
 * reads. The tail is what matters (models keep the latest state at the end), so
 * the expanded view shows the last chunk and reports what it hid.
 */
export const ACTIVITY_BODY_LIMIT = 8000;

export function tailForDisplay(
  content: string,
  limit: number = ACTIVITY_BODY_LIMIT,
): { text: string; hidden: number } {
  if (content.length <= limit) return { text: content, hidden: 0 };
  return { text: content.slice(-limit), hidden: content.length - limit };
}
