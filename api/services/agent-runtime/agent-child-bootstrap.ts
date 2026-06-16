import { agentRuntimeStore } from './session-store.js';
import { ensureWikiProfileRegistered } from '../wiki/wiki-loop-profile.js';
import { ensurePlanProfileRegistered } from '../wiki/wiki-plan-profile.js';
import { ensureRefreshProfileRegistered } from '../wiki/wiki-refresh-profile.js';
import { ensurePlanExecutorProfileRegistered } from '../wiki/wiki-plan-executor-profile.js';

const WIKI_PROFILE_PREFIX = 'wiki-';

/** Register domain-specific agent profiles in a forked agent-session-runner child. */
export function bootstrapAgentChildForSession(sessionId: string): void {
  const session = agentRuntimeStore.tryGetSession(sessionId);
  if (!session) return;

  const { profileId } = session;
  if (profileId.startsWith(WIKI_PROFILE_PREFIX) || profileId === 'wiki-generator') {
    ensureWikiProfileRegistered();
  }
  if (profileId === 'plan-generator') {
    ensurePlanProfileRegistered();
  }
  if (profileId === 'plan-executor') {
    ensurePlanExecutorProfileRegistered();
  }
  if (profileId === 'wiki-refresh') {
    ensureRefreshProfileRegistered();
  }
}
