import { createGatewayStream } from '../llm-runtime/stream.js';
import type { LlmGatewayRequest } from '../llm-runtime/types.js';
import type { LlmHookContext } from '../llm-runtime/llm-hooks.js';
import type { LoopModelStreamEvent, LoopStepModelResult, StructuredToolCall } from './contracts.js';
import type { LoopToolSet } from './loop-ai-tools.js';
import { isRecord, parseLoopModelStepText } from './loop-model-output.js';
import { makeRuntimeId } from './runtime-ids.js';

export interface GenerateLoopModelStepInput {
  request: LlmGatewayRequest;
  tools: LoopToolSet;
  mustFinalize: boolean;
  model: string | null;
  abortSignal?: AbortSignal;
  hookContext?: LlmHookContext;
}

export async function generateLoopModelStep(input: GenerateLoopModelStepInput): Promise<LoopStepModelResult> {
  const finalizeSubmitTools = input.mustFinalize
    ? input.tools.activeTools.filter(t => t.includes('submit'))
    : null;
  const hasTools = finalizeSubmitTools
    ? finalizeSubmitTools.length > 0
    : input.tools.activeTools.length > 0;
  const activeTools = finalizeSubmitTools ?? input.tools.activeTools;
  const result = await createGatewayStream(
    {
      ...input.request,
      tools: hasTools ? input.tools.tools : undefined,
      activeTools: hasTools ? activeTools : undefined,
      toolChoice: hasTools ? 'auto' : 'none',
      repairToolCall: hasTools ? input.tools.repairToolCall : undefined,
      maxRetries: 2,
      hookContext: input.hookContext,
    },
    input.abortSignal,
  );

  let text = '';
  let thought = '';
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | undefined;
  let providerMetadata: Record<string, unknown> | undefined;
  const toolCalls: StructuredToolCall[] = [];

  for await (const event of result.fullStream) {
    switch (event.type) {
      case 'text-delta':
        text += event.text;
        break;
      case 'reasoning-delta':
        thought += event.text;
        break;
      case 'tool-call': {
        const toolId = input.tools.resolveToolId(event.toolName) ?? event.toolName;
        toolCalls.push({
          id: normalizeToolCallId(event.toolCallId),
          toolId,
          args: isRecord(event.input) ? event.input : {},
        });
        break;
      }
      case 'finish-step':
        finishReason = event.finishReason;
        usage = isRecord(event.usage) ? event.usage : usage;
        providerMetadata = isRecord(event.providerMetadata) ? event.providerMetadata : providerMetadata;
        break;
      case 'finish':
        finishReason ??= event.finishReason;
        usage ??= isRecord(event.totalUsage) ? event.totalUsage : undefined;
        break;
      case 'error':
        throw event.error;
      default:
        break;
    }
  }

  const message = text.trim() || undefined;
  const deduplicatedToolCalls = deduplicateToolCalls(toolCalls);
  const parsedFallback = !input.mustFinalize && deduplicatedToolCalls.length === 0 && message
    ? parseLoopModelStepText(message, false)
    : null;
  const rawFinalToolCalls = input.mustFinalize
    ? []
    : parsedFallback?.toolCalls.length
      ? parsedFallback.toolCalls
      : deduplicatedToolCalls;
  const finalToolCalls = rawFinalToolCalls.filter(c => !c.toolId.includes('multi_tool_use'));
  const finalMessage = parsedFallback?.toolCalls.length ? parsedFallback.message : message;

  return {
    model: input.model,
    step: {
      thought: thought.trim() || undefined,
      message: finalMessage,
      toolCalls: finalToolCalls,
      final: input.mustFinalize || finalToolCalls.length === 0,
      stopReason: input.mustFinalize ? 'max_steps' : null,
      finishReason: input.mustFinalize ? 'max_steps' : (parsedFallback?.finishReason ?? finishReason ?? null),
      usage,
      providerMetadata,
    },
  };
}

export async function* streamLoopModelStep(
  input: GenerateLoopModelStepInput,
): AsyncGenerator<LoopModelStreamEvent> {
  const finalizeSubmitTools = input.mustFinalize
    ? input.tools.activeTools.filter(t => t.includes('submit'))
    : null;
  const hasTools = finalizeSubmitTools
    ? finalizeSubmitTools.length > 0
    : input.tools.activeTools.length > 0;
  const activeTools = finalizeSubmitTools ?? input.tools.activeTools;
  const result = await createGatewayStream(
    {
      ...input.request,
      tools: hasTools ? input.tools.tools : undefined,
      activeTools: hasTools ? activeTools : undefined,
      toolChoice: hasTools ? 'auto' : 'none',
      repairToolCall: hasTools ? input.tools.repairToolCall : undefined,
      maxRetries: 2,
      hookContext: input.hookContext,
    },
    input.abortSignal,
  );

  let text = '';
  let thought = '';
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | undefined;
  let providerMetadata: Record<string, unknown> | undefined;
  const toolCalls: StructuredToolCall[] = [];

  for await (const event of result.fullStream) {
    switch (event.type) {
      case 'text-delta':
        text += event.text;
        yield { type: 'text_delta', delta: event.text };
        break;
      case 'reasoning-delta':
        thought += event.text;
        yield { type: 'thought_delta', delta: event.text };
        break;
      case 'tool-call': {
        const toolId = input.tools.resolveToolId(event.toolName) ?? event.toolName;
        toolCalls.push({
          id: normalizeToolCallId(event.toolCallId),
          toolId,
          args: isRecord(event.input) ? event.input : {},
        });
        break;
      }
      case 'finish-step':
        finishReason = event.finishReason;
        usage = isRecord(event.usage) ? event.usage : usage;
        providerMetadata = isRecord(event.providerMetadata) ? event.providerMetadata : providerMetadata;
        break;
      case 'finish':
        finishReason ??= event.finishReason;
        usage ??= isRecord(event.totalUsage) ? event.totalUsage : undefined;
        break;
      case 'error':
        throw event.error;
      default:
        break;
    }
  }

  const message = text.trim() || undefined;
  const deduplicatedToolCalls = deduplicateToolCalls(toolCalls);
  const parsedFallback = !input.mustFinalize && deduplicatedToolCalls.length === 0 && message
    ? parseLoopModelStepText(message, false)
    : null;
  const rawFinalToolCalls = input.mustFinalize
    ? []
    : parsedFallback?.toolCalls.length
      ? parsedFallback.toolCalls
      : deduplicatedToolCalls;
  const finalToolCalls = rawFinalToolCalls.filter(c => !c.toolId.includes('multi_tool_use'));
  const finalMessage = parsedFallback?.toolCalls.length ? parsedFallback.message : message;

  yield {
    type: 'step_complete',
    step: {
      thought: thought.trim() || undefined,
      message: finalMessage,
      toolCalls: finalToolCalls,
      final: input.mustFinalize || finalToolCalls.length === 0,
      stopReason: input.mustFinalize ? 'max_steps' : null,
      finishReason: input.mustFinalize ? 'max_steps' : (parsedFallback?.finishReason ?? finishReason ?? null),
      usage,
      providerMetadata,
    },
    model: input.model,
  };
}

function normalizeToolCallId(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return makeRuntimeId('mtc');
}

function deduplicateToolCalls(calls: StructuredToolCall[]): StructuredToolCall[] {
  const filtered = calls.filter(c => !c.toolId.includes('multi_tool_use'));
  if (filtered.length <= 1) return filtered;
  const hasNonEmptyArgs = (args: Record<string, unknown>) => Object.keys(args).length > 0;
  const grouped = new Map<string, StructuredToolCall[]>();
  for (const call of filtered) {
    const group = grouped.get(call.toolId);
    if (group) group.push(call);
    else grouped.set(call.toolId, [call]);
  }
  const result: StructuredToolCall[] = [];
  for (const group of grouped.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const withArgs = group.filter(c => hasNonEmptyArgs(c.args));
    const withoutArgs = group.filter(c => !hasNonEmptyArgs(c.args));
    if (withArgs.length > 0) {
      result.push(...withArgs);
    } else {
      result.push(withoutArgs[0]);
    }
  }
  return result;
}
