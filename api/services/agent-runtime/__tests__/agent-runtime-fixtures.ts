import { resetRuntimeIdsForTests } from '../runtime-ids.js';
import { agentRuntimeStore } from '../session-store.js';

export function resetAgentRuntimeFixtures(): void {
  agentRuntimeStore.reset();
  resetRuntimeIdsForTests();
}

export const plannerSessionInput = {
  projectId: 'project-alpha',
  profileId: 'planner',
  prompt: 'Plan a bounded implementation slice.',
};

export const explorerSessionInput = {
  projectId: 'project-alpha',
  profileId: 'explorer',
  prompt: 'Explore the codebase read-only.',
};

export const executorInput = {
  projectId: 'project-alpha',
  profileId: 'executor',
  prompt: 'Dispatch a controlled execution step.',
};
