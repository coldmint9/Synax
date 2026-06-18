import type { SynaxSessionMetadata, SynaxSessionMode } from './synax-session-mode.js';
import { isGoalLikeMode } from './synax-session-mode.js';
import type { SynaxVariantId } from './synax-variant.js';
import { SYNAX_VARIANT_INTENT_RULES } from './synax-intent-hints.js';

const VARIANT_ID_BY_INTENT: Record<string, SynaxVariantId> = {
  review: 'reviewer',
  plan: 'planner',
  explore: 'explorer',
};

export interface SynaxRouteDecision {
  variantId: SynaxVariantId;
  reason: string;
  source: 'rule';
}

interface RouteInput {
  message: string;
  mode: SynaxSessionMode;
  metadata: SynaxSessionMetadata;
}

export class SynaxIntentRouter {
  route(input: RouteInput): SynaxRouteDecision | null {
    if (isGoalLikeMode(input.mode)) return null;
    if (input.metadata.activeVariant) return null;

    const text = input.message.trim();
    if (!text) return null;

    for (const rule of SYNAX_VARIANT_INTENT_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(text))) {
        return {
          variantId: VARIANT_ID_BY_INTENT[rule.kind],
          reason: rule.reason,
          source: 'rule',
        };
      }
    }

    return null;
  }
}

export const synaxIntentRouter = new SynaxIntentRouter();
