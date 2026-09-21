import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '../../../lib/env.js';
import { resetRuntimeIdsForTests } from '../runtime-ids.js';
import { agentRuntimeStore } from '../session-store.js';

export function resetAgentRuntimeFixtures(): void {
  agentRuntimeStore.reset();
  resetRuntimeIdsForTests();
  // Runtime execution requires an explicit workspace, even in unit tests.
  const file = path.join(DATA_ROOT, 'projects.json');
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  let items: Array<{ id: string }> = [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    items = Array.isArray(saved) ? saved : saved.items ?? [];
  } catch { /* fresh fixture */ }
  if (!items.some(project => project.id === 'project-alpha')) {
    fs.writeFileSync(file, JSON.stringify({ items: [...items, {
      id: 'project-alpha', source: { localPath: process.cwd() },
    }] }));
  }
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
