import { execFileSync } from 'node:child_process';
import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';

export const diffReadTool: RegisteredTool = {
  id: 'diff.read',
  label: 'Read Diff Summary',
  description: 'Read a git diff summary for review without applying changes.',
  category: 'read',
  mutability: 'read',
  resumeBehavior: 'auto',
  internalGate: 'none',
  progressiveDetails: 'Accepts { staged?: boolean }.',
  inputSchema: z.object({
    staged: z.boolean().optional().describe('Read the staged diff instead of the working tree diff.'),
  }),
  execute(input) {
    const args = (input.args ?? {}) as { staged?: boolean };
    const gitArgs = ['diff', '--stat'];
    if (args.staged) gitArgs.splice(1, 0, '--cached');
    const summary = execFileSync('git', gitArgs, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return {
      result: { staged: Boolean(args.staged), summary },
      displaySummary: summary || 'No workspace diff.',
      artifacts: [
        {
          kind: 'diff_summary',
          title: 'Diff summary',
          summary: summary || 'No workspace diff.',
          risk: summary ? 'medium' : 'low',
        },
      ],
    };
  },
};
