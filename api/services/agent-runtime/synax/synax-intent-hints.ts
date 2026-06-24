import type { SynaxSessionMode } from './synax-session-mode.js';
import { isGoalLikeMode } from './synax-session-mode.js';
import { EXPLORER_WIKI_PLAYBOOK } from './synax-explorer-delegate.js';

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
      /探索|调研|摸清|架构|在哪里|怎么实现|梳理/,
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
    /实现.+(功能|模块|接口|逻辑)|修复|重构|编码|改代码|添加功能|写测试|补丁/,
  ],
};

const INTENT_CLASSIFICATION_ORDER: IntentPatternRule[] = [
  CODING_INTENT_RULE,
  ...SYNAX_VARIANT_INTENT_RULES.map((rule) => ({ kind: rule.kind, patterns: rule.patterns })),
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifySynaxIntent(message: string): SynaxIntentKind | null {
  const text = message.trim();
  if (!text) return null;

  for (const rule of INTENT_CLASSIFICATION_ORDER) {
    if (matchesAny(text, rule.patterns)) {
      return rule.kind;
    }
  }
  return null;
}

function buildExploreIntentSection(stepIndex: number): string {
  const firstStep = stepIndex <= 1;
  const lines = [
    '## Exploration Intent',
    'The user wants discovery/research — not implementation. The parent agent orchestrates; exploration runs in a child session.',
    '- Delegate via subagent.delegate(profileId: "explorer", prompt: "<pass the user question verbatim plus any focus constraints>").',
    '- The explorer child is wiki-first: it will run wiki FTS/search, read wiki sections, then code tools for evidence.',
    '- Do NOT call bash, wiki.*, file.read, grep.search, or file.glob on the parent for this exploration — only subagent.delegate.',
    '- After the child returns, synthesize its report for the user. Re-delegate only for a clearly new sub-question.',
    '',
    'Explorer child playbook (for reference — injected automatically into the delegate prompt):',
    EXPLORER_WIKI_PLAYBOOK,
  ];
  if (firstStep) {
    lines.push('', 'Step 1 rule: your first and only tool call must be subagent.delegate to explorer unless the answer is already complete in context.');
  }
  return lines.join('\n');
}

function buildCodingIntentSection(): string {
  return [
    '## Coding Task Role',
    'You are implementing bounded code changes in this repository.',
    '- Clarify scope, read relevant code first, then edit.',
    '- Keep changes minimal and verifiable; avoid unrelated refactors.',
    '',
    '## Task Breakdown',
    '- For 2+ steps, call task.create early and keep task.update current.',
    '- One logical change per step; read/search before write.',
    '- file.write and file.patch on existing files require file.read first (enforced by runtime).',
    '',
    '## Coding Style',
    '- Match naming, patterns, and formatting of touched files.',
    '- Prefer file.patch for surgical edits; avoid drive-by cleanup.',
    '- Reuse existing abstractions; do not introduce new layers without need.',
    '',
    '## Test & Verification',
    '- Run the narrowest relevant test command after edits (e.g. vitest for a single file, npm test when appropriate).',
    '- Run typecheck/lint when the project uses them and your change could break types.',
    '- If tests cannot run, state why and what manual check you performed.',
    '',
    '## File Change Summary',
    '- When finishing or pausing, list every file touched with a one-line reason each.',
    '- Mention any follow-up the user should do (migrations, env vars, manual QA).',
  ].join('\n');
}

function shouldApplyCodingHints(input: SynaxIntentHintInput, intent: SynaxIntentKind | null): boolean {
  if (intent === 'coding') return true;
  if (intent === 'explore' || intent === 'review' || intent === 'plan') return false;
  return isGoalLikeMode(input.mode);
}

export function buildSynaxIntentPromptSection(input: SynaxIntentHintInput): string | null {
  const message = input.message.trim();
  if (!message) return null;

  const intent = classifySynaxIntent(message);
  const stepIndex = input.stepIndex ?? 1;
  const sections: string[] = [];

  if (intent === 'explore') {
    sections.push(buildExploreIntentSection(stepIndex));
  }

  if (shouldApplyCodingHints(input, intent)) {
    sections.push(buildCodingIntentSection());
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}
