import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { runCommand } from './exec-async.js';
import { workspaceRoot } from './workspace.js';

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
  async execute(input) {
    const args = (input.args ?? {}) as { staged?: boolean };
    const gitArgs = ['diff', '--stat'];
    if (args.staged) gitArgs.splice(1, 0, '--cached');
    // `git diff` runs asynchronously so it never blocks the event loop.
    const result = await runCommand('git', gitArgs, {
      cwd: workspaceRoot(input.sessionId),
      maxBufferBytes: 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `git diff failed with exit code ${result.status ?? 'unknown'}.`);
    }
    const summary = result.stdout.trim();
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
