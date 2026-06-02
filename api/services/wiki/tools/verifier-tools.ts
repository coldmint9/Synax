import { z } from 'zod';
import type { RegisteredTool } from '../../agent-runtime/contracts.js';
import type { CodeMapScanResult } from '../../contracts/code-map.js';
import { buildReadTools } from './read-tools.js';

export interface WikiVerdict {
  claimId: string;
  refuted: boolean;
  evidence: string;
  correction: string | null;
}

export interface WikiVerifierHandle {
  tools: RegisteredTool[];
  getVerdicts(): WikiVerdict[];
}

export function createVerifierTools(scan: CodeMapScanResult): WikiVerifierHandle {
  const verdicts: WikiVerdict[] = [];

  const readTools = buildReadTools(scan);

  const submitVerdictTool: RegisteredTool = {
    id: 'wiki.submit_verdict',
    label: 'Submit Verification Verdict',
    description:
      'Submit a verdict on a claim. Provide evidence from source files to support or refute the claim.',
    category: 'write',
    mutability: 'write',
    resumeBehavior: 'auto',
    internalGate: 'none',
    inputSchema: z.object({
      claimId: z.string().min(1).describe('ID of the claim being verified.'),
      refuted: z.boolean().describe('True if the claim is refuted by evidence.'),
      evidence: z
        .string()
        .min(10)
        .describe('Evidence from source files supporting the verdict.'),
      correction: z
        .string()
        .nullable()
        .describe('Corrected statement if refuted, null if confirmed.'),
    }),
    execute(input) {
      const args = input.args as WikiVerdict;
      if (!args?.claimId) {
        return {
          result: { ok: false, error: 'claimId is required.' },
          displaySummary: 'Verdict rejected: missing claimId.',
          artifacts: [],
        };
      }
      if (!args.evidence || args.evidence.length < 10) {
        return {
          result: { ok: false, error: 'evidence must be at least 10 characters.' },
          displaySummary: 'Verdict rejected: insufficient evidence.',
          artifacts: [],
        };
      }

      const verdict: WikiVerdict = {
        claimId: args.claimId,
        refuted: args.refuted,
        evidence: args.evidence,
        correction: args.correction,
      };
      // Deduplicate: replace existing verdict for same claim
      const idx = verdicts.findIndex(v => v.claimId === verdict.claimId);
      if (idx >= 0) verdicts[idx] = verdict;
      else verdicts.push(verdict);

      const status = args.refuted ? 'REFUTED' : 'CONFIRMED';
      return {
        result: { ok: true, claimId: args.claimId, status, totalVerdicts: verdicts.length },
        displaySummary: `Verdict: claim "${args.claimId}" ${status} (${verdicts.length} total).`,
        artifacts: [
          {
            kind: 'evidence',
            title: `Claim ${status}: ${args.claimId}`,
            summary: args.evidence.slice(0, 200),
            risk: args.refuted ? 'medium' : 'low',
          },
        ],
      };
    },
  };

  return {
    tools: [...readTools, submitVerdictTool],
    getVerdicts: () => verdicts,
  };
}
