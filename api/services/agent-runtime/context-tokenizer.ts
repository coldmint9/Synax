import { encodingForModel, type TiktokenModel } from "js-tiktoken";
import type { LlmGatewayMessage } from "../llm-runtime/types.js";

const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_CALL_OVERHEAD_TOKENS = 8;

let cachedEncoding: ReturnType<typeof encodingForModel> | null = null;
let cachedModelKey: string | null = null;

function getEncoding(model?: string) {
  const key = resolveEncodingModel(model);
  if (cachedEncoding && cachedModelKey === key) return cachedEncoding;
  cachedEncoding = encodingForModel(key as TiktokenModel);
  cachedModelKey = key;
  return cachedEncoding;
}

function resolveEncodingModel(model?: string): string {
  if (!model) return "gpt-4o";
  if (model.includes("claude")) return "gpt-4o";
  if (model.includes("gpt-4")) return "gpt-4o";
  return "gpt-4o";
}

export function countTokens(text: string, model?: string): number {
  if (!text) return 0;
  const enc = getEncoding(model);
  return enc.encode(text).length;
}

export function countMessagesTokens(
  messages: LlmGatewayMessage[],
  model?: string,
): number {
  let total = 0;
  for (const message of messages) {
    total += MESSAGE_OVERHEAD_TOKENS;
    total += countMessageContentTokens(message, model);
  }
  return total;
}

function countMessageContentTokens(
  message: LlmGatewayMessage,
  model?: string,
): number {
  if (message.role === "system") {
    return countTokens(message.content, model);
  }

  const content = message.content;
  if (typeof content === "string") {
    return countTokens(content, model);
  }
  if (!Array.isArray(content)) return 0;

  let tokens = 0;
  for (const part of content) {
    if ("text" in part && typeof part.text === "string") {
      tokens += countTokens(part.text, model);
    }
    if (part.type === "tool-call") {
      tokens += TOOL_CALL_OVERHEAD_TOKENS;
      tokens += countTokens(part.toolName, model);
      tokens += countTokens(JSON.stringify(part.input ?? {}), model);
    }
    if (part.type === "tool-result") {
      tokens += TOOL_CALL_OVERHEAD_TOKENS;
      tokens += countTokens(part.toolName, model);
      const output = part.output;
      const text =
        output.type === "json" || output.type === "error-json"
          ? (JSON.stringify(output.value) ?? "")
          : "value" in output && typeof output.value === "string"
            ? output.value
            : output.type === "content"
              ? output.value
                  .map((item) => (item.type === "text" ? item.text : ""))
                  .join("\n")
              : "reason" in output
                ? (output.reason ?? "")
                : "";
      tokens += countTokens(text, model);
    }
    // Text/reasoning was already counted above; signatures and media are not text tokens.
  }
  return tokens;
}

export function estimateToolDefinitionsTokens(
  toolCount: number,
  model?: string,
): number {
  return toolCount * 120;
}
