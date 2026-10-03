import * as z from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { agentRuntimeStore } from '../session-store.js';
import { agentEventService } from '../event-service.js';
import { nowIso } from '../runtime-ids.js';
import { AgentValidationError } from '../runtime-errors.js';
import { SYNAX_VARIANT_IDS, synaxVariantRegistry } from './synax-variant.js';
import type { SynaxAgent } from './synax-agent.js';

export const SYNAX_ADAPT_TOOL_ID = 'agent.adapt';

export function createSynaxAdaptTool(synaxAgent: SynaxAgent): RegisteredTool {
  return {
    id: SYNAX_ADAPT_TOOL_ID,
    label: 'Adapt Agent Variant',
    description:
      'Switch this Synax session to a specialized variant when the task clearly fits planning, exploration, or review. ' +
      'Use for sustained work in that specialty. For one-off subtasks, prefer subagent.delegate instead.',
    category: 'context',
    mutability: 'read',
    resumeBehavior: 'auto',
    progressiveDetails:
      `Accepts { variantId: ${SYNAX_VARIANT_IDS.join(' | ')}, reason: string }. Updates loop behavior for the rest of this session.`,
    inputSchema: z.object({
      variantId: z.enum(SYNAX_VARIANT_IDS).describe('Specialized Synax variant to activate.'),
      reason: z.string().min(1).describe('Why this variant fits the current task.'),
    }),
    execute: (input) => {
      const session = agentRuntimeStore.getSession(input.sessionId);
      if (!synaxAgent.isSynaxSession(session)) {
        throw new AgentValidationError('agent.adapt is only available to Synax sessions.');
      }

      const args = input.args as { variantId?: string; reason?: string };
      if (!args.variantId?.trim()) {
        throw new AgentValidationError('variantId is required for agent.adapt.');
      }
      if (!args.reason?.trim()) {
        throw new AgentValidationError('reason is required for agent.adapt.');
      }

      const variant = synaxVariantRegistry.getOrThrow(args.variantId);
      const applied = synaxAgent.applyVariant(input.sessionId, variant.id, args.reason.trim(), 'adapt');

      agentEventService.append({
        sessionId: input.sessionId,
        type: 'progress_updated',
        summary: `Adapted to ${variant.label}`,
        payload: {
          activeVariant: variant.id,
          routeReason: args.reason.trim(),
          routedAt: applied.routedAt,
        },
      });

      return {
        result: {
          variantId: variant.id,
          label: variant.label,
          routedAt: applied.routedAt,
        },
        displaySummary: `Adapted to ${variant.label}.`,
        artifacts: [
          {
            kind: 'decision',
            title: 'Agent variant switched',
            summary: `${variant.label}: ${args.reason.trim()}`,
            risk: 'low',
          },
        ],
        followUpHints: variant.loopHints.slice(0, 2),
      };
    },
  };
}
