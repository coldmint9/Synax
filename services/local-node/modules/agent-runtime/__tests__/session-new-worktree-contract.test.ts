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

it('preserves the repository selection for a preselected worktree and rejects empty root IDs', () => {
  const selected = { kind: 'worktree', path: '/reference/worktree', rootId: 'reference' };
  const parsed = createSessionRequestSchema.safeParse({ ...base, gitWorkspace: selected });
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data.gitWorkspace).toEqual(selected);
  expect(createSessionRequestSchema.safeParse({ ...base, gitWorkspace: { ...selected, rootId: '' } }).success).toBe(false);
});
