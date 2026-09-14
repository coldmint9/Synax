import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { bashTool, executeBash } from './bash.js';
import { workStore } from '../work-store.js';
import { workspaceFingerprint } from '../work-fingerprint.js';
import { AgentValidationError } from '../runtime-errors.js';
import { resolveWorkspacePath } from './workspace.js';
import { nowIso } from '../runtime-ids.js';

export const verificationTool: RegisteredTool = {
  ...bashTool,
  id: 'verification.run', label: 'Verify work',
  description: 'Run a focused verification and retain a version-bound receipt. Uses the same shell permissions as bash. Waits for the command without model polling. Supply the requirement, purpose and source/test scope; broader checks require a concrete unresolved risk. Never stash/reset user changes or detach background jobs. Every explicit invocation executes; prior receipts are reused for completion, not silently substituted for requested reruns.',
  inputSchema: z.object({
    command: z.string().min(1).max(4000), workdir: z.string().optional(), stdin: z.string().max(50000).optional(),
    criterion: z.string().trim().min(1).max(4000), purpose: z.string().trim().min(1).max(4000),
    scope: z.array(z.string().trim().min(1)).min(1).max(40),
    broader: z.boolean().default(false), risk: z.string().trim().min(1).max(4000).optional(),
    external: z.boolean().default(false), timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  }),
  async execute(input) {
    const args = input.args as { command: string; workdir?: string; stdin?: string; criterion: string; purpose: string; scope: string[]; broader: boolean; risk?: string; external: boolean; timeoutMs: number };
    const work = workStore.current(input.sessionId);
    if (!work) throw new AgentValidationError('Verification requires an active work.');
    if (args.broader && (!args.risk || /^(再保险|再检查|just in case|to be safe)/i.test(args.risk)))
      throw new AgentValidationError('Broader verification requires a concrete unresolved risk, not a generic assurance.');
    if (work.acceptanceCriteria.length && !work.acceptanceCriteria.includes(args.criterion))
      throw new AgentValidationError('Verification must reference an approved acceptance criterion.');
    if (/\bgit\s+(?:stash|reset|clean|checkout|restore)\b|\bnohup\b|(^|[^&])&\s*(?:$|[;\n])/i.test(args.command))
      throw new AgentValidationError('Verification cannot stash/reset/restore user changes or detach a background process.');
    const broadCommand = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck)\s*$|\bvitest\s+run\s*$/.test(args.command.trim());
    if (broadCommand && !args.broader) throw new AgentValidationError('An unscoped suite/typecheck requires broader=true and a concrete unresolved risk.');
    for (const path of args.scope) resolveWorkspacePath(path, input.sessionId);
    args.scope = [...new Set([...args.scope, ...work.changedPaths])];
    const startedAt = nowIso();
    const fingerprint = await workspaceFingerprint(input.sessionId, args.scope);
    const result = await executeBash(input, args.timeoutMs);
    const output = result.result as { exitCode?: number; stderr?: string };
    const after = await workspaceFingerprint(input.sessionId, args.scope);
    const current = workStore.current(input.sessionId)!;
    const receipt = {
      runId: input.runId, toolCallId: input.toolCallId, criterion: args.criterion, purpose: args.purpose,
      command: args.command, workdir: args.workdir ?? '.', scope: args.scope,
      fingerprint, changeVersion: current.changeVersion,
      status: (output.exitCode === 0 && fingerprint === after ? 'success' : output.exitCode == null ? 'interrupted' : 'failed') as 'success' | 'failed' | 'interrupted',
      startedAt, completedAt: nowIso(), external: args.external, risk: args.risk,
    };
    current.verifications.push(receipt);
    workStore.save(current);
    return { ...result, result: { ...output, verification: receipt }, displaySummary: `Verification ${receipt.status}: ${args.purpose}${fingerprint !== after ? ' (inputs changed during the check; re-verify)' : ''}` };
  },
};
