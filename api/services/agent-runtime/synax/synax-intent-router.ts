import type { SynaxSessionMetadata, SynaxSessionMode } from './synax-session-mode.js';
import { isGoalLikeMode } from './synax-session-mode.js';
import type { SynaxVariantId } from './synax-variant.js';

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

interface IntentRule {
  variantId: SynaxVariantId;
  reason: string;
  patterns: RegExp[];
}

const INTENT_RULES: IntentRule[] = [
  {
    variantId: 'reviewer',
    reason: 'User intent looks like code review or risk assessment.',
    patterns: [
      /\breview\b/i,
      /\baudit\b/i,
      /审查|评审|检查风险|代码审查/,
      /\bcheck (for )?(regressions|risks|issues)\b/i,
    ],
  },
  {
    variantId: 'planner',
    reason: 'User intent looks like planning or task decomposition.',
    patterns: [
      /\bplan\b/i,
      /\bbreak down\b/i,
      /\bdecompose\b/i,
      /规划|分解|拆分|计划/,
      /\broadmap\b/i,
      /\boutline (the )?steps\b/i,
    ],
  },
  {
    variantId: 'explorer',
    reason: 'User intent looks like codebase exploration or discovery.',
    patterns: [
      /\bexplore\b/i,
      /\binvestigate\b/i,
      /\bfind where\b/i,
      /\bhow does\b/i,
      /\bunderstand\b/i,
      /探索|查找|摸清|架构|在哪里/,
      /\bmap (the )?(codebase|project)\b/i,
    ],
  },
];

export class SynaxIntentRouter {
  route(input: RouteInput): SynaxRouteDecision | null {
    if (isGoalLikeMode(input.mode)) return null;
    if (input.metadata.activeVariant) return null;

    const text = input.message.trim();
    if (!text) return null;

    for (const rule of INTENT_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(text))) {
        return {
          variantId: rule.variantId,
          reason: rule.reason,
          source: 'rule',
        };
      }
    }

    return null;
  }
}

export const synaxIntentRouter = new SynaxIntentRouter();
