import type { ModelMessage, ToolResultOutput } from '@ai-sdk/provider-utils';
import type { ToolCallRecord } from './contracts.js';
import type { LoopToolSet } from './loop-ai-tools.js';
import type { AgentRuntimeStore } from './session-store.js';
import { makeRuntimeId } from './runtime-ids.js';

const MAX_TOOL_OUTPUT_TEXT = 12_000;
const MAX_TOOL_OUTPUT_JSON = 12_000;
const MAX_TOOL_INPUT_JSON = 4_000;

export interface ClearingOptions {
  priorInputTokens: number | null;
  contextLimit: number;
  threshold: number;
  keepRecent: number;
  excludeTools: string[];
  forceActivated?: boolean;
}

export interface BuildMessagesOptions {
  compactionSummary?: string | null;
  initialUserMessage?: { original: string; content: string };
  workId?: string;
  excludedStepIds?: Set<string>;
  clearing?: ClearingOptions;
}

export function buildLoopModelMessages(
  store: AgentRuntimeStore,
  sessionId: string,
  toolSet: Pick<LoopToolSet, 'resolveModelToolName'>,
  opts?: BuildMessagesOptions | string | null,
): ModelMessage[] {
  const options: BuildMessagesOptions = typeof opts === 'string' || opts === null || opts === undefined
    ? { compactionSummary: opts ?? undefined }
    : opts;

  const userMessages = store.listMessages(sessionId).filter((message) => message.role === 'user');
  const runsByTrigger = new Map(
    store
      .listRuns(sessionId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map((run) => [run.triggerMessageId, run] as const),
  );

  const clearSet = buildClearSet(store, sessionId, options.clearing);

  const messages: ModelMessage[] = [];

  if (options.compactionSummary) {
    messages.push({
      role: 'user',
      content: `<context-summary>\n[Previous conversation summary - compressed to save context]\n${options.compactionSummary}\n</context-summary>`,
    });
  }

  for (const userMessage of userMessages) {
    const run = runsByTrigger.get(userMessage.id);
    if (options.workId && run?.metadata.workId !== options.workId && !(run && store.listRunSteps(run.id).some(s => s.metadata?.workId === options.workId))) continue;
    const steps = run ? store.listRunSteps(run.id) : [];
    if (steps.length && steps.every(step => options.excludedStepIds?.has(step.id))) continue;
    messages.push({ role: 'user', content: userMessage.metadata?.source === 'system_injection' && userMessage.content.trim() === options.initialUserMessage?.original ? options.initialUserMessage.content : userMessage.content });
    if (!run) continue;
    messages.push(...buildRunMessages(store, run.id, toolSet, clearSet, options.excludedStepIds));
  }

  return messages;
}

function buildRunMessages(
  store: AgentRuntimeStore,
  runId: string,
  toolSet: Pick<LoopToolSet, 'resolveModelToolName'>,
  clearSet: Set<string> | null,
  excludedStepIds?: Set<string>,
): ModelMessage[] {
  const steps = store.listRunSteps(runId);
  const toolCalls = store.listRunToolCalls(runId);
  const toolCallsById = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall] as const));
  const messages: ModelMessage[] = [];

  for (const step of steps) {
    if (excludedStepIds?.has(step.id)) continue;
    const stepParts = store.listRunParts(step.id);
    const assistantContent: NonNullable<Extract<ModelMessage, { role: 'assistant' }>['content']> = [];
    const emittedToolCallIds = new Set<string>();
    const reasoningParts = step.metadata?.reasoningParts as Array<{ text: string; providerMetadata?: Record<string, Record<string, unknown>> }> | undefined;
    if (reasoningParts?.length && !stepParts.some(p => p.kind === 'thought' && p.content.trim())) {
      for (const segment of reasoningParts) assistantContent.push({ type: 'reasoning', text: segment.text, providerOptions: segment.providerMetadata as never });
    }

    for (const part of stepParts) {
      if (part.kind === 'thought' && part.content.trim()) {
        const reasoning = step.metadata?.reasoningParts as Array<{ text: string; providerMetadata?: Record<string, Record<string, unknown>> }> | undefined;
        if (reasoning?.length) {
          for (const segment of reasoning) assistantContent.push({ type: 'reasoning', text: segment.text, providerOptions: segment.providerMetadata as never });
        } else assistantContent.push({ type: 'reasoning', text: part.content });
      }
      if (part.kind === 'text' && part.content.trim()) {
        assistantContent.push({ type: 'text', text: part.content });
      }
      if (part.kind === 'tool_call' && part.toolCallId) {
        const record = toolCallsById.get(part.toolCallId);
        if (!record) continue;
        const toolCallId = normalizeToolCallId(record.modelToolCallId ?? record.id);
        emittedToolCallIds.add(toolCallId);
        assistantContent.push({
          type: 'tool-call',
          toolCallId,
          toolName: toolSet.resolveModelToolName(record.toolId) ?? sanitizeToolName(record.toolId),
          input: toToolCallInput(record, clearSet),
          providerOptions: (step.metadata?.toolCallProviderMetadata as Record<string, never> | undefined)?.[record.modelToolCallId ?? record.id],
        });
      }
    }

    if (assistantContent.length > 0) {
      messages.push({
        role: 'assistant',
        content: assistantContent,
      });
    }

    const toolResults = orderedStepToolCalls(stepParts, toolCallsById)
      .filter((record) => {
        const id = normalizeToolCallId(record.modelToolCallId ?? record.id);
        return emittedToolCallIds.has(id);
      })
      .map((record) => {
        const shouldClear = clearSet !== null && clearSet.has(record.id);
        return {
          type: 'tool-result' as const,
          toolCallId: normalizeToolCallId(record.modelToolCallId ?? record.id),
          toolName: toolSet.resolveModelToolName(record.toolId) ?? sanitizeToolName(record.toolId),
          output: shouldClear ? toClearedOutput(record) : toToolResultOutput(record),
        };
      });

    if (toolResults.length > 0) {
      messages.push({
        role: 'tool',
        content: toolResults,
      });
    }
  }

  return messages;
}

function orderedStepToolCalls(stepParts: ReturnType<AgentRuntimeStore['listRunParts']>, toolCallsById: Map<string, ToolCallRecord>): ToolCallRecord[] {
  const ordered = stepParts
    .filter((part) => part.kind === 'tool_call' && part.toolCallId)
    .map((part) => toolCallsById.get(part.toolCallId!))
    .filter((toolCall): toolCall is ToolCallRecord => Boolean(toolCall));

  const knownIds = new Set(ordered.map((toolCall) => toolCall.id));
  for (const toolCall of toolCallsById.values()) {
    if (toolCall.stepId && stepParts.some((part) => part.stepId === toolCall.stepId) && !knownIds.has(toolCall.id)) {
      ordered.push(toolCall);
    }
  }
  return ordered;
}

function toToolResultOutput(record: ToolCallRecord): ToolResultOutput {
  if (record.status === 'denied') {
    return {
      type: 'execution-denied',
      reason: record.error ?? record.outputSummary ?? 'Tool execution was denied.',
    };
  }

  if (record.status === 'failed' || record.status === 'cancelled' || record.status === 'pending' || record.status === 'running') {
    return {
      type: 'error-text',
      value: record.error ?? 'Tool execution did not complete.',
    };
  }

  if (typeof record.outputRef === 'string') {
    return {
      type: 'text',
      value: trimToolText(record.outputRef),
    };
  }

  if (record.outputRef !== null && record.outputRef !== undefined) {
    const serialized = JSON.stringify(record.outputRef);
    if (serialized.length <= MAX_TOOL_OUTPUT_JSON) {
      return { type: 'json', value: record.outputRef as never };
    }
    return { type: 'text', value: trimToolText(serialized) };
  }

  return {
    type: 'text',
    value: trimToolText(record.outputSummary ?? ''),
  };
}

function trimToolText(value: string): string {
  return value.length > MAX_TOOL_OUTPUT_TEXT ? `${value.slice(0, MAX_TOOL_OUTPUT_TEXT)}…` : value;
}

function toToolCallInput(
  record: ToolCallRecord,
  clearSet: Set<string> | null,
): Record<string, unknown> {
  const input = record.inputRef;
  if (input === null || input === undefined) return {};

  const asObject = input as Record<string, unknown>;
  const serialized = JSON.stringify(input);
  const inClearSet = clearSet !== null && clearSet.has(record.id);

  if (!inClearSet && serialized.length <= MAX_TOOL_INPUT_JSON) return asObject;

  return summarizeToolInput(asObject, record);
}

function summarizeToolInput(
  input: Record<string, unknown>,
  record: ToolCallRecord,
): Record<string, unknown> {
  const summary: Record<string, unknown> = { _truncated: true };
  if (record.inputSummary) summary.summary = record.inputSummary;

  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      summary[key] = `[${value.length} items]`;
    } else if (typeof value === 'string' && value.length <= 100) {
      summary[key] = value;
    } else if (typeof value === 'string') {
      summary[key] = value.slice(0, 100) + '…';
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      summary[key] = value;
    }
  }

  return summary;
}

function sanitizeToolName(toolId: string): string {
  return toolId.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_') || 'tool';
}

function normalizeToolCallId(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return makeRuntimeId('mtc');
}

/**
 * Compute the set of tool call IDs whose output has been cleared from context.
 * Exported so that dedup logic can skip cleared calls (they should be re-executed).
 */
export function computeClearedToolCallIds(
  store: AgentRuntimeStore,
  sessionId: string,
  clearing?: ClearingOptions,
): Set<string> | null {
  return buildClearSet(store, sessionId, clearing);
}

function buildClearSet(
  store: AgentRuntimeStore,
  sessionId: string,
  clearing?: ClearingOptions,
): Set<string> | null {
  if (!clearing) return null;
  const activated = clearing.forceActivated ||
    (!!clearing.priorInputTokens && clearing.priorInputTokens > clearing.contextLimit * clearing.threshold);
  if (!activated) return null;

  const excludeSet = new Set(clearing.excludeTools);
  const allToolCalls: ToolCallRecord[] = [];
  const runs = store.listRuns(sessionId);
  for (const run of runs) {
    const calls = store.listRunToolCalls(run.id);
    allToolCalls.push(...calls);
  }

  const clearable = allToolCalls.filter(
    (tc) => tc.status === 'completed' || tc.status === 'compacted',
  ).filter(
    (tc) => !excludeSet.has(tc.toolId),
  );

  if (clearable.length <= clearing.keepRecent) return null;

  const toClear = clearable.slice(0, clearable.length - clearing.keepRecent);
  return new Set(toClear.map((tc) => tc.id));
}

function toClearedOutput(record: ToolCallRecord): ToolResultOutput {
  const summary = record.outputSummary ?? '';
  return {
    type: 'text',
    value: `[Earlier ${record.toolId} result cleared — re-run if needed.${summary ? ` Summary: ${summary}` : ''}]`,
  };
}
