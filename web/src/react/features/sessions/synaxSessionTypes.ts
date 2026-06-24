export const SYNAX_PROFILE_ID = 'synax'

export type SynaxSessionMode = 'chat' | 'goal' | 'plan_node'

export function createSynaxSessionMetadata(
  mode: SynaxSessionMode,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return { mode, ...extras }
}

export type SynaxPermissionTier = 'readonly' | 'readwrite' | 'unrestricted'

export type SynaxWikiAttachMode = 'auto' | 'manual'

export const DEFAULT_SYNAX_PERMISSION_TIER: SynaxPermissionTier = 'readonly'

export const SYNAX_PERMISSION_TIER_LABELS: Record<SynaxPermissionTier, { titleKey: string; descKey: string }> = {
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

export function hasNonDefaultSynaxPermissionTier(tier: SynaxPermissionTier): boolean {
  return tier !== DEFAULT_SYNAX_PERMISSION_TIER
}

export function readSynaxPermissionTier(
  metadata: Record<string, unknown> | null | undefined,
): SynaxPermissionTier {
  const tier = metadata?.permissionTier
  if (tier === 'readonly' || tier === 'readwrite' || tier === 'unrestricted') {
    return tier
  }
  return DEFAULT_SYNAX_PERMISSION_TIER
}
