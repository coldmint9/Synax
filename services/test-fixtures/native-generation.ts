/** Native-provider integration helpers; intentionally test-only. */
import type { ModelMessage, ProviderOptions, ProviderRequest, ToolChoice, ToolDefinition, ToolSet } from "../local-node/infrastructure/llm-runtime/contracts.js";
import { streamProvider } from "../local-node/infrastructure/llm-runtime/native-client.js";
import { asSchema } from "../local-node/infrastructure/llm-runtime/tool-schema.js";
import { collectGatewayResult, gatewayResult } from "../local-node/infrastructure/llm-runtime/gateway-result.js";
export type { ToolSet } from "../local-node/infrastructure/llm-runtime/contracts.js";
export { jsonSchema } from "../local-node/infrastructure/llm-runtime/tool-schema.js";
export const tool = (definition: ToolDefinition) => definition;
export interface NativeTestModel { request(): Promise<ProviderRequest> }
export const nativeModel = (request: ProviderRequest): NativeTestModel => ({ request: async () => request });
export interface NativeGenerationOptions {
  model: NativeTestModel;
  messages?: ModelMessage[];
  prompt?: string;
  system?: string | ModelMessage[];
  tools?: ToolSet;
  toolChoice?: ToolChoice;
  maxRetries?: number;
  maxOutputTokens?: number;
  providerOptions?: ProviderOptions;
  temperature?: number;
  abortSignal?: AbortSignal;
}
export async function generateText(options: NativeGenerationOptions) {
  const base = await options.model.request();
  const tools = await Promise.all(Object.entries(options.tools ?? {}).map(async ([name, tool]) => ({ type: "function", name,
    description: tool.description, inputSchema: await asSchema(tool.inputSchema).jsonSchema, providerOptions: tool.providerOptions })));
  const messages = [...(typeof options.system === "string" ? [{ role: "system" as const, content: options.system }] : options.system ?? []),
    ...options.messages ?? (options.prompt ? [{ role: "user" as const, content: options.prompt }] : [])];
  const wire: ProviderRequest = { ...base, prompt: messages, tools,
    maxRetries: options.maxRetries ?? 0, maxOutputTokens: options.maxOutputTokens,
    providerOptions: options.providerOptions, temperature: options.temperature,
    toolChoice: typeof options.toolChoice === "string" ? { type: options.toolChoice } : options.toolChoice };
  return collectGatewayResult(gatewayResult(streamProvider(wire, options.abortSignal), { purpose: "fixture", messages }, base.model, base.providerId ?? "fixture"));
}
