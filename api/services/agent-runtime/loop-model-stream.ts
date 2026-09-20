import { normalizeUsage } from "../llm-runtime/usage.js";
import type { streamText } from "ai";
import { withRetryStream } from "../llm-runtime/middleware/retry.js";
import {
  createGatewayStreamForSelection,
  resolveGatewaySelection,
} from "../llm-runtime/gateway.js";
import type { LlmGatewayRequest } from "../llm-runtime/types.js";
import type { LlmHookContext } from "../llm-runtime/llm-hooks.js";
import type {
  LoopModelStreamEvent,
  LoopStepModelResult,
  StructuredToolCall,
} from "./contracts.js";
import type { LoopToolSet } from "./loop-ai-tools.js";
import { isRecord, parseLoopModelStepText } from "./loop-model-output.js";
import { makeRuntimeId } from "./runtime-ids.js";
import { ResponsesSnapshotAccumulator } from "./responses-snapshot.js";
import {
  isNativeWebSearchUnsupportedError,
  markNativeWebSearchSupported,
  markNativeWebSearchUnsupported,
  routeNativeWebSearchTools,
} from "../llm-runtime/native-web-search.js";
import { saveGeneratedMedia } from "./generated-media.js";
import type { RuntimeContentPart } from "./content-parts.js";

export interface GenerateLoopModelStepInput {
  request: LlmGatewayRequest;
  tools: LoopToolSet;
  model: string | null;
  abortSignal?: AbortSignal;
  hookContext?: LlmHookContext;
}

export async function generateLoopModelStep(
  input: GenerateLoopModelStepInput,
): Promise<LoopStepModelResult> {
  for await (const event of streamLoopModelStep(input)) {
    if (event.type === "step_complete")
      return { step: event.step, model: event.model };
  }
  throw new Error("Model stream ended without a completed step.");
}

export async function* streamLoopModelStep(
  input: GenerateLoopModelStepInput,
): AsyncGenerator<LoopModelStreamEvent> {
  const routeState = { forceLocal: false };
  // Tools run only after a complete model step, so retrying cannot replay executed tools.
  for await (const event of withRetryStream(
    () => streamLoopModelStepWithNativeFallback(input, routeState),
    {
      signal: input.abortSignal,
      repeatNetworkGroups: true,
    },
  )) {
    yield event.type === "value" ? event.value : event;
  }
}

async function* streamLoopModelStepWithNativeFallback(
  input: GenerateLoopModelStepInput,
  state: { forceLocal: boolean },
): AsyncGenerator<LoopModelStreamEvent> {
  const route = {
    native: false,
    capabilityKey: undefined as string | undefined,
  };
  let emitted = false;
  try {
    for await (const event of streamLoopModelStepOnce(
      input,
      state.forceLocal,
      route,
    )) {
      emitted = true;
      yield event;
    }
    if (route.native) markNativeWebSearchSupported(route.capabilityKey);
  } catch (error) {
    if (!emitted && route.native && isNativeWebSearchUnsupportedError(error)) {
      markNativeWebSearchUnsupported(route.capabilityKey);
      state.forceLocal = true;
      yield* streamLoopModelStepOnce(input, true, route);
      return;
    }
    throw error;
  }
}

async function* streamLoopModelStepOnce(
  input: GenerateLoopModelStepInput,
  forceLocal = false,
  routeState?: { native: boolean; capabilityKey?: string },
): AsyncGenerator<LoopModelStreamEvent> {
  const selection = await resolveGatewaySelection(input.request);
  const routed = routeNativeWebSearchTools(input.tools, selection, forceLocal);
  if (routeState) {
    routeState.native = routed.native;
    routeState.capabilityKey = routed.capabilityKey;
  }
  const activeTools = routed.tools.activeTools;
  const hasTools = activeTools.length > 0;
  const result = (await createGatewayStreamForSelection(
    {
      ...input.request,
      tools: hasTools ? routed.tools.tools : undefined,
      activeTools: hasTools ? activeTools : undefined,
      toolChoice: hasTools ? "auto" : "none",
      repairToolCall: hasTools ? input.tools.repairToolCall : undefined,
      maxRetries: 0,
      hookContext: input.hookContext,
    },
    selection,
    input.abortSignal,
  )) as ReturnType<typeof streamText>;

  let text = "";
  const media: RuntimeContentPart[] = [];
  let thought = "";
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | undefined;
  let providerMetadata: Record<string, unknown> | undefined;
  const toolCalls: StructuredToolCall[] = [];
  const toolCallProviderMetadata: Record<string, Record<string, unknown>> = {};
  const reasoningParts: Array<{
    id: string;
    text: string;
    providerMetadata?: Record<string, Record<string, unknown>>;
  }> = [];
  const sources: NonNullable<LoopStepModelResult["step"]["sources"]> = [];
  const protocolSnapshot = new ResponsesSnapshotAccumulator();

  for await (const event of result.fullStream) {
    switch (event.type) {
      case "raw":
        protocolSnapshot.ingest((event as { rawValue?: unknown }).rawValue);
        break;
      case "text-delta":
        text += event.text;
        yield { type: "text_delta", delta: event.text };
        break;
      case "file":
        media.push(
          await saveGeneratedMedia(
            input.request.projectId,
            event.file,
            event.providerMetadata,
          ),
        );
        break;
      case "reasoning-start":
        reasoningParts.push({
          id: event.id,
          text: "",
          providerMetadata: event.providerMetadata as never,
        });
        break;
      case "reasoning-end": {
        const part = reasoningParts.findLast((p) => p.id === event.id);
        if (part && event.providerMetadata)
          part.providerMetadata = event.providerMetadata as never;
        break;
      }
      case "reasoning-delta":
        if (!reasoningParts.some((p) => p.id === event.id))
          reasoningParts.push({ id: event.id, text: "" });
        reasoningParts.findLast((p) => p.id === event.id)!.text += event.text;
        thought += event.text;
        yield { type: "thought_delta", delta: event.text };
        break;
      case "tool-call": {
        if (event.providerExecuted) break;
        if (event.providerMetadata)
          toolCallProviderMetadata[normalizeToolCallId(event.toolCallId)] =
            event.providerMetadata as Record<string, unknown>;
        const toolId =
          input.tools.resolveToolId(event.toolName) ?? event.toolName;
        toolCalls.push({
          id: normalizeToolCallId(event.toolCallId),
          toolId,
          args: isRecord(event.input) ? event.input : {},
        });
        break;
      }
      case "source": {
        const source = event as typeof event & {
          id: string;
          sourceType: string;
          url?: string;
          title?: string;
        };
        const url = safeSourceUrl(source.url);
        sources.push({
          id: source.id,
          sourceType: source.sourceType,
          ...(url ? { url } : {}),
          ...(source.title ? { title: source.title } : {}),
        });
        break;
      }
      case "finish-step":
        finishReason = event.finishReason;
        providerMetadata = isRecord(event.providerMetadata)
          ? event.providerMetadata
          : providerMetadata;
        usage =
          normalizeUsage(event.usage, { source: "sdk", providerMetadata }) ??
          usage;
        if (usage) yield { type: "usage", usage };
        break;
      case "finish":
        finishReason ??= event.finishReason;
        if (!usage) {
          usage = normalizeUsage(event.totalUsage, {
            source: "sdk",
            providerMetadata,
          });
          if (usage) yield { type: "usage", usage };
        }
        break;
      case "error":
        throw event.error;
      case "abort":
        input.abortSignal?.throwIfAborted();
        throw new DOMException("Model request aborted.", "AbortError");
      default:
        break;
    }
  }

  input.abortSignal?.throwIfAborted();
  if (!finishReason || finishReason === "error")
    throw new Error("Network error: model stream ended before completion.");

  const message = text.trim() || undefined;
  const deduplicatedToolCalls = deduplicateToolCalls(toolCalls);
  const parsedFallback =
    deduplicatedToolCalls.length === 0 && message
      ? parseLoopModelStepText(message)
      : null;
  const rawFinalToolCalls = parsedFallback?.toolCalls.length
    ? parsedFallback.toolCalls
    : deduplicatedToolCalls;
  const finalToolCalls = rawFinalToolCalls.filter(
    (c) => !c.toolId.includes("multi_tool_use"),
  );
  const finalMessage = parsedFallback?.toolCalls.length
    ? parsedFallback.message
    : message;

  yield {
    type: "step_complete",
    step: {
      ...(media.length ? { contentParts: media } : {}),
      thought: thought.trim() || undefined,
      reasoningParts: reasoningParts.map(({ id, ...part }) => part),
      toolCallProviderMetadata,
      message: finalMessage,
      toolCalls: finalToolCalls,
      final: finalToolCalls.length === 0,
      stopReason: null,
      finishReason: parsedFallback?.finishReason ?? finishReason ?? null,
      usage,
      providerMetadata,
      sources,
      protocol: protocolSnapshot.snapshot(),
    },
    model: input.model,
  };
}

function safeSourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function normalizeToolCallId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return makeRuntimeId("mtc");
}

function deduplicateToolCalls(
  calls: StructuredToolCall[],
): StructuredToolCall[] {
  const filtered = calls.filter((c) => !c.toolId.includes("multi_tool_use"));
  if (filtered.length <= 1) return filtered;
  const hasNonEmptyArgs = (args: Record<string, unknown>) =>
    Object.keys(args).length > 0;
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
    const withArgs = group.filter((c) => hasNonEmptyArgs(c.args));
    const withoutArgs = group.filter((c) => !hasNonEmptyArgs(c.args));
    if (withArgs.length > 0) {
      result.push(...withArgs);
    } else {
      result.push(withoutArgs[0]);
    }
  }
  return result;
}
