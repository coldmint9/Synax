import { z } from "zod";
import type { InputSchema, JsonSchema } from "./contracts.js";

interface HostSchema {
  jsonSchema: JsonSchema | PromiseLike<JsonSchema>;
  validate?: (value: unknown) => Promise<{ success: true; value: unknown } | { success: false; error: unknown }>;
}
const schemas = new WeakMap<object, HostSchema>();

/** Convert host tool schemas once, before sending plain JSON to Rust. */
export function asSchema(schema?: InputSchema): HostSchema {
  if (!schema) return { jsonSchema: { type: "object", properties: {} } };
  if ("jsonSchema" in schema) return schema;
  let result = schemas.get(schema);
  if (!result) {
    result = { jsonSchema: z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any", io: "input" }),
      validate: async value => {
        const parsed = await schema.safeParseAsync(value);
        return parsed.success ? { success: true, value: parsed.data } : { success: false, error: parsed.error };
      },
    };
    schemas.set(schema, result);
  }
  return result;
}

export function jsonSchema<_T = unknown>(schema: JsonSchema): { jsonSchema: JsonSchema } {
  return { jsonSchema: schema };
}
