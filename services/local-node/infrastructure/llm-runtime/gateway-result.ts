import type { GeneratedFile, ProviderEvent, ProviderOptions } from "./contracts.js";
import type { LlmRetryState } from "./retry-state.js";
import type { LlmGatewayRequest } from "./types.js";
import { llmHooks } from "./llm-hooks.js";
import { normalizeUsage, whitelistRawUsage } from "./usage.js";
import { randomUUID } from "node:crypto";

/** UI/business events, translated only from the native runtime's semantic events. */
export type GatewayEvent =
  | { type: "text-delta" | "reasoning-delta"; id: string; text: string }
  | { type: "reasoning-start" | "reasoning-end"; id: string; providerMetadata?: ProviderOptions }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown; providerExecuted?: boolean; providerMetadata?: ProviderOptions }
  | { type: "file"; file: GeneratedFile; providerMetadata?: ProviderOptions }
  | { type: "source"; id: string; sourceType: string; url?: string; title?: string }
  | { type: "raw"; rawValue: unknown }
  | { type: "retry_status"; retry: LlmRetryState }
  | { type: "finish-step"; finishReason: string; usage: Record<string, unknown>; providerMetadata?: Record<string, unknown> }
  | { type: "finish"; finishReason: string; totalUsage: Record<string, unknown> }
  | { type: "error"; error: unknown }
  | { type: "abort" };

export interface GatewayTextResult {
  text: string;
  reasoningText: string;
  finishReason: string;
  usage: Record<string, unknown>;
  totalUsage: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
  response: { messages: unknown[] };
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  warnings: unknown[];
  output?: unknown;
}
export interface GatewayStreamResult {
  fullStream: AsyncIterable<GatewayEvent>;
  finishReason: Promise<string>;
  result: Promise<GatewayTextResult>;
}

export function gatewayResult(events: AsyncIterable<ProviderEvent>, request: LlmGatewayRequest, modelId: string, provider: string, diagnostics?: Record<string, unknown>): GatewayStreamResult {
  const completion = Promise.withResolvers<GatewayTextResult>();
  // Streaming callers consume errors from fullStream, without awaiting result.
  void completion.promise.catch(() => undefined);
  const finishReason = completion.promise.then(result => result.finishReason);
  void finishReason.catch(() => undefined);
  const started = Date.now();
  const requestId = request.cacheDiagnosticsContext?.requestId ?? randomUUID();
  let firstTokenMs: number | null = null;
  const fullStream = (async function* (): AsyncGenerator<GatewayEvent> {
    let text = "", reasoningText = "";
    let usage: Record<string, unknown> = {};
    const messages: unknown[] = [], toolCalls: GatewayTextResult["toolCalls"] = [];
    const warnings: unknown[] = [];
    let output: unknown;
    let finished = false;
    const context = request.hookContext;
    llmHooks.emit({ type: "generation:start", modelId, provider, purpose: request.purpose, context });
    llmHooks.emit({ type: "step:start", modelId, provider, purpose: request.purpose, stepNumber: 0, context });
    try {
      for await (const event of events) {
        if (firstTokenMs === null && (event.type === "text-delta" || event.type === "reasoning-delta") && event.delta.length)
          firstTokenMs = Date.now() - started;
        switch (event.type) {
          case "stream-start": warnings.push(...event.warnings); break;
          case "text-delta": text += event.delta; yield { type: event.type, id: event.id, text: event.delta }; break;
          case "reasoning-delta": reasoningText += event.delta; yield { type: event.type, id: event.id, text: event.delta }; break;
          case "reasoning-signature": yield { type: "reasoning-end", id: event.id, providerMetadata: { anthropic: { signature: event.delta } } }; break;
          case "usage": usage = normalizeUsage(event.usage, { source: "native" }) ?? event.usage; break;
          case "assistant-message": messages.push(event.message); break;
          case "tool-call": toolCalls.push(event); yield event; break;
          case "raw": case "retry_status": yield event; break;
          case "structured-output": output = event.value; break;
          case "error": throw new Error(event.error);
          case "finish": {
            const providerMetadata = {
              synaxUsage: { version: 1, source: "native", protocol: usage.protocol, adapter: usage.adapter, raw: whitelistRawUsage(usage.raw), requestId },
              ...(diagnostics ? { synax: { cacheDiagnostics: { ...diagnostics, durationMs: Date.now() - started, firstTokenMs } } } : {}),
            };
            const normalized = normalizeUsage(usage);
            llmHooks.emit({ type: "step:finish", stepNumber: 0, modelId, provider, finishReason: event.finishReason, usage: normalized, providerMetadata, context });
            llmHooks.emit({ type: "generation:finish", totalSteps: 1, totalUsage: normalized, durationMs: Date.now() - started, providerMetadata, context });
            finished = true;
            completion.resolve({ text, reasoningText, usage, totalUsage: usage, finishReason: event.finishReason,
              response: { messages }, toolCalls, warnings, output, providerMetadata });
            yield { type: "finish-step", finishReason: event.finishReason, usage, providerMetadata };
            yield { type: "finish", finishReason: event.finishReason, totalUsage: usage };
            break;
          }
        }
      }
      if (!finished) throw new Error("Native provider stream ended without completion.");
    } catch (error) {
      completion.reject(error);
      throw error;
    } finally {
      if (!finished) completion.reject(new Error("Generation cancelled before completion."));
    }
  })();
  return { fullStream, result: completion.promise, finishReason };
}

export async function collectGatewayResult(stream: GatewayStreamResult): Promise<GatewayTextResult> {
  for await (const _event of stream.fullStream) { /* Drain native events. */ }
  return stream.result;
}
