export const SYNAX_AGENT_PROFILE_ID = 'synax';

/** @deprecated Legacy profile id — kept for existing sessions in the database. */
export const LEGACY_GOAL_PROFILE_ID = 'goal';

export const SYNAX_SESSION_MODES = ['chat', 'goal', 'plan_node'] as const;
export type SynaxSessionMode = (typeof SYNAX_SESSION_MODES)[number];

export const SYNAX_SESSION_SOURCES = [
  'session-page',
  'goal-dock',
  'plan-execution',
] as const;
export type SynaxSessionSource = (typeof SYNAX_SESSION_SOURCES)[number];

export interface SynaxSessionMetadata {
  mode?: SynaxSessionMode;
  source?: SynaxSessionSource | string;
  goalContent?: string;
  goalId?: string;
  documentId?: string | null;
  wikiAttachMode?: 'auto' | 'manual';
  planId?: string;
  planNodeId?: string;
  planNodeTitle?: string;
  activeVariant?: string;
  routeReason?: string;
  routedAt?: string;
  routeSource?: 'auto' | 'adapt';
}

const LEGACY_GOAL_SOURCES = new Set<string>(SYNAX_SESSION_SOURCES);

export function isSynaxProfile(profileId: string): boolean {
  return profileId === SYNAX_AGENT_PROFILE_ID || profileId === LEGACY_GOAL_PROFILE_ID;
}

export function parseSynaxSessionMode(
  metadata: Record<string, unknown> | null | undefined,
): SynaxSessionMode | null {
  const mode = metadata?.mode;
  if (typeof mode !== 'string') return null;
  return (SYNAX_SESSION_MODES as readonly string[]).includes(mode) ? (mode as SynaxSessionMode) : null;
}

export function inferSynaxSessionMode(input: {
  profileId: string;
  sessionMetadata: Record<string, unknown> | null | undefined;
}): SynaxSessionMode {
  const explicit = parseSynaxSessionMode(input.sessionMetadata);
  if (explicit) return explicit;

  if (input.profileId === LEGACY_GOAL_PROFILE_ID) {
    const source = input.sessionMetadata?.source;
    if (source === 'plan-execution') return 'plan_node';
    return 'goal';
  }

  const source = input.sessionMetadata?.source;
  if (typeof source === 'string' && LEGACY_GOAL_SOURCES.has(source)) {
    return source === 'plan-execution' ? 'plan_node' : 'goal';
  }

  return 'chat';
}

export function isGoalLikeMode(mode: SynaxSessionMode): boolean {
  return mode === 'goal' || mode === 'plan_node';
}

export function isGoalLikeSession(input: {
  profileId: string;
  sessionMetadata: Record<string, unknown> | null | undefined;
}): boolean {
  if (input.profileId === LEGACY_GOAL_PROFILE_ID) return true;

  const source = input.sessionMetadata?.source;
  if (typeof source === 'string' && LEGACY_GOAL_SOURCES.has(source)) {
    return true;
  }

  if (!isSynaxProfile(input.profileId)) return false;

  return isGoalLikeMode(inferSynaxSessionMode(input));
}
