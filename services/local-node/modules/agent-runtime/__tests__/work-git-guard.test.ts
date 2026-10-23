import { beforeEach, describe, expect, it } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { workStore } from '../work-store.js';
import { workRuntime } from '../work-runtime.js';
import { executorInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

function session() {
  const created = agentSessionRuntime.create({ ...executorInput, permissionTier: 'unrestricted' });
  workStore.create(created.id, 'Compare the change against a baseline');
  return created;
}

beforeEach(async () => {
  await resetAgentRuntimeFixtures();
});

describe('work git guard', () => {
  it('allows read-only git queries without a user instruction', () => {
    const created = session();
    for (const command of ['git stash list', 'git stash show -p', 'git status', 'git clean -n', 'git reset', 'git stash -h'])
      expect(workRuntime.toolError(created.id, 'bash', { command })).toBeNull();
  });

  it('rejects commands that would discard uncommitted work', () => {
    const created = session();
    for (const command of ['git stash', 'git stash push -u -m baseline', 'git stash pop', 'git reset --hard', 'git clean -fd', 'git restore src/app.ts'])
      expect(workRuntime.toolError(created.id, 'bash', { command }))
        .toMatch(/An explicit user instruction is required/);
  });

  it('releases the guard once the user asks for the same command', () => {
    const created = session();
    const work = workStore.current(created.id)!;
    work.requirements.push({ messageId: 'msg-1', text: '先 git stash push 拿到基线，再 stash pop 回来' });
    workStore.save(work);

    expect(workRuntime.toolError(created.id, 'bash', { command: 'git stash push -u -m baseline' })).toBeNull();
    // An instruction for a different destructive form does not unlock the rest.
    expect(workRuntime.toolError(created.id, 'bash', { command: 'git reset --hard' }))
      .toMatch(/An explicit user instruction is required/);
  });
});
