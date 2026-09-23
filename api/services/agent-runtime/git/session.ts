import { gitMrService } from '../../git-mr/service.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore } from '../session-store.js';
import { assertGitMrBinding, persistGitMrBinding } from './binding.js';
import { GIT_MANAGER_PROFILE_ID } from './constants.js';
import { ensureGitMrProfileRegistered } from './profile.js';
import { validateGitSkills } from './skills.js';
import { resolveSessionBackend } from '../backends/backend-binding.js';
import { AgentPermissionError } from '../runtime-errors.js';
import { assertLlmProviderConfigured } from '../../llm-runtime/provider-check.js';

export const GIT_INITIAL_REVIEW_REQUEST_ID = 'git-mr-initial-review-v1';
async function startInitialReview(sessionId: string): Promise<void> {
  const session = agentRuntimeStore.getSession(sessionId);
  if (resolveSessionBackend(sessionId).id !== 'native') throw new AgentPermissionError('Git manager requires the scoped native tool runtime.');
  const previous = agentRuntimeStore.listRuns(sessionId).find(run =>
    (run.metadata.runtime as { requestId?: string } | undefined)?.requestId === GIT_INITIAL_REVIEW_REQUEST_ID);
  // Completed/failed/interrupted initial reviews remain ordinary resumable conversations.
  if (previous && previous.status !== 'queued') return;
  assertLlmProviderConfigured(session.projectId);
  const { runCoordinator } = await import('../run-coordinator.js');
  // Durable run admission deduplicates this fixed request ID even after process restart.
  runCoordinator.submit(sessionId, {}, GIT_INITIAL_REVIEW_REQUEST_ID, 'turn');
}

/** Create/reuse the bound conversation and dispatch its first review exactly once. */
export async function createGitMrAgentSession(projectId: string, mrId: string): Promise<{ sessionId: string }> {
  ensureGitMrProfileRegistered();
  validateGitSkills();
  return gitMrService.store.exclusive(`agent-session:${projectId}:${mrId}`, async () => {
    const mr = await gitMrService.get(projectId, mrId);
    if (mr.agentSessionId && agentRuntimeStore.tryGetSession(mr.agentSessionId)) {
      const binding = assertGitMrBinding(mr.agentSessionId);
      if (binding.projectId === projectId && binding.mrId === mrId && binding.rootId === mr.rootId) {
        await startInitialReview(mr.agentSessionId);
        return { sessionId: mr.agentSessionId };
      }
    }
    // Acquire repository ownership before creating authority so a busy MR cannot leave an orphan session.
    assertLlmProviderConfigured(projectId);
    const created = await gitMrService.store.exclusive(mr.commonDir, async () => {
      const fresh = await gitMrService.get(projectId, mrId);
      const session = agentSessionRuntime.create({
        projectId, profileId: GIT_MANAGER_PROFILE_ID, backendId: 'native', mcpServerIds: [], skillIds: [],
        prompt: `Review the server-bound local merge request ${fresh.id}. Read its current state and changed files, explain risks, and offer reviewable conflict proposals where needed. Suggestions do not apply changes or publish the target.`,
        sessionMetadata: { gitMr: { projectId, mrId, rootId: fresh.rootId }, mode: 'chat' },
      });
      persistGitMrBinding({ sessionId: session.id, projectId, mrId, rootId: fresh.rootId });
      fresh.agentSessionId = session.id;
      await gitMrService.store.save(fresh, 'Created suggestion-only Git manager session.');
      return { sessionId: session.id };
    });
    await startInitialReview(created.sessionId);
    return created;
  });
}
