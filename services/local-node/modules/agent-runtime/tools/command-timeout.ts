// Leave time for the 120s dependency assessment before the hard process limit.
export const EXEC_TIMEOUT_MS = 600_000;
export const MIN_EXEC_TIMEOUT_MS = 1_000;
export const MAX_EXEC_TIMEOUT_MS = 600_000;

/** Shared by the command and its outer resource budget so explicit and default
 * timeout windows cannot diverge. */
export function resolveExecTimeoutMs(
  requested: number | undefined,
  fallback: number = EXEC_TIMEOUT_MS,
): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return fallback;
  return Math.min(Math.max(Math.trunc(requested), MIN_EXEC_TIMEOUT_MS), MAX_EXEC_TIMEOUT_MS);
}
