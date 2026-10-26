import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ review: vi.fn(), push: vi.fn() }));
vi.mock('../../../modules/agent-runtime/session-git-commit.js', () => ({
  commitSessionWorkspace: vi.fn(), listSessionWorkspaceCommits: mocks.review, pushSessionWorkspace: mocks.push,
}));
import { agentRuntimeRoutes } from '../agent-runtime.js';
import { resetAgentRuntimeFixtures } from '../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js';
import { agentSessionRuntime } from '../../../modules/agent-runtime/session-runtime.js';
import { agentRuntimeStore } from '../../../modules/agent-runtime/session-store.js';
import { ensureSynaxAgentRegistered } from '../../../modules/agent-runtime/synax/index.js';
let sessionId: string;
beforeEach(async () => {
  vi.clearAllMocks();
  await resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  sessionId = agentSessionRuntime.create({ projectId: 'project-alpha', profileId: 'synax', prompt: 'Push review fixture' }).id;
  await agentRuntimeStore.flushSession(sessionId);
});
it('reads the selected root and prevents caching of the review', async () => {
  const data = { rootId: 'web', branch: 'main', headCommitSha: 'a'.repeat(40), upstream: 'origin/main', commits: [] };
  mocks.review.mockResolvedValue(data);
  const response = await agentRuntimeRoutes.request(`/sessions/${sessionId}/git/commits-to-push?rootId=web`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual(data);
  expect(mocks.review).toHaveBeenCalledWith(sessionId, { rootId: 'web' });
});
it('forwards review identity through the push route', async () => {
  const input = { rootId: 'web', expectedHeadSha: 'a'.repeat(40), expectedBranch: 'main', expectedUpstream: 'origin/main' };
  mocks.push.mockResolvedValue({ rootId: 'web', branch: 'main', pushed: true, upstream: 'origin/main' });
  const response = await agentRuntimeRoutes.request(`/sessions/${sessionId}/git/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  expect(response.status).toBe(200);
  expect(mocks.push).toHaveBeenCalledWith(sessionId, input);
});
