/**
 * Compact character-count label for activity rows: `812`, `7.2k`, `99k`.
 *
 * Reasoning bodies routinely run to tens of thousands of characters, so the
 * collapsed row reports the size instead of rendering any of it.
 */
export function formatCharCount(length: number): string {
  if (!Number.isFinite(length) || length <= 0) return '0'
  if (length < 1000) return String(length)
  if (length >= 1_000_000) return `${(length / 1_000_000).toFixed(1)}M`
  if (length < 100_000) return `${(length / 1000).toFixed(1)}k`
  return `${Math.round(length / 1000)}k`
}

/**
 * Duration label for a folded run of turns: `820ms`, `12.3s`, `2m 3s`, `1h 7m`.
 * Returns null when there is nothing meaningful to show.
 */
export function formatDurationMs(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * One-line teaser for a collapsed activity row. Kept short on purpose: the
 * preview is the only part of the body that stays in the DOM while collapsed.
 */
export function activityPreview(content: string, max = 90): string {
  const firstLine = content
    .split('\n')
    .find(line => line.trim() !== '')
    ?.replace(/\s+/g, ' ')
    .trim() ?? ''
  if (firstLine.length <= max) return firstLine
  return `${firstLine.slice(0, max - 1)}…`
}

/**
 * How much of a reasoning body is rendered when the reader expands a row.
 *
 * Real sessions contain single reasoning messages over 90k characters; laying
 * out all of them on expand freezes the scroll for a payload almost nobody
 * reads. The tail is what matters (models keep the latest state at the end), so
 * the expanded view shows the last chunk and reports what it hid.
 */
export const ACTIVITY_BODY_LIMIT = 8000

export function tailForDisplay(
  content: string,
  limit: number = ACTIVITY_BODY_LIMIT,
): { text: string; hidden: number } {
  if (content.length <= limit) return { text: content, hidden: 0 }
  return { text: content.slice(-limit), hidden: content.length - limit }
}
