import { agentRuntimeStore } from './session-store.js';
import { ensureWikiProfileRegistered } from '../wiki/wiki-loop-profile.js';
import { ensurePlanProfileRegistered, PLAN_GENERATOR_LEGACY_ID, PLAN_PLANNER_PROFILE_ID } from '../wiki/wiki-plan-profile.js';
import { ensureRefreshProfileRegistered } from '../wiki/wiki-refresh-profile.js';
import {
  ensureLegacyGoalProfileRegistered,
  isSynaxProfile,
} from './synax/index.js';
import { profileService } from './profile-service.js';
import { profileHasWikiAgentReadTools } from '../wiki/wiki-agent-tool-provider.js';

const WIKI_PROFILE_PREFIX = 'wiki-';

/** Register domain-specific agent profiles in a forked agent-session-runner child. */
export function bootstrapAgentChildForSession(sessionId: string): void {
  const session = agentRuntimeStore.tryGetSession(sessionId);
  if (!session) return;

  const { profileId } = session;
  if (profileId.startsWith(WIKI_PROFILE_PREFIX) || profileId === 'wiki-generator') {
    ensureWikiProfileRegistered();
  }
  if (profileId === PLAN_PLANNER_PROFILE_ID || profileId === PLAN_GENERATOR_LEGACY_ID) {
    ensurePlanProfileRegistered();
  }
  if (isSynaxProfile(profileId)) {
    ensureLegacyGoalProfileRegistered();
  }
  if (profileId === 'wiki-refresh') {
    ensureRefreshProfileRegistered();
  }

  // Synax / explorer / executor (and any wiki-capable profile) need wiki read tools
  // from wikiAgentToolProvider. Main API process registers this at startup; forked
  // agent-session-runner children must register it too or wiki.* tools are missing.
  const profile = profileService.maybeGet(profileId);
  if (profile && profileHasWikiAgentReadTools(profile)) {
    ensureWikiProfileRegistered();
  }
}
