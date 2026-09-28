const allowedUntil = new Map<string, number>();
const TTL_MS = 5 * 60_000;

/** Explicitly configured Direct fallback becomes visible only after Jev fails. */
export function enableDirectFallback(sessionId: string): void {
  allowedUntil.set(sessionId, Date.now() + TTL_MS);
}
export function canUseDirectFallback(sessionId: string): boolean {
  const until = allowedUntil.get(sessionId) ?? 0;
  if (until > Date.now()) return true;
  allowedUntil.delete(sessionId);
  return false;
}
export function clearDirectFallback(sessionId: string): void { allowedUntil.delete(sessionId); }
