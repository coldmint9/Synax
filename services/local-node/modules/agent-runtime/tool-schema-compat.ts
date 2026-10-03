import * as z from "zod/v4";

/**
 * String-keyed map schema that stays portable across model providers.
 *
 * `z.record(z.string(), value)` renders to JSON Schema with `propertyNames`,
 * which OpenAI wire protocols do not support: the AI SDK drops the keyword
 * right before sending and logs an AI SDK compatibility warning
 * ("OpenAI does not support JSON Schema propertyNames") for every request.
 * JSON object keys are always strings, so `additionalProperties` alone
 * describes the same value map without the unsupported keyword.
 *
 * @see api/services/llm-runtime/middleware/json-schema-compat.ts for the
 * provider-side safety net that covers schemas coming from other sources.
 */
export function stringKeyedMapSchema<ValueSchema extends z.ZodTypeAny>(
  valueSchema: ValueSchema,
) {
  return z.object({}).catchall(valueSchema);
}
