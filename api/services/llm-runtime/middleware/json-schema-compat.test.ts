import { describe, expect, it } from "vitest";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import {
  stripPropertyNames,
  stripUnsupportedKeywords,
} from "./json-schema-compat.js";

describe("JSON Schema compatibility middleware", () => {
  it("removes propertyNames recursively without mutating the source schema", () => {
    const schema = {
      type: "object",
      propertyNames: { type: "string" },
      properties: {
        metadata: {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: { type: "string" },
        },
      },
    };

    expect(stripPropertyNames(schema)).toEqual({
      type: "object",
      properties: {
        metadata: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
    });
    expect(schema.propertyNames).toEqual({ type: "string" });
    expect(schema.properties.metadata.propertyNames).toEqual({
      type: "string",
    });
  });

  it("normalizes tool and structured-output schemas before provider execution", () => {
    const params = {
      prompt: [],
      tools: [
        {
          type: "function",
          name: "task_update",
          inputSchema: {
            type: "object",
            properties: {
              metadata: {
                type: "object",
                propertyNames: { type: "string" },
                additionalProperties: {},
              },
            },
            propertyNames: { type: "string" },
          },
        },
      ],
      responseFormat: {
        type: "json",
        schema: {
          type: "object",
          propertyNames: { type: "string" },
        },
      },
    } as LanguageModelV4CallOptions;

    const normalized = stripUnsupportedKeywords(params);
    const toolSchema = normalized.tools?.[0];
    if (!toolSchema || toolSchema.type !== "function")
      throw new Error("Expected function tool");

    expect(toolSchema.inputSchema).not.toHaveProperty("propertyNames");
    expect(toolSchema.inputSchema.properties).toEqual({
      metadata: {
        type: "object",
        additionalProperties: {},
      },
    });
    expect(normalized.responseFormat?.type).toBe("json");
    if (normalized.responseFormat?.type === "json") {
      expect(normalized.responseFormat.schema).not.toHaveProperty(
        "propertyNames",
      );
    }
    const originalTool = params.tools?.[0];
    if (originalTool?.type === "function") {
      expect(originalTool.inputSchema).toHaveProperty("propertyNames");
    }
  });
});
