import type {
  GenerateTextEndEvent,
  GenerateTextStartEvent,
  GenerateTextStepEndEvent,
  GenerateTextStepStartEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolSet,
} from "ai";
import type { LlmGatewayRequest } from "../types.js";
import { llmHooks } from "../llm-hooks.js";

import { aggregateUsage, normalizeUsage } from "../usage.js";

export function buildHookCallbacks(request: LlmGatewayRequest) {
  const ctx = request.hookContext;
  const genStart = Date.now();
  let stepNumber: number | undefined;

  return {
    onStart: (event: GenerateTextStartEvent<ToolSet>) => {
      llmHooks.emit({
        type: "generation:start",
        modelId: event.modelId,
        provider: event.provider,
        purpose: request.purpose,
        context: ctx,
      });
    },
    onStepStart: (event: GenerateTextStepStartEvent<ToolSet>) => {
      stepNumber = event.stepNumber;
      llmHooks.emit({
        type: "step:start",
        stepNumber: event.stepNumber,
        modelId: event.modelId,
        provider: event.provider,
        purpose: request.purpose,
        context: ctx,
      });
    },
    onToolExecutionStart: (event: ToolExecutionStartEvent<ToolSet>) => {
      llmHooks.emit({
        type: "tool_call:start",
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
        stepNumber,
        context: ctx,
      });
    },
    onToolExecutionEnd: (event: ToolExecutionEndEvent<ToolSet>) => {
      llmHooks.emit({
        type: "tool_call:end",
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
        durationMs: event.toolExecutionMs,
        success: event.toolOutput.type === "tool-result",
        error:
          event.toolOutput.type === "tool-error"
            ? String(event.toolOutput.error)
            : undefined,
        context: ctx,
      });
    },
    onStepEnd: (event: GenerateTextStepEndEvent<ToolSet>) => {
      llmHooks.emit({
        type: "step:finish",
        stepNumber: event.stepNumber,
        finishReason: event.finishReason ?? "unknown",
        usage: normalizeUsage(event.usage, {
          source: "sdk",
          providerMetadata: event.providerMetadata,
        }),
        providerMetadata: event.providerMetadata as
          | Record<string, unknown>
          | undefined,
        modelId: event.model.modelId,
        provider: event.model.provider,
        context: ctx,
      });
    },
    onEnd: (event: GenerateTextEndEvent<ToolSet>) => {
      llmHooks.emit({
        type: "generation:finish",
        totalSteps: event.steps?.length ?? 1,
        totalUsage: event.steps?.length
          ? aggregateUsage(
              event.steps.map(
                (step) =>
                  normalizeUsage(step.usage, {
                    source: "sdk",
                    providerMetadata: step.providerMetadata,
                  }) ?? normalizeUsage({})!,
              ),
            )
          : // Without individual steps, last-step metadata cannot describe totals.
            normalizeUsage(event.totalUsage, { source: "sdk" }),
        providerMetadata: event.providerMetadata as
          | Record<string, unknown>
          | undefined,
        durationMs: Date.now() - genStart,
        context: ctx,
      });
    },
  };
}
