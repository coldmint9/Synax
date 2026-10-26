/** Synax host/native contracts. No vendor SDK types cross this boundary. */
import type { z } from "zod";
import type { LlmRetryState } from "./retry-state.js";

export type JSONValue = null | boolean | number | string | JSONValue[] | JSONObject;
export type JSONObject = { [key: string]: JSONValue | undefined };
export type ProviderOptions = Record<string, JSONObject>;

type Metadata = { providerOptions?: ProviderOptions };
export type ToolResultOutput = Metadata & (
  | { type: "text" | "error-text"; value: string }
  | { type: "json" | "error-json"; value: unknown }
  | { type: "content"; value: Array<Metadata & ({ type: "text"; text: string } | { type: "file" | "image"; data: { type: "data"; data: string } | { type: "url"; url: string }; mediaType: string; filename?: string } | { type: "image-data" | "file-data" | "audio-data"; data: string; mediaType: string; filename?: string } | { type: "image-url" | "file-url"; url: string; mediaType?: string })> }
  | { type: "execution-denied"; reason?: string }
);
export type MessagePart = Metadata & (
  | { type: "text" | "reasoning"; text: string }
  | { type: "file"; data: string | Uint8Array | URL; mediaType: string; filename?: string }
  | { type: "image"; image: string | Uint8Array | URL; mediaType?: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown; providerExecuted?: boolean }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: ToolResultOutput }
);
export type SystemModelMessage = Metadata & { role: "system"; content: string };
export type ModelMessage = SystemModelMessage
  | (Metadata & { role: "user"; content: string | MessagePart[] })
  | (Metadata & { role: "assistant"; content: string | MessagePart[] })
  | (Metadata & { role: "tool"; content: MessagePart[] });
export type JsonSchema = Record<string, unknown>;
export type InputSchema = z.ZodType | { jsonSchema: JsonSchema | PromiseLike<JsonSchema> };
export interface ToolDefinition {
  type?: "function" | "provider" | "provider-defined";
  id?: string;
  args?: Record<string, unknown>;
  title?: string;
  description?: string;
  inputSchema?: InputSchema;
  providerOptions?: ProviderOptions;
  metadata?: Record<string, unknown>;
}
export type ToolSet = Record<string, ToolDefinition>;
export type ToolChoice<_Tools = ToolSet> = "auto" | "none" | "required" | { type: "tool"; toolName: string };

export interface ProviderRequest {
  adapter?: string;
  providerId?: string;
  apiFormat: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  model: string;
  purpose?: string;
  reasoningEffort?: string;
  reasoningCapable?: boolean;
  supportedReasoningEfforts?: string[];
  responseOptions?: Record<string, unknown>;
  cachePolicy?: Record<string, unknown>;
  prompt: unknown[];
  tools?: unknown[];
  toolChoice?: unknown;
  maxRetries?: number;
  maxOutputTokens?: number;
  requiredMaxOutputTokens?: number;
  outputTokenParameter?: "max_completion_tokens";
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  stopSequences?: string[];
  providerOptions?: ProviderOptions;
  responseFormat?: { type: "json" | "text"; schema?: JsonSchema; name?: string };
}

export type ProviderEvent =
  | { type: "stream-start"; warnings: unknown[] }
  | { type: "text-delta" | "reasoning-delta" | "reasoning-signature"; id: string; delta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "assistant-message"; message: { role: string; content: unknown[]; rigMessage?: unknown } }
  | { type: "usage"; usage: Record<string, unknown> }
  | { type: "raw"; rawValue: unknown }
  | { type: "structured-output"; value: unknown }
  | { type: "retry_status"; retry: LlmRetryState }
  | { type: "finish"; finishReason: string; rawFinishReason?: string }
  | { type: "error"; error: string; statusCode?: number; isRetryable?: boolean };

export interface GeneratedFile { mediaType: string; uint8Array: Uint8Array }
