import { isWorkContinuation } from '../work-intent.js';
import type { SynaxSessionMetadata, SynaxSessionMode } from './synax-session-mode.js';
import { isGoalLikeMode } from './synax-session-mode.js';
import type { SynaxVariantId } from './synax-variant.js';
import { SYNAX_VARIANT_INTENT_RULES, classifySynaxIntent } from './synax-intent-hints.js';

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
    if (input.metadata.activeVariant && input.metadata.routeSource === 'adapt') return null;
    if (isWorkContinuation(input.message)) return null;

    const text = input.message.trim();
    if (!text) return null;

    const kind = classifySynaxIntent(text);
    const rule = SYNAX_VARIANT_INTENT_RULES.find(rule => rule.kind === kind);
    if (rule) return { variantId: VARIANT_ID_BY_INTENT[rule.kind], reason: rule.reason, source: 'rule' };

    return null;
  }
}

export const synaxIntentRouter = new SynaxIntentRouter();
