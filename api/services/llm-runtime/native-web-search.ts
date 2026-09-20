import { openai } from "@ai-sdk/openai";
import type { ToolSet } from "ai";
import { getGlobalConfigForRuntime } from "../../lib/config/config-store.js";
import type { WebSearchConfig } from "../../lib/config/config-types.js";
import type { LoopToolSet } from "../agent-runtime/loop-ai-tools.js";
import type { ResolvedModelSelection } from "./types.js";

const support = new Map<string, "supported" | "unsupported">();
const MAX_CAPABILITY_CACHE_ENTRIES = 256;

export interface RoutedWebSearchTools {
  tools: LoopToolSet;
  native: boolean;
  capabilityKey?: string;
}

export function routeNativeWebSearchTools(
  tools: LoopToolSet,
  selection: ResolvedModelSelection,
  forceLocal = false,
  config: WebSearchConfig = getGlobalConfigForRuntime().webSearch,
): RoutedWebSearchTools {
  const modelToolName = tools.resolveModelToolName("webSearch");
  const capabilityKey = nativeWebSearchCapabilityKey(selection);
  const canTryNative =
    !forceLocal &&
    Boolean(modelToolName) &&
    selection.apiFormat === "openai-responses" &&
    config.routing !== "local" &&
    config.routing !== "disabled" &&
    (config.routing === "remote" ||
      support.get(capabilityKey) !== "unsupported");
  if (!canTryNative || !modelToolName) return { tools, native: false };

  const routedTools: ToolSet = {
    ...tools.tools,
    [modelToolName]: openai.tools.webSearch({
      externalWebAccess: config.remote.externalWebAccess,
      searchContextSize: config.remote.searchContextSize,
    }),
  };
  return {
    native: true,
    capabilityKey,
    tools: { ...tools, tools: routedTools },
  };
}

export function markNativeWebSearchSupported(key: string | undefined): void {
  if (key) cacheSupport(key, "supported");
}

export function markNativeWebSearchUnsupported(key: string | undefined): void {
  if (key) cacheSupport(key, "unsupported");
}

function cacheSupport(key: string, value: "supported" | "unsupported"): void {
  support.delete(key);
  support.set(key, value);
  while (support.size > MAX_CAPABILITY_CACHE_ENTRIES) {
    const oldest = support.keys().next().value;
    if (typeof oldest !== "string") break;
    support.delete(oldest);
  }
}

export function isNativeWebSearchUnsupportedError(error: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
      continue;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      for (const key of ["message", "error", "responseBody", "data"]) {
        const value = record[key];
        if (typeof value === "string") messages.push(value);
      }
      current = record.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  const message = messages.join(" ").toLowerCase();
  const identifiesSearch =
    message.includes("web_search") ||
    message.includes("web search") ||
    message.includes("web-search");
  const identifiesCapabilityFailure = [
    "unsupported",
    "not supported",
    "unknown tool",
    "unrecognized tool",
    "invalid tool",
    "not available",
    "not enabled",
    "permission",
  ].some((part) => message.includes(part));
  return identifiesSearch && identifiesCapabilityFailure;
}

function nativeWebSearchCapabilityKey(
  selection: ResolvedModelSelection,
): string {
  return [
    selection.providerId,
    selection.config.baseUrl ?? selection.provider.api ?? "",
    selection.modelId,
  ].join("|");
}
