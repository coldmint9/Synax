import type {
  AgentContextBundle,
  AgentProfile,
  AgentRunPart,
  AgentRuntimeMessage,
  LoopModelStep,
  ToolCallRecord,
} from './contracts.js';
import { buildLanguageDirective } from '../prompts/language-directive.js';

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
  disclosureHint?: string;
  /** Hint shown when fallback tools are disclosed after bash failures. */
  fallbackHint?: string;
  /** Synax session mode prompt section when profileId is synax. */
  modePromptSection?: string | null;
  /** Synax active variant prompt section. */
  variantPromptSection?: string | null;
  /** Override profile loop hints (Synax variant overlay). */
  loopHintsOverride?: string[] | null;
  /** If set, a language output directive is prepended to the system prompt. */
  locale?: 'zh' | 'en';
}

export function buildLoopSystemPrompt(input: BuildLoopPromptInput): string {
  const directive = input.locale ? buildLanguageDirective(input.locale) : '';
  const blocks = input.context?.blocks
    .map((block) => `## ${block.title}\n${block.content}`)
    .join('\n\n') ?? 'No context bundle is attached.';
  const warnings = input.context?.warnings.length ? `\n\nContext warnings:\n${input.context.warnings.join('\n')}` : '';
  const loopHints = (input.loopHintsOverride ?? input.profile.loopHints)?.length
    ? `\nLoop hints:\n${(input.loopHintsOverride ?? input.profile.loopHints)!.join('\n')}`
    : '';
  return [
    directive,
    `You are the Synax ${input.profile.label} runtime agent.`,
    `Profile kind: ${input.profile.kind}. Runtime mode: ${input.profile.mode}. Thinking mode: ${input.profile.defaultThinkingMode}.`,
    `Allowed capabilities: ${input.profile.allowedCapabilities.join(', ') || 'none'}.`,
    'You are in a step-based tool loop.',
    'Produce one response per turn. You may include multiple tool calls in a single response when they are independent of each other.',
    'If the task is complete, answer in plain text. Plain text ends the run.',
    'If more information or action is needed, use the provided tool-call interface instead of writing a tool request as prose.',
    'You may call multiple tools in a single step. All tool calls within a step execute in parallel. ' +
    'Batch independent reads, writes, and searches together to minimize round trips. ' +
    'If a write depends on a read result, call the read tool first, receive the result, then call the write tool in the next step.',
    'Compatibility fallback only when native tool calling is unavailable: start the response with exactly {"tool":"tool.id","args":{...}} followed by optional short status text.',
    'Prefer the bash tool for file search, listing, and text inspection. It accepts read-only Unix commands (rg, grep, find, ls, cat, head, tail, wc, sort, uniq, sed, awk, git diff/log/show, etc.) and supports pipes and command chaining. Combine multiple operations into a single bash call to reduce round trips.',
    input.fallbackHint ?? '',
    'When proposing file changes, prefer specific file paths and bounded edits.',
    loopHints,
    input.modePromptSection ? `\n${input.modePromptSection}` : '',
    input.variantPromptSection ? `\n${input.variantPromptSection}` : '',
    input.disclosureHint ?? '',
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
