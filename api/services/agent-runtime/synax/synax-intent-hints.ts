import type { SynaxSessionMode } from './synax-session-mode.js';

export type SynaxIntentKind = 'explore' | 'coding' | 'review' | 'plan';

export interface SynaxIntentHintInput {
  message: string;
  mode: SynaxSessionMode;
  stepIndex?: number;
}

interface IntentPatternRule {
  kind: SynaxIntentKind;
  patterns: RegExp[];
}

/** Variant routing patterns (review/plan/explore) — shared with synax-intent-router. */
export const SYNAX_VARIANT_INTENT_RULES: ReadonlyArray<{
  kind: Extract<SynaxIntentKind, 'review' | 'plan' | 'explore'>;
  reason: string;
  patterns: RegExp[];
}> = [
  {
    kind: 'review',
    reason: 'User intent looks like code review or risk assessment.',
    patterns: [
      /\breview\b/i,
      /\baudit\b/i,
      /审查|评审|检查风险|代码审查/,
      /\bcheck (for )?(regressions|risks|issues)\b/i,
    ],
  },
  {
    kind: 'plan',
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
    kind: 'explore',
    reason: 'User intent looks like codebase exploration or discovery.',
    patterns: [
      /\bexplore\b/i,
      /\binvestigate\b/i,
      /\bresearch\b/i,
      /\bsurvey\b/i,
      /\bfind where\b/i,
      /\bhow does\b/i,
      /\bhow is\b.+\bimplement/i,
      /\bunderstand\b/i,
      /\btrace\b/i,
      /\bmap (the )?(codebase|project|architecture)\b/i,
      /探索|调查|调研|摸清|架构|在哪里|怎么实现|梳理|解释/,
    ],
  },
];

const CODING_INTENT_RULE: IntentPatternRule = {
  kind: 'coding',
  patterns: [
    /\bimplement\b/i,
    /\bfix\b/i,
    /\brefactor\b/i,
    /\badd\b.+\b(feature|endpoint|api|component|test)\b/i,
    /\bwrite\b.+\b(code|test|tests)\b/i,
    /\bpatch\b/i,
    /\bbug\b/i,
    /\bbuild\b/i,
    /\bcreate\b.+\b(file|module|class|function)\b/i,
    /\bupdate\b.+\b(code|logic|handler)\b/i,
    /\bchange\b.+\b(code|implementation)\b/i,
    /实现.+(功能|模块|接口|逻辑)|修复|重构|编码|改代码|添加功能|写测试|补丁|修改.+(代码|会话|组件|接口|逻辑)|隐藏.+(子会话|列表)/,
  ],
};

const INTENT_CLASSIFICATION_ORDER: IntentPatternRule[] = [
  CODING_INTENT_RULE,
  ...SYNAX_VARIANT_INTENT_RULES.map((rule) => ({ kind: rule.kind, patterns: rule.patterns })),
];

const CONVERSATIONAL_RE = /^(你好|您好|嗨|谢谢|感谢|好的|ok|okay|hi|hello|hey|thanks|thank you|bye|再见)[!.?\s]*$/i;
const SHORT_MESSAGE_MAX = 20;

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifySynaxIntent(message: string): SynaxIntentKind | null {
  const text = message.trim();
  if (!text) return null;
  // Mentioning an operation while asking how it works is not permission to perform it.
  const asksForExplanation = /^(?:how\b|why\b|what\b|explain\b|(?:请)?(?:解释|调查|调研|分析)|为什么|如何)/i.test(text)
    || /(?:plan|计划)\s*模式.*[吗？?]/i.test(text);
  const alsoRequestsChange = /(?:and|then)\s+(?:fix|implement|change|add|refactor)|(?:并|然后|顺便)(?:且)?(?:修复|实现|修改|添加|重构)/i.test(text);
  if (asksForExplanation && !alsoRequestsChange) return 'explore';

  for (const rule of INTENT_CLASSIFICATION_ORDER) {
    if (matchesAny(text, rule.patterns)) {
      return rule.kind;
    }
  }
  return null;
}

export function isConversationalMessage(message: string): boolean {
  const text = message.trim();
  if (!text) return true;
  if (CONVERSATIONAL_RE.test(text)) return true;
  if (text.length <= SHORT_MESSAGE_MAX && classifySynaxIntent(text) === null) return true;
  return false;
}

export function shouldApplyCodingHints(input: SynaxIntentHintInput, intent: SynaxIntentKind | null): boolean {
  return input.mode !== 'plan' && intent === 'coding';
}

/** A classification is an advisory focus, never an execution or delegation mandate. */
export function buildSynaxIntentPromptSection(input: SynaxIntentHintInput): string | null {
  const intent = classifySynaxIntent(input.message);
  if (!intent) return null;
  const focus = {
    explore: 'Investigate and explain; do not implement changes unless the user also requests them.',
    coding: input.mode === 'plan' ? 'Design the requested change without implementing it.' : 'Implement the requested change within current authorization; inspect and verify the affected behavior.',
    review: 'Report actionable findings with file references; do not change code merely to perform a review.',
    plan: 'Produce a decision-complete proposal proportional to the task; planning alone is not execution authorization.',
  }[intent];
  return `## Request focus\n${focus}\nThis routing hint is advisory; the actual user request and runtime mode take precedence.`;
}
