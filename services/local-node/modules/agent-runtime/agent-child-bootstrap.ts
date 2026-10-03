import { ensureGitMrProfileRegistered } from './git/profile.js';
import { agentRuntimeStore } from './session-store.js';
import {
  ensureLegacyGoalProfileRegistered,
  isSynaxProfile,
} from './synax/index.js';

/** Register domain-specific agent profiles in a forked agent-session-runner child. */
export function bootstrapAgentChildForSession(sessionId: string): void {
  const session = agentRuntimeStore.tryGetSession(sessionId);
  if (!session) return;

  const { profileId } = session;
  if (profileId === 'git-manager') ensureGitMrProfileRegistered();
  if (isSynaxProfile(profileId)) {
    ensureLegacyGoalProfileRegistered();
  }
}
