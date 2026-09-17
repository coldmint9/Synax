import { getEncoding as createEncoding, getEncodingNameForModel, type TiktokenEncoding, type TiktokenModel } from "js-tiktoken";
import type { LlmGatewayMessage } from "../llm-runtime/types.js";

const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_CALL_OVERHEAD_TOKENS = 8;

/**
 * Bounded text -> token count memo keyed by encoder. Bounded by entry count,
 * retained characters, and a per-text cap so long sessions cannot retain
 * unbounded history text.
 */
const TOKEN_CACHE_MAX_ENTRIES = 4096;
const TOKEN_CACHE_MAX_CHARS = 4 * 1024 * 1024;
const TOKEN_CACHE_MAX_TEXT_CHARS = 8192;

interface TokenCacheEntry {
  tokens: number;
  chars: number;
}

let cachedEncoding: ReturnType<typeof createEncoding> | null = null;
let cachedModelKey: string | null = null;

let encodeCount = 0;
let encodingCreations = 0;
let cacheHits = 0;
let cacheMisses = 0;
const tokenCache = new Map<string, TokenCacheEntry>();
let tokenCacheChars = 0;

function getEncoding(modelKey: string) {
  if (cachedEncoding && cachedModelKey === modelKey) return cachedEncoding;
  cachedEncoding = createEncoding(modelKey as TiktokenEncoding);
  cachedModelKey = modelKey;
  encodingCreations++;
  return cachedEncoding;
}

function resolveEncodingModel(model?: string): string {
  // Provider-qualified OpenAI model IDs still have a known tokenizer. Other
  // families use an explicitly approximate o200k fallback until usage arrives.
  const name = model?.split("/").pop();
  try {
    return getEncodingNameForModel(name as TiktokenModel);
  } catch {
    return "o200k_base";
  }
}

function encode(modelKey: string, text: string): number {
  encodeCount++;
  return getEncoding(modelKey).encode(text).length;
}

function cacheKey(modelKey: string, text: string): string {
  return `${modelKey}\u0000${text}`;
}

function evictTokenCache(): void {
  while (
    tokenCache.size > TOKEN_CACHE_MAX_ENTRIES ||
    tokenCacheChars > TOKEN_CACHE_MAX_CHARS
  ) {
    const oldest = tokenCache.keys().next();
    if (oldest.done) break;
    const entry = tokenCache.get(oldest.value);
    tokenCache.delete(oldest.value);
    if (entry) tokenCacheChars -= entry.chars;
  }
  if (tokenCacheChars < 0) tokenCacheChars = 0;
}

export function countTokens(text: string, model?: string): number {
  if (!text) return 0;
  if (text.length > TOKEN_CACHE_MAX_TEXT_CHARS)
    return encode(resolveEncodingModel(model), text);
  const modelKey = resolveEncodingModel(model);
  const key = cacheKey(modelKey, text);
  const cached = tokenCache.get(key);
  if (cached) {
    cacheHits++;
    // Refresh recency so reused history prefixes survive eviction.
    tokenCache.delete(key);
    tokenCache.set(key, cached);
    return cached.tokens;
  }
  cacheMisses++;
  const tokens = encode(modelKey, text);
  tokenCache.set(key, { tokens, chars: key.length });
  tokenCacheChars += key.length;
  evictTokenCache();
  return tokens;
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

export interface TokenCacheStats {
  entries: number;
  chars: number;
  maxEntries: number;
  maxChars: number;
  maxTextChars: number;
  encodes: number;
  encodingCreations: number;
  hits: number;
  misses: number;
}

/** Diagnostics only; callers must not depend on cache state for correctness. */
export function tokenCacheStats(): TokenCacheStats {
  return {
    entries: tokenCache.size,
    chars: tokenCacheChars,
    maxEntries: TOKEN_CACHE_MAX_ENTRIES,
    maxChars: TOKEN_CACHE_MAX_CHARS,
    maxTextChars: TOKEN_CACHE_MAX_TEXT_CHARS,
    encodes: encodeCount,
    encodingCreations,
    hits: cacheHits,
    misses: cacheMisses,
  };
}

/** Drop retained text and counters. Used by tests and long-lived processes. */
export function clearTokenCache(): void {
  tokenCache.clear();
  tokenCacheChars = 0;
  encodeCount = 0;
  encodingCreations = 0;
  cacheHits = 0;
  cacheMisses = 0;
}
