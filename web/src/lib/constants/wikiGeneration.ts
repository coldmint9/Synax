/** Phase 1 (outline / scan) inactivity timeout before UI stops tracking active generation. */
export const WIKI_GEN_PHASE1_TIMEOUT_MS = 10 * 60_000

/** Phase 2 (document writing) inactivity timeout before UI stops tracking active generation. */
export const WIKI_GEN_PHASE2_TIMEOUT_MS = 30 * 60_000

export function wikiGenTimeoutForPhase(phase: string | null | undefined): number {
  if (phase === 'writing') return WIKI_GEN_PHASE2_TIMEOUT_MS
  return WIKI_GEN_PHASE1_TIMEOUT_MS
}
