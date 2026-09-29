/** Zero-padded 24h parts, so the stamp never varies with host locale data. */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * Completion stamp for one transcript turn. The same day carries no date at
 * all, the same year keeps the month/day, and an older turn stays unambiguous.
 *
 * Returns null for a missing or unparseable ISO string so callers can skip the
 * element entirely instead of rendering "Invalid Date".
 */
export function formatCompletionTimestamp(
  iso: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const ms = at.getTime();
  if (Number.isNaN(ms)) return null;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return time;
  const monthDay = `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  if (at.getFullYear() === now.getFullYear()) return `${monthDay} ${time}`;
  return `${at.getFullYear()}-${monthDay} ${time}`;
}
