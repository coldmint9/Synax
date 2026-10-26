import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { createSessionWorktree, listSessionWorktrees, removeSessionWorktree, selectSessionWorktree } from '../session-worktrees.js';

const rootId = z.string().min(1).max(128).optional().describe('Stable project rootId from worktree.list. Required for multi-project mutations.');
const checkoutPath = z.string().min(1).max(4096).describe('Exact checkout path returned by worktree.list.');
const listSchema = z.object({ rootId }).strict();
const selectSchema = z.object({ rootId, path: checkoutPath }).strict();
const createSchema = z.object({ rootId, branch: z.string().min(1).max(1024), createBranch: z.boolean().default(false), startPoint: z.string().min(1).max(1024).optional() }).strict();
const removeSchema = z.object({ rootId, path: checkoutPath, missingOnly: z.boolean().default(false).describe('Only clear a missing checkout registration. Skips Git status; refuses existing directories.') }).strict();

export const worktreeTools: RegisteredTool[] = [
  {
    id: 'worktree.list', label: 'Read worktrees', category: 'read', internalGate: 'none', mutability: 'read', resumeBehavior: 'auto',
    description: 'Read workspace projects, branches, shadow worktree directories and current selections. No rootId lists all projects. Does not scan working copy changes.',
    inputSchema: listSchema,
    execute: async input => ({ result: await listSessionWorktrees(input.sessionId, listSchema.parse(input.args ?? {}).rootId), displaySummary: 'Read workspace worktrees', artifacts: [] }),
  },
  {
    id: 'worktree.select', label: 'Select worktree', category: 'write', internalGate: 'write', mutability: 'write', resumeBehavior: 'none',
    description: 'Select an existing worktree or main directory for this agent. Subsequent relative file and command tools use this directory. The user’s checkmark is preserved; the robot marks the active execution directory. Finish child agents and background commands before switching. Call separately from other tools.',
    inputSchema: selectSchema,
    execute: async input => { const args = selectSchema.parse(input.args); return { result: await selectSessionWorktree(input.sessionId, args.rootId, args.path), displaySummary: `Selected worktree: ${args.path}`, artifacts: [] }; },
  },
  {
    id: 'worktree.create', label: 'Create worktree', category: 'write', internalGate: 'write', mutability: 'write', resumeBehavior: 'none',
    description: 'Create a shadow worktree in the selected workspace project using an existing branch, or createBranch=true with a new branch and optional startPoint. Reuses managed worktree allocation. Does not select it automatically; call worktree.select next.',
    inputSchema: createSchema,
    execute: async input => { const args = createSchema.parse(input.args); return { result: await createSessionWorktree(input.sessionId, args), displaySummary: `Created worktree: ${args.branch}`, artifacts: [] }; },
  },
  {
    id: 'worktree.remove', label: 'Remove worktree', category: 'write', internalGate: 'delete', mutability: 'write', resumeBehavior: 'none',
    description: 'Remove a shadow worktree while keeping its branch and commits. Protects main, locked, dirty and occupied checkouts. missingOnly=true clears only the specified absent checkout registration without Git status validation.',
    inputSchema: removeSchema,
    execute: async input => { const args = removeSchema.parse(input.args); return { result: await removeSessionWorktree(input.sessionId, args), displaySummary: `Removed worktree: ${args.path}`, artifacts: [] }; },
  },
];
