import type { ModelMessage, ToolResultOutput } from '@ai-sdk/provider-utils';
import type { ToolCallRecord } from './contracts.js';
import type { LoopToolSet } from './loop-ai-tools.js';
import type { AgentRuntimeStore } from './session-store.js';
import { makeRuntimeId } from './runtime-ids.js';

const MAX_TOOL_OUTPUT_TEXT = 12_000;

export function buildLoopModelMessages(
  store: AgentRuntimeStore,
  sessionId: string,
  toolSet: Pick<LoopToolSet, 'resolveModelToolName'>,
  compactionSummary?: string | null,
): ModelMessage[] {
  const userMessages = store.listMessages(sessionId).filter((message) => message.role === 'user');
  const runsByTrigger = new Map(
    store
      .listRuns(sessionId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map((run) => [run.triggerMessageId, run] as const),
  );

  const messages: ModelMessage[] = [];

  if (compactionSummary) {
    messages.push({
      role: 'user',
      content: `<context-summary>\n[Previous conversation summary - compressed to save context]\n${compactionSummary}\n</context-summary>`,
    });
  }

  for (const userMessage of userMessages) {
    messages.push({
      role: 'user',
      content: userMessage.content,
    });

    const run = runsByTrigger.get(userMessage.id);
    if (!run) continue;
    messages.push(...buildRunMessages(store, run.id, toolSet));
  }
  return messages;
}

function buildRunMessages(
  store: AgentRuntimeStore,
  runId: string,
  toolSet: Pick<LoopToolSet, 'resolveModelToolName'>,
): ModelMessage[] {
  const steps = store.listRunSteps(runId);
  const toolCalls = store.listRunToolCalls(runId);
  const toolCallsById = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall] as const));
  const messages: ModelMessage[] = [];

  for (const step of steps) {
    const stepParts = store.listRunParts(step.id);
    const assistantContent: NonNullable<Extract<ModelMessage, { role: 'assistant' }>['content']> = [];

    for (const part of stepParts) {
      if (part.kind === 'thought' && part.content.trim()) {
        assistantContent.push({ type: 'reasoning', text: part.content });
      }
      if (part.kind === 'text' && part.content.trim()) {
        assistantContent.push({ type: 'text', text: part.content });
      }
      if (part.kind === 'tool_call' && part.toolCallId) {
        const record = toolCallsById.get(part.toolCallId);
        if (!record) continue;
        assistantContent.push({
          type: 'tool-call',
          toolCallId: normalizeToolCallId(record.modelToolCallId ?? record.id),
          toolName: toolSet.resolveModelToolName(record.toolId) ?? record.toolId,
          input: record.inputRef ?? {},
        });
      }
    }

    if (assistantContent.length > 0) {
      messages.push({
        role: 'assistant',
        content: assistantContent,
      });
    }

    const toolResults = orderedStepToolCalls(stepParts, toolCallsById).map((record) => {
      return {
        type: 'tool-result' as const,
        toolCallId: normalizeToolCallId(record.modelToolCallId ?? record.id),
        toolName: toolSet.resolveModelToolName(record.toolId) ?? record.toolId,
        output: toToolResultOutput(record),
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
    return {
      type: 'json',
      value: record.outputRef as never,
    };
  }

  return {
    type: 'text',
    value: trimToolText(record.outputSummary ?? ''),
  };
}

function trimToolText(value: string): string {
  return value.length > MAX_TOOL_OUTPUT_TEXT ? `${value.slice(0, MAX_TOOL_OUTPUT_TEXT)}…` : value;
}

function normalizeToolCallId(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return makeRuntimeId('mtc');
}
