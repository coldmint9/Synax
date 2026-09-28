import { expect, it } from 'vitest';
import { createSessionRequestSchema } from '../contracts.js';

const base = { projectId: 'p', profileId: 'synax', prompt: 'Start work' };

it('accepts a fresh managed worktree without a branch name or path', () => {
  const parsed = createSessionRequestSchema.safeParse({
    ...base, gitWorkspace: { kind: 'new-worktree' },
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data.gitWorkspace).toEqual({ kind: 'new-worktree' });
  expect(createSessionRequestSchema.safeParse({
    ...base, workDir: '/other', gitWorkspace: { kind: 'new-worktree' },
  }).success).toBe(false);
});
