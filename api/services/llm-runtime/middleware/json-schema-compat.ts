import { wrapLanguageModel } from "ai";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";

type JsonSchema = Record<string, unknown>;

/**
 * Drop JSON Schema keywords that OpenAI wire protocols do not support.
 *
 * `@ai-sdk/openai` removes `propertyNames` from every tool and response-format
 * schema right before the request leaves the SDK and reports an AI SDK
 * compatibility warning for it. Doing the removal here keeps the outgoing
 * schema identical while keeping the logs clean, and it also avoids the
 * `UnsupportedFunctionalityError` the SDK throws when `propertyNames` is not a
 * plain string schema.
 *
 * zod emits `propertyNames` for `z.record(z.string(), value)`; tool schemas
 * should use `stringKeyedMapSchema()` instead. This middleware is the safety
 * net for schemas that reach us from elsewhere (MCP passthroughs, structured
 * output schemas, future tool definitions).
 */
export function applyJsonSchemaCompatMiddleware(
  model: LanguageModelV4,
): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => stripUnsupportedKeywords(params),
    },
  });
}

/** Recursively remove `propertyNames`, sharing untouched subtrees. */
export function stripPropertyNames<T>(value: T): T {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = stripPropertyNames(item);
      changed ||= stripped !== item;
      return stripped;
    });
    return (changed ? next : value) as T;
  }
  if (!value || typeof value !== "object") return value;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as JsonSchema)) {
    if (key === "propertyNames") {
      changed = true;
      continue;
    }
    const stripped = stripPropertyNames(child);
    changed ||= stripped !== child;
    next[key] = stripped;
  }
  return (changed ? next : value) as T;
}

function stripUnsupportedKeywords(
  params: LanguageModelV4CallOptions,
): LanguageModelV4CallOptions {
  let changed = false;
  const tools = params.tools?.map((tool) => {
    if (tool.type !== "function") return tool;
    const inputSchema = stripPropertyNames(tool.inputSchema);
    if (inputSchema === tool.inputSchema) return tool;
    changed = true;
    return { ...tool, inputSchema };
  });
  const responseFormat = sanitizeResponseFormat(params.responseFormat);
  changed ||= responseFormat !== params.responseFormat;
  if (!changed) return params;
  return { ...params, tools: tools ?? params.tools, responseFormat };
}

function sanitizeResponseFormat(
  responseFormat: LanguageModelV4CallOptions["responseFormat"],
): LanguageModelV4CallOptions["responseFormat"] {
  if (responseFormat?.type !== "json" || responseFormat.schema == null)
    return responseFormat;
  const schema = stripPropertyNames(responseFormat.schema);
  return schema === responseFormat.schema
    ? responseFormat
    : { ...responseFormat, schema };
}
