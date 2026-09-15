import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  countMessagesTokens,
  countTokens,
  estimateToolDefinitionsTokens,
} from "../context-tokenizer.js";
import { measureContextComposition } from "../context-composition.js";
import { buildLoopToolSet } from "../loop-ai-tools.js";
import type { LlmGatewayMessage } from "../../llm-runtime/types.js";

describe("complete text/schema request budgets", () => {
  it("counts JSON tool outputs as serialized JSON and reasoning exactly once", async () => {
    const messages: LlmGatewayMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "A private reasoning segment",
            providerOptions: { anthropic: { signature: "opaque" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read",
            toolName: "read",
            output: {
              type: "json",
              value: {
                rows: Array.from({ length: 150 }, (_, i) => ({
                  id: i,
                  text: "Evidence",
                })),
              },
            },
          },
        ],
      },
    ];
    const composition = await measureContextComposition({
      messages,
      tools: buildLoopToolSet([]),
    });
    expect(countMessagesTokens(messages)).toBe(composition.total);
    expect(composition.total).toBeGreaterThan(1000);
    expect(countMessagesTokens([messages[0]])).toBe(
      4 + countTokens("A private reasoning segment"),
    );
  });
  it("accounts for large actual active schemas rather than the old per-tool constant", async () => {
    const tools = buildLoopToolSet([
      {
        id: "read",
        label: "Read",
        description: "Inspect",
        category: "read",
        mutability: "read",
        resumeBehavior: "auto",
        inputSchema: z.object({
          query: z.string().describe("large schema description ".repeat(4000)),
        }),
      },
    ]);
    const composition = await measureContextComposition({
      messages: [],
      tools,
    });
    expect(composition.total).toBeGreaterThan(10000);
    expect(composition.total).toBeGreaterThan(estimateToolDefinitionsTokens(1));
  });
});
