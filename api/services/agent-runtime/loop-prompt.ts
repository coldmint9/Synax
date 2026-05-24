import type {
  AgentContextBundle,
  AgentProfile,
  AgentRunPart,
  AgentRuntimeMessage,
  LoopModelStep,
  ToolCallRecord,
} from './contracts.js';

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
}

export function buildLoopSystemPrompt(input: BuildLoopPromptInput): string {
  const blocks = input.context?.blocks
    .map((block) => `## ${block.title}\n${block.content}`)
    .join('\n\n') ?? 'No context bundle is attached.';
  const warnings = input.context?.warnings.length ? `\n\nContext warnings:\n${input.context.warnings.join('\n')}` : '';
  const loopHints = input.profile.loopHints?.length ? `\nLoop hints:\n${input.profile.loopHints.join('\n')}` : '';
  return [
    `You are the Synapse ${input.profile.label} runtime agent.`,
    `Profile kind: ${input.profile.kind}. Runtime mode: ${input.profile.mode}. Thinking mode: ${input.profile.defaultThinkingMode}.`,
    `Allowed capabilities: ${input.profile.allowedCapabilities.join(', ') || 'none'}.`,
    `You are in a step-based tool loop. Maximum steps for this run: ${input.maxSteps}. Current step index: ${input.stepIndex}.`,
    'Produce one response per turn. You may include multiple tool calls in a single response when they are independent of each other.',
    input.mustFinalize ? 'This is the final allowed step. You MUST submit your output now using the appropriate submit tool, or provide a textual summary if no submit tool is available.' : '',
    'If the task is complete, answer in plain text. Plain text ends the run.',
    'If more information or action is needed, use the provided tool-call interface instead of writing a tool request as prose.',
    input.profile.toolPolicy?.allowParallelReadTools
      ? `You may call multiple read-only tools in a single step (up to ${input.profile.toolPolicy.maxParallelReadTools ?? 4} parallel reads). Batch file reads together to minimize round trips.`
      : '',
    'Compatibility fallback only when native tool calling is unavailable: start the response with exactly {"tool":"tool.id","args":{...}} followed by optional short status text.',
    'Never request shell or external execution. Use only the provided tools.',
    'When proposing file changes, prefer specific file paths and bounded edits.',
    loopHints,
    input.disclosureHint ?? '',
    '',
    '[Synapse Context]',
    blocks,
    warnings,
  ]
    .filter(Boolean)
    .join('\n');
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
