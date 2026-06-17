import {
  ensureLegacyGoalProfileRegistered,
  LEGACY_GOAL_PROFILE_ID,
  SYNAX_AGENT_PROFILE_ID,
} from '../agent-runtime/synax/index.js';

/** @deprecated Use SYNAX_AGENT_PROFILE_ID with sessionMetadata.mode instead. */
export const GOAL_AGENT_PROFILE_ID = LEGACY_GOAL_PROFILE_ID;

export { SYNAX_AGENT_PROFILE_ID };

/** @deprecated Registers legacy goal profile alias. Prefer ensureSynaxAgentRegistered(). */
export function ensureGoalProfileRegistered(): void {
  ensureLegacyGoalProfileRegistered();
}
