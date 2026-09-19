import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  clearTokenCache,
  countMessagesTokens,
  countTokens,
  estimateToolDefinitionsTokens,
  tokenCacheStats,
} from "../context-tokenizer.js";
import { measureContextComposition } from "../context-composition.js";
import { buildLoopToolSet } from "../loop-ai-tools.js";
import type { LlmGatewayMessage } from "../../llm-runtime/types.js";

const MAX_TEXT_CHARS = 8192;

beforeEach(clearTokenCache);

describe("complete text/schema request budgets", () => {
  it("attributes retained definitions, calls and results without adding them to messages", async () => {
    const tools = buildLoopToolSet(
      [
        { id: "file.read", label: "Read", category: "read" as const },
        { id: "mcp.docs.search", label: "Search", category: "mcp" as const },
        { id: "skill.load", label: "Load", category: "skill" as const },
      ].map((tool) => ({
        ...tool,
        description: tool.label,
        mutability: "read" as const,
        resumeBehavior: "auto" as const,
        inputSchema: z.object({ query: z.string() }),
      })),
    );
    const catalog = "Skill directory";
    const selectedSkill = JSON.stringify({
      kind: "skill",
      content: "Selected instructions",
    });
    const system = `Core instructions\n${catalog}\n${selectedSkill}`;
    const reminder = "<system-reminder>runtime state</system-reminder>";
    const quote = "<system-reminder>user-quoted text</system-reminder>";
    const conversation: LlmGatewayMessage[] = [
      { role: "system", content: system },
      { role: "user", content: quote },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Think through the evidence" },
          { type: "text", text: "Checking now" },
        ],
      },
      { role: "user", content: reminder },
    ];
    const options = {
      tools,
      skillsSection: catalog,
      selectedReferences: selectedSkill,
      systemMessageContents: new Set([reminder]),
    };
    const before = await measureContextComposition({
      ...options,
      messages: conversation,
    });
    const history: LlmGatewayMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "read",
            toolName: "file_read",
            input: { query: "file" },
          },
          {
            type: "tool-call",
            toolCallId: "search",
            toolName: "mcp_docs_search",
            input: { query: "docs" },
          },
          {
            type: "tool-call",
            toolCallId: "skill",
            toolName: "skill_load",
            input: { query: "skill" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read",
            toolName: "file_read",
            output: {
              type: "json",
              value: { text: "File result ".repeat(100) },
            },
          },
          {
            type: "tool-result",
            toolCallId: "search",
            toolName: "mcp_docs_search",
            output: { type: "error-text", value: "MCP error details" },
          },
          {
            type: "tool-result",
            toolCallId: "skill",
            toolName: "skill_load",
            output: {
              type: "text",
              value: "Loaded skill instructions ".repeat(100),
            },
          },
        ],
      },
      {
        role: "user",
        providerOptions: { synax: { toolCallId: "search" } },
        content: [{ type: "text", text: "Tool media description" }],
      },
    ];
    const after = await measureContextComposition({
      ...options,
      messages: [...conversation, ...history],
    });
    expect(after.messages).toBe(
      countTokens(quote) +
        countTokens("Think through the evidence") +
        countTokens("Checking now"),
    );
    expect(after.messages).toBe(before.messages);
    expect(before.usage).toEqual({
      tools: 0,
      mcp: 0,
      skills: countTokens(selectedSkill),
    });
    for (const key of ["tools", "mcp", "skills"] as const)
      expect(after[key]).toBeGreaterThan(before[key]);
    for (const key of ["tools", "mcp", "skills"] as const) {
      expect(after.usage![key] - before.usage![key]).toBe(
        after[key] - before[key],
      );
      expect(after[key] - after.usage![key]).toBe(
        before[key] - before.usage![key],
      );
    }
    expect(after.system).toBe(before.system! + 4 * history.length);
    expect(after.total).toBe(
      after.tools + after.mcp + after.skills + after.messages + after.system!,
    );
    expect(after.version).toBe(2);
  });

  it("counts only retained output for retired tools and cleared skills, not the session ledger", async () => {
    const tools = buildLoopToolSet([]);
    const toolCalls = [
      {
        id: "record",
        modelToolCallId: "retired",
        toolId: "retired-server-tool",
        category: "mcp" as const,
      },
      {
        id: "not-in-context",
        modelToolCallId: "removed",
        toolId: "file.read",
        category: "read" as const,
      },
    ];
    const measure = (text: string) =>
      measureContextComposition({
        tools,
        toolCalls,
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "retired",
                toolName: "old_alias",
                output: { type: "text", value: text },
              },
              {
                type: "tool-result",
                toolCallId: "skill",
                toolName: "skill_load",
                output: {
                  type: "text",
                  value: "[Earlier skill.load result cleared]",
                },
              },
            ],
          },
        ],
      });
    const full = await measure("Retained results ".repeat(200));
    const compact = await measure(
      "Tool context receipt: evidence retained by reference",
    );
    expect(compact.mcp).toBeLessThan(full.mcp);
    expect(compact.mcp).toBeGreaterThan(0);
    expect(compact.usage!.mcp).toBe(compact.mcp);
    expect(compact.usage!.skills).toBe(compact.skills);
    expect(compact.skills).toBeGreaterThan(0);
    expect(compact.tools).toBe(0);
    expect(compact.messages).toBe(0);
    expect(compact.system).toBe(4);
  });

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

describe("bounded token count cache", () => {
  it("encodes each distinct text once while returning identical counts", () => {
    const text = "Retained evidence paragraph with several tokens. ".repeat(40);
    const expected = countTokens(text);
    expect(tokenCacheStats().encodes).toBe(1);
    for (let i = 0; i < 25; i++) expect(countTokens(text)).toBe(expected);
    const stats = tokenCacheStats();
    expect(stats.encodes).toBe(1);
    expect(stats.hits).toBe(25);
    expect(countTokens(text + " different")).not.toBe(expected);
    expect(tokenCacheStats().encodes).toBe(2);
  });

  it("keeps counts correct for shared and distinct messages while reusing encodes", () => {
    const shared: LlmGatewayMessage[] = [
      { role: "user", content: "stable prefix ".repeat(50) },
      {
        role: "assistant",
        content: [{ type: "text", text: "answer ".repeat(50) }],
      },
    ];
    const first = countMessagesTokens(shared);
    const encodesAfterFirst = tokenCacheStats().encodes;
    expect(countMessagesTokens(shared)).toBe(first);
    expect(countMessagesTokens(shared)).toBe(first);
    expect(tokenCacheStats().encodes).toBe(encodesAfterFirst);
  });

  it("does not retain full tool outputs larger than the per-text cap", () => {
    const huge = "large retained tool output ".repeat(400);
    expect(huge.length).toBeGreaterThan(MAX_TEXT_CHARS);
    expect(countTokens(huge)).toBe(countTokens(huge));
    const stats = tokenCacheStats();
    expect(stats.encodes).toBe(2);
    expect(stats.entries).toBe(0);
    expect(stats.chars).toBe(0);
  });

  it("bounds retained text and evicts oldest keys under pressure", () => {
    // 1200 texts of ~4k characters exceed the 4MB retained-character cap, so
    // eviction must actually run (not merely be asserted as an upper bound).
    const total = 1200;
    const body = "retained observation ".repeat(200);
    for (let i = 0; i < total; i++) countTokens(`${i}|${body}`);
    const stats = tokenCacheStats();
    expect(stats.encodes).toBe(total);
    expect(stats.entries).toBeLessThan(total);
    expect(stats.entries).toBeLessThanOrEqual(stats.maxEntries);
    expect(stats.chars).toBeLessThanOrEqual(stats.maxChars);
    // Eviction must not corrupt counts: a freshly inserted text still counts exactly.
    const text = `recent marker|${body}`;
    const tokens = countTokens(text);
    expect(countTokens(text)).toBe(tokens);
    expect(tokenCacheStats().hits).toBeGreaterThan(0);
  });
});

describe("model-specific tokenizer selection", () => {
  it("uses the model encoding and resolves provider-qualified IDs", () => {
    const text = "你好，这是包含中文和代码的上下文。";
    const older = countTokens(text, "gpt-4");
    const newer = countTokens(text, "gpt-4o");
    expect(older).not.toBe(newer);
    expect(countTokens(text, "openai/gpt-4")).toBe(older);
    expect(countTokens(text, "unknown-model")).toBe(newer);
    expect(countTokens(text)).toBe(newer);
  });
});
