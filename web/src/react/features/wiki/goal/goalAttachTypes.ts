export const SYNAX_PROFILE_ID = 'synax'

/** @deprecated Use SYNAX_PROFILE_ID with sessionMetadata.mode === 'goal'. */
export const GOAL_PROFILE_ID = SYNAX_PROFILE_ID

export type SynaxSessionMode = 'chat' | 'goal' | 'plan_node'

export function createSynaxSessionMetadata(
  mode: SynaxSessionMode,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return { mode, ...extras }
}

export type GoalWikiAttachMode = 'auto' | 'manual'

export type GoalPermissionTier = 'readonly' | 'readwrite' | 'unrestricted'

export const DEFAULT_GOAL_PERMISSION_TIER: GoalPermissionTier = 'readonly'

export const GOAL_PERMISSION_TIER_LABELS: Record<GoalPermissionTier, { titleKey: string; descKey: string }> = {
  readonly: {
    titleKey: 'goalPermTierReadonly',
    descKey: 'goalPermTierReadonlyDesc',
  },
  readwrite: {
    titleKey: 'goalPermTierReadwrite',
    descKey: 'goalPermTierReadwriteDesc',
  },
  unrestricted: {
    titleKey: 'goalPermTierUnrestricted',
    descKey: 'goalPermTierUnrestrictedDesc',
  },
}

export function hasNonDefaultGoalPermissionTier(tier: GoalPermissionTier): boolean {
  return tier !== DEFAULT_GOAL_PERMISSION_TIER
}
