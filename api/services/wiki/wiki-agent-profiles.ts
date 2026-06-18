import { PLAN_GENERATOR_LEGACY_ID, PLAN_PLANNER_PROFILE_ID } from './wiki-plan-profile.js';

export const WIKI_PROFILE_PREFIX = 'wiki-';

const WIKI_PLAN_PROFILE_IDS = new Set<string>([
  PLAN_PLANNER_PROFILE_ID,
  PLAN_GENERATOR_LEGACY_ID,
]);

/** Wiki pipeline agents — inject SYNAX.md only to avoid CLAUDE/AGENTS context pollution. */
export function isWikiAgentProfile(profileId: string): boolean {
  return profileId.startsWith(WIKI_PROFILE_PREFIX) || WIKI_PLAN_PROFILE_IDS.has(profileId);
}
