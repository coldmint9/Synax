import { beforeEach, expect, it } from 'vitest';
import { resetAgentRuntimeFixtures } from '../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js';
import { agentSessionRuntime } from '../../../modules/agent-runtime/session-runtime.js';
import { agentRuntimeStore } from '../../../modules/agent-runtime/session-store.js';
import { agentRuntimeRoutes } from '../agent-runtime.js';

beforeEach(resetAgentRuntimeFixtures);

it.each(
  (['running', 'paused', 'completed'] as const).flatMap(status =>
    [false, true].map(cold => ({ status, cold }))),
)('opens a $status merge child created by another host (cold session cache: $cold)', async ({ status, cold }) => {
  const parent = agentSessionRuntime.create({
    projectId: 'project-alpha', profileId: 'executor', prompt: 'Merge branches.', workDir: process.cwd(),
  });
  const child = agentSessionRuntime.create({
    projectId: parent.projectId, profileId: 'explorer', parentSessionId: parent.id,
    prompt: 'Resolve the bound merge.', workDir: process.cwd(),
  });
  // Seed the durable record a worker host would write, without registering
  // its profile or tool provider in this HTTP host.
  agentRuntimeStore.updateSession(child.id, {
    profileId: 'git-merge-worker', status, resultSummary: 'Merge progress.',
    sessionMetadata: { mergeWorker: { parentSessionId: parent.id, objectId: 'merge-task', projectId: parent.projectId, epoch: 1 } },
  });
  await agentRuntimeStore.flush();
  if (cold) agentRuntimeStore.reset();

  const response = await agentRuntimeRoutes.request(`/sessions/${child.id}`);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({
    session: { id: child.id, parentSessionId: parent.id, profileId: 'git-merge-worker', status, resultSummary: 'Merge progress.' },
    profile: { id: 'git-merge-worker', mode: 'subagent', toolProviderId: 'conversation-git-worker' },
  });
  // Opening the child must not change its execution state or create a run.
  const summary = await agentRuntimeRoutes.request(`/sessions/${child.id}/summary`);
  expect(summary.status).toBe(200);
  expect(await summary.json()).toMatchObject({ session: { id: child.id, status, activeRunId: null } });
});
