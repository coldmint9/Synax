import type {
  AgentContextBundle,
  AgentProfile,
  AgentRunPart,
  AgentRuntimeMessage,
  LoopModelStep,
  PermissionTier,
  ToolCallRecord,
} from './contracts.js';
import { buildLanguageDirective } from '../prompts/language-directive.js';
import { buildPermissionSection } from './prompt-permission-section.js';

interface BuildLoopPromptInput {
  profile: AgentProfile;
  context: AgentContextBundle | null;
  history: AgentRuntimeMessage[];
  previousParts: AgentRunPart[];
  previousToolCalls: ToolCallRecord[];
  currentPrompt: string;
  maxSteps: number;
  stepIndex: number;
  mustFinalize?: boolean;
  /** Skill summaries (id, label, description) for on-demand skill.load. */
  skillsSection?: string | null;
  /** Synax session mode prompt section when profileId is synax. */
  modePromptSection?: string | null;
  /** Synax active variant prompt section. */
  variantPromptSection?: string | null;
  /** Synax intent-specific prompt section (explore delegate, coding discipline). */
  intentPromptSection?: string | null;
  /** Override profile loop hints (Synax variant overlay). */
  loopHintsOverride?: string[] | null;
  /** Relevant project memories (L2) for this turn. */
  projectMemoriesSection?: string | null;
  /** SYNAX.md / CLAUDE.md / AGENTS.md merged for the rules section. */
  projectRulesSection?: string | null;
  /** Resolved permission tier for this session turn. */
  permissionTier?: PermissionTier;
  /** If set, a language output directive is prepended to the system prompt. */
  locale?: 'zh' | 'en';
  /** Include JSON tool-call fallback instructions (legacy / non-native tool paths). */
  includeToolCallFallback?: boolean;
}

export function buildCoreLoopSection(profile: AgentProfile): string {
  const lines = [
    `You are the ${profile.label}.`,
    `Profile kind: ${profile.kind}. Runtime mode: ${profile.mode}. Thinking mode: ${profile.defaultThinkingMode}.`,
    `Allowed capabilities: ${profile.allowedCapabilities.join(', ') || 'none'}.`,
    '',
    'You are in a step-based tool loop.',
    'Produce one response per turn. You may include multiple tool calls in a single response when they are independent of each other.',
    'If the task is complete, answer in plain text. Plain text ends the run.',
    'If more information or action is needed, use the provided tool-call interface instead of writing a tool request as prose.',
    '',
    'Parallel tool calls in one step run concurrently. Batch independent reads and searches together to minimize round trips.',
    'Do not parallelize a write with a read whose result the write depends on — call the read in one step, then write in the next step.',
    'When overwriting an existing file with file.write or edit, you must file.read that file first in this session.',
    'When proposing file changes, prefer specific file paths and bounded edits.',
    '',
    'Tool choice:',
    '- Prefer dedicated read tools: grep.search, file.glob, file.list, file.read, diff.read (read gate, usually allowed).',
    '- Use bash only for compound read-only pipelines that dedicated tools cannot express; bash uses the shell gate and may require user approval.',
    '- For exploration intent or explorer variant on the parent agent: do not search yourself — delegate via subagent.delegate(profileId: "explorer").',
  ];

  if (profile.allowedCapabilities.includes('task.create')) {
    lines.push(
      '',
      'Session TODO tracking: For work with 2+ steps, call task.create early to build a visible task list for the user.',
      'Mark progress with task.update (pending → in_progress → completed). Review with task.list.',
      'task.create/update track session todos — they are not subagent.delegate (child agent sessions).',
    );
  }

  return lines.join('\n');
}

function buildLoopHintsSection(hints: string[] | null | undefined): string {
  if (!hints?.length) return '';
  return ['Loop hints:', ...hints].join('\n');
}

function shouldIncludeContextWarnings(): boolean {
  return process.env.SYNAX_DEBUG_PROMPT === '1';
}

export function buildLoopSystemPrompt(input: BuildLoopPromptInput): string {
  const directive = input.locale ? buildLanguageDirective(input.locale) : '';
  const blocks = input.context?.blocks
    .map((block) => `## ${block.title}\n${block.content}`)
    .join('\n\n') ?? 'No context bundle is attached.';
  const warnings = shouldIncludeContextWarnings() && input.context?.warnings.length
    ? `\n\nContext warnings:\n${input.context.warnings.join('\n')}`
    : '';
  const loopHints = buildLoopHintsSection(input.loopHintsOverride ?? input.profile.loopHints);
  const permissionSection = buildPermissionSection({
    permissionTier: input.permissionTier,
    profileDefaults: input.profile.permissionDefaults,
  });
  const fallbackLine = input.includeToolCallFallback
    ? 'Only if the runtime reports native tool calling is unavailable: start the response with exactly {"tool":"tool.id","args":{...}} followed by optional short status text.'
    : '';

  return [
    directive,
    buildCoreLoopSection(input.profile),
    fallbackLine,
    permissionSection,
    input.modePromptSection ? `\n${input.modePromptSection}` : '',
    input.intentPromptSection ? `\n${input.intentPromptSection}` : '',
    input.variantPromptSection ? `\n${input.variantPromptSection}` : '',
    loopHints,
    input.projectMemoriesSection ? `\n${input.projectMemoriesSection}` : '',
    input.skillsSection ? `\n${input.skillsSection}` : '',
    input.projectRulesSection
      ? `[Project Rules]\nFollow these repository instruction files:\n\n${input.projectRulesSection}`
      : '',
    '',
    '[Synax Context]',
    blocks,
    warnings,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildLoopStepNote(input: Pick<BuildLoopPromptInput, 'stepIndex' | 'maxSteps' | 'mustFinalize'>): string {
  const parts = [
    `[Step ${input.stepIndex}/${input.maxSteps}]`,
  ];
  if (input.mustFinalize) {
    parts.push('This is the final allowed step. You MUST submit your output now using the appropriate submit tool, or provide a textual summary if no submit tool is available.');
  }
  return parts.join(' ');
}

export function buildLoopUserPrompt(input: BuildLoopPromptInput): string {
  const transcript = summarizePreviousStep(input.previousParts);
  const toolHistory = summarizeToolCalls(input.previousToolCalls);
  const conversation = input.history
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join('\n\n');
  return [
    `Primary task:\n${input.currentPrompt}`,
    input.mustFinalize ? '\nThis response must finish the run now with a textual summary only.' : '',
    conversation ? `\nConversation history:\n${conversation}` : '',
    transcript ? `\nPrevious step transcript:\n${transcript}` : '',
    toolHistory ? `\nTool results available:\n${toolHistory}` : '',
    '\nRespond with one turn. Include multiple tool calls if needed.',
  ]
    .filter(Boolean)
    .join('\n');
}

function summarizePreviousStep(parts: AgentRunPart[]): string {
  if (parts.length === 0) return '';
  return parts
    .map((part) => `${part.kind}: ${part.content}`)
    .slice(-12)
    .join('\n');
}

function summarizeToolCalls(calls: ToolCallRecord[]): string {
  if (calls.length === 0) return '';
  return calls
    .map((call) => {
      const summary = call.outputSummary ?? call.error ?? call.inputSummary;
      return `${call.toolId} [${call.status}]: ${summary}`;
    })
    .slice(-12)
    .join('\n');
}

export function summarizeLoopStep(step: LoopModelStep): string {
  const pieces = [
    step.thought?.trim(),
    step.message?.trim(),
    step.toolCalls.length > 0
      ? `tools: ${step.toolCalls.map((toolCall) => `${toolCall.toolId}(${JSON.stringify(toolCall.args)})`).join(', ')}`
      : '',
  ].filter(Boolean);
  return pieces.join(' | ') || 'Loop step';
}
