export {
  SYNAX_PROFILE_ID,
  createSynaxSessionMetadata,
  DEFAULT_SYNAX_PERMISSION_TIER as DEFAULT_GOAL_PERMISSION_TIER,
  SYNAX_PERMISSION_TIER_LABELS as GOAL_PERMISSION_TIER_LABELS,
  hasNonDefaultSynaxPermissionTier as hasNonDefaultGoalPermissionTier,
  type SynaxSessionMode,
  type SynaxPermissionTier as GoalPermissionTier,
  type SynaxWikiAttachMode as GoalWikiAttachMode,
} from '../../sessions/synaxSessionTypes'

/** @deprecated Use SYNAX_PROFILE_ID with sessionMetadata.mode === 'goal'. */
export { SYNAX_PROFILE_ID as GOAL_PROFILE_ID } from '../../sessions/synaxSessionTypes'
