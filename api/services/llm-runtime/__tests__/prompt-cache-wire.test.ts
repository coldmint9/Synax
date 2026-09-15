import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool, type ToolSet } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  applyPromptCachePolicy,
  createHistoryCacheAnchor,
  type HistoryCacheAnchor,
} from "../cache-policy.js";
import { toModelPrompt } from "../prompt.js";
import { buildProtocolProviderOptions } from "../protocol-options.js";
import type { LlmGatewayMessage, ResolvedModelSelection } from "../types.js";

const marker = { type: "ephemeral" };
const cached = { anthropic: { cacheControl: marker } };
const reminder = (id: string): LlmGatewayMessage => ({
  role: "user",
  content: `<system-reminder>\n${id}\n</system-reminder>`,
});

function selection(
  apiFormat: ResolvedModelSelection["apiFormat"] = "anthropic",
  mode: unknown = "auto",
): ResolvedModelSelection {
  const npm =
    apiFormat === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai";
  return {
    model: "private/model",
    modelId: "model",
    providerId: "private",
    apiFormat,
    provider: {
      id: "private",
      label: "Private",
      npm,
      env: [],
      supported: true,
      models: [],
    },
    modelDef: { id: "model", label: "Model" },
    config: { providerId: "private", options: { promptCaching: mode } },
  };
}

// Inspect JSON on the real SDK transport, not intermediate gateway options.
function transport(payload: unknown) {
  const requests: Record<string, any>[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, requests };
}

function cacheBlocks(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.flatMap(cacheBlocks);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, any>;
  return [
    ...("cache_control" in record ? [record] : []),
    ...Object.values(record).flatMap(cacheBlocks),
  ];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !ArrayBuffer.isView(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

async function captureAnthropic(
  messages: LlmGatewayMessage[],
  tools?: ToolSet,
  mode: unknown = "auto",
  cacheControl?: boolean,
  previousHistoryAnchor?: HistoryCacheAnchor,
) {
  const capture = transport({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 1 },
  });
  const processed = applyPromptCachePolicy(messages, {
    selection: selection("anthropic", mode),
    tools,
    cacheControl,
    previousHistoryAnchor,
  });
  const result = await generateText({
    model: createAnthropic({ apiKey: "local-test", fetch: capture.fetch })(
      "claude-sonnet-4-5",
    ),
    ...toModelPrompt(processed.messages),
    tools: processed.tools,
    maxRetries: 0,
  });
  expect(capture.requests).toHaveLength(1);
  const body = capture.requests[0];
  const wireMarkers = cacheBlocks([
    body.tools ?? [],
    body.system ?? [],
    body.messages ?? [],
  ]);
  expect(wireMarkers.length).toBeLessThanOrEqual(4);
  let seenFiveMinutes = false;
  for (const block of wireMarkers) {
    if (block.cache_control.ttl === "1h") expect(seenFiveMinutes).toBe(false);
    else seenFiveMinutes = true;
  }
  return { body: capture.requests[0], processed, warnings: result.warnings };
}

describe("prompt cache policy actual SDK wire", () => {
  it("preserves explicit compatible one-hour TTLs on preferred system and history boundaries", async () => {
    const oneHour = {
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    };
    const { body } = await captureAnthropic([
      { role: "system", content: "system", providerOptions: oneHour },
      { role: "user", content: "old boundary", providerOptions: oneHour },
      reminder("old"),
      { role: "assistant", content: "new boundary", providerOptions: oneHour },
      reminder("latest"),
    ]);
    expect(cacheBlocks(body).map((block) => block.cache_control.ttl)).toEqual([
      "1h",
      "1h",
      "1h",
    ]);
  });

  it("drops conflicting lower-priority one-hour history rather than upgrading a default system boundary", async () => {
    const { body } = await captureAnthropic([
      { role: "system", content: "system" },
      {
        role: "user",
        content: "one-hour history",
        providerOptions: {
          anthropic: { cache_control: { type: "ephemeral", ttl: "1h" } },
        },
      },
      { role: "assistant", content: "old boundary" },
      reminder("old"),
      { role: "assistant", content: "new boundary" },
      reminder("latest"),
    ]);
    expect(
      cacheBlocks(body).map((block) => [
        block.text,
        block.cache_control.ttl ?? "5m",
      ]),
    ).toEqual([
      ["system", "5m"],
      ["old boundary", "5m"],
      ["new boundary", "5m"],
    ]);
  });

  it("checks tool TTLs in wire order and rejects an earlier low-priority 5m tool before preferred 1h system", async () => {
    const tools = {
      short: tool({ inputSchema: z.object({}), providerOptions: cached }),
      long: tool({
        inputSchema: z.object({}),
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        },
      }),
    };
    const { body } = await captureAnthropic(
      [
        {
          role: "system",
          content: "system",
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
          },
        },
        { role: "user", content: "history" },
        reminder("latest"),
      ],
      tools,
    );
    expect(body.tools[0]).not.toHaveProperty("cache_control");
    expect(body.tools[1].cache_control.ttl).toBe("1h");
    expect(body.system[0].cache_control.ttl).toBe("1h");
  });

  it("does not upgrade an earlier preferred 5m system for a conflicting explicit 1h preferred history", async () => {
    const { body } = await captureAnthropic([
      { role: "system", content: "system" },
      {
        role: "user",
        content: "old boundary",
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
        },
      },
      reminder("old"),
      { role: "assistant", content: "new boundary" },
      reminder("latest"),
    ]);
    expect(cacheBlocks(body).map((block) => block.text)).toEqual([
      "system",
      "new boundary",
    ]);
  });

  it("retains a verified prefix anchor across more than 20 new blocks", async () => {
    const first: LlmGatewayMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "root" },
      { role: "assistant", content: "old boundary", providerOptions: cached },
      reminder("old"),
    ];
    const anchor = createHistoryCacheAnchor(first);
    const next: LlmGatewayMessage[] = [
      ...first,
      {
        role: "assistant",
        content: Array.from({ length: 25 }, (_, i) => ({
          type: "text",
          text: `new ${i}`,
        })),
      },
      reminder("latest"),
    ];
    deepFreeze(next);
    expect(anchor).toEqual({
      version: 1,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(createHistoryCacheAnchor(next, 3)).toEqual(anchor);
    const { body } = await captureAnthropic(
      next,
      undefined,
      "auto",
      undefined,
      anchor,
    );
    expect(cacheBlocks(body).map((block) => block.text)).toEqual([
      "system",
      "old boundary",
      "new 24",
    ]);
  });

  it.each(["system", "earlier-history", "boundary", "compaction"])(
    "rejects stale prefix identity after %s changes, even with a preexisting old marker",
    async (change) => {
      const first: LlmGatewayMessage[] = [
        { role: "system", content: "system" },
        { role: "user", content: "root" },
        { role: "assistant", content: "old boundary", providerOptions: cached },
        reminder("old"),
      ];
      const anchor = createHistoryCacheAnchor(first);
      const next: LlmGatewayMessage[] = [
        ...structuredClone(first),
        { role: "assistant", content: "new boundary" },
        reminder("latest"),
      ];
      if (change === "system")
        next[0] = { role: "system", content: "changed system" };
      if (change === "earlier-history")
        next[1] = { role: "user", content: "changed root" };
      if (change === "boundary")
        next[2] = {
          role: "assistant",
          content: "changed old boundary",
          providerOptions: cached,
        };
      if (change === "compaction") next.splice(1, 1);
      deepFreeze(next);
      const { body } = await captureAnthropic(
        next,
        undefined,
        "auto",
        undefined,
        anchor,
      );
      expect(cacheBlocks(body).map((block) => block.text)).toEqual([
        change === "system" ? "changed system" : "system",
        "new boundary",
      ]);
    },
  );

  it("hashes marker-free prefix content without mutating messages or tool output data", () => {
    const first: LlmGatewayMessage[] = [
      { role: "system", content: "system", providerOptions: cached },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c", toolName: "lookup", input: {} },
        ],
      },
      {
        role: "tool",
        providerOptions: cached,
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            toolName: "lookup",
            output: {
              type: "content",
              value: [
                { type: "text", text: "result", providerOptions: cached },
              ],
            },
          },
        ],
      },
      reminder("latest"),
    ];
    deepFreeze(first);
    const expected = createHistoryCacheAnchor(first);
    const stripped = applyPromptCachePolicy(first, {
      selection: selection(),
      cacheControl: false,
    }).messages;
    expect(createHistoryCacheAnchor(stripped)).toEqual(expected);
    const marked = applyPromptCachePolicy(first, {
      selection: selection(),
    }).messages;
    expect(createHistoryCacheAnchor(marked)).toEqual(expected);
    expect(
      createHistoryCacheAnchor([
        ...first.slice(0, -1),
        reminder("different latest body"),
      ]),
    ).toEqual(expected);
    const jsonMessages: LlmGatewayMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            toolName: "lookup",
            output: {
              type: "json",
              value: {
                providerOptions: {
                  anthropic: { cacheControl: "real tool data" },
                },
              },
            },
          },
        ],
      },
      reminder("latest"),
    ];
    const changed = structuredClone(jsonMessages);
    if (
      changed[0].role === "tool" &&
      changed[0].content[0].type === "tool-result"
    ) {
      changed[0].content[0].output = {
        type: "json",
        value: {
          providerOptions: { anthropic: { cacheControl: "changed tool data" } },
        },
      };
    }
    expect(createHistoryCacheAnchor(changed)).not.toEqual(
      createHistoryCacheAnchor(jsonMessages),
    );
  });

  it("includes binary, URL, signatures and metadata in the prefix identity, excluding trailing non-cacheable reasoning", () => {
    const messages: LlmGatewayMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", image: new Uint8Array([1, 2, 3]) },
          {
            type: "file",
            data: new URL("https://example.invalid/a.pdf"),
            mediaType: "application/pdf",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: { anthropic: { signature: "exact signature" } },
          },
          {
            type: "text",
            text: "eligible end",
            providerOptions: { custom: { a: 1, b: 2 } },
          },
          {
            type: "reasoning",
            text: "excluded trailing reasoning",
            providerOptions: { anthropic: { signature: "tail" } },
          },
        ],
      },
      reminder("latest"),
    ];
    deepFreeze(messages);
    const expected = createHistoryCacheAnchor(messages);
    const reordered: LlmGatewayMessage[] = [
      messages[0],
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: { anthropic: { signature: "exact signature" } },
          },
          {
            type: "text",
            text: "eligible end",
            providerOptions: { custom: { b: 2, a: 1 } },
          },
          { type: "reasoning", text: "changed trailing reasoning" },
        ],
      },
      reminder("changed latest"),
    ];
    expect(createHistoryCacheAnchor(reordered)).toEqual(expected);
    for (const content of [
      [
        { type: "image" as const, image: new Uint8Array([1, 2, 4]) },
        {
          type: "file" as const,
          data: new URL("https://example.invalid/a.pdf"),
          mediaType: "application/pdf",
        },
      ],
      [
        { type: "image" as const, image: new Uint8Array([1, 2, 3]) },
        {
          type: "file" as const,
          data: new URL("https://example.invalid/b.pdf"),
          mediaType: "application/pdf",
        },
      ],
    ])
      expect(
        createHistoryCacheAnchor([
          { role: "user", content },
          ...messages.slice(1),
        ]),
      ).not.toEqual(expected);
    expect(
      createHistoryCacheAnchor([
        messages[0],
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "thinking",
              providerOptions: {
                anthropic: { signature: "changed signature" },
              },
            },
            {
              type: "text",
              text: "eligible end",
              providerOptions: { custom: { a: 1, b: 2 } },
            },
          ],
        },
        reminder("latest"),
      ]),
    ).not.toEqual(expected);
  });

  it("keeps non-Native latest-user fallback and explicit reminder boundaries", () => {
    const messages: LlmGatewayMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "root" },
      { role: "assistant", content: "history" },
      { role: "user", content: "current input" },
    ];
    expect(createHistoryCacheAnchor(messages)).toEqual(
      createHistoryCacheAnchor(messages, 3),
    );
    expect(
      createHistoryCacheAnchor([
        ...messages.slice(0, -1),
        { role: "user", content: "different current input" },
      ]),
    ).toEqual(createHistoryCacheAnchor(messages));
  });

  it("copies message/content metadata and keeps separate system bytes and ordering", () => {
    const messages: LlmGatewayMessage[] = [
      {
        role: "system",
        content: "  first\n",
        providerOptions: { custom: { label: "first" }, ...cached },
      },
      {
        role: "system",
        content: "second  ",
        providerOptions: { custom: { label: "second" } },
      },
      {
        role: "user",
        providerOptions: { custom: { label: "message" } },
        content: [
          {
            type: "text",
            text: "verbatim",
            providerOptions: {
              custom: { label: "content" },
              openai: { promptCacheBreakpoint: { mode: "explicit" } },
            },
          },
        ],
      },
    ];
    deepFreeze(messages);
    const converted = toModelPrompt(messages);
    expect(converted.system).toEqual(messages.slice(0, 2));
    expect(converted.messages).toEqual(messages.slice(2));
    const systems = converted.system as Exclude<
      typeof converted.system,
      string | undefined
    >;
    expect(systems[0]).not.toBe(messages[0]);
    expect(systems[0].providerOptions?.custom).not.toBe(
      messages[0].providerOptions?.custom,
    );
    expect(converted.messages[0].providerOptions?.custom).not.toBe(
      messages[2].providerOptions?.custom,
    );
    const part = (
      converted.messages[0].content as Array<{ providerOptions?: unknown }>
    )[0];
    const originalPart = (
      messages[2].content as Array<{ providerOptions?: unknown }>
    )[0];
    expect(part.providerOptions).not.toBe(originalPart.providerOptions);
  });

  it("retains the prior request boundary beyond 20 new blocks, budgets system/history/tools, and excludes the current reminder", async () => {
    const tools = deepFreeze(
      Object.fromEntries(
        ["one", "two", "three"].map((name) => [
          name,
          tool({
            inputSchema: z.object({}),
            providerOptions: cached,
          }),
        ]),
      ),
    );
    const first: LlmGatewayMessage[] = [
      { role: "system", content: "system A", providerOptions: cached },
      { role: "system", content: "system B", providerOptions: cached },
      {
        role: "user",
        content: "previous history end",
        providerOptions: cached,
      },
      reminder("step 1"),
    ];
    const next: LlmGatewayMessage[] = [
      ...first,
      {
        role: "assistant",
        content: Array.from({ length: 25 }, (_, i) => ({
          type: "text" as const,
          text: `new block ${i}`,
          providerOptions: cached,
        })),
      },
      { ...reminder("step 2"), providerOptions: cached },
    ];
    deepFreeze(next);
    const previous = await captureAnthropic(first, tools);
    const current = await captureAnthropic(next, tools);
    const marked = cacheBlocks(current.body);
    expect(marked).toHaveLength(4);
    expect(marked.map((block) => block.text).filter(Boolean)).toEqual([
      "system A",
      "system B",
      "previous history end",
      "new block 24",
    ]);
    expect(
      cacheBlocks(previous.body).some(
        (block) => block.text === "previous history end",
      ),
    ).toBe(true);
    expect(marked.some((block) => String(block.text).includes("step 2"))).toBe(
      false,
    );
    expect(current.warnings ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: "cacheControl breakpoint limit" }),
      ]),
    );
    expect(next[4].providerOptions).toBeUndefined();
    expect(tools.one.providerOptions).toEqual(cached);
  });

  it("preserves legal preexisting tool markers only within the shared remaining budget", async () => {
    const tools = Object.fromEntries(
      ["one", "two", "three", "four"].map((name) => [
        name,
        tool({
          inputSchema: z.object({}),
          providerOptions: {
            anthropic: { cache_control: marker },
            custom: { keep: name },
          },
        }),
      ]),
    );
    deepFreeze(tools);
    const { body, processed } = await captureAnthropic(
      [
        { role: "system", content: "system" },
        { role: "user", content: "old history" },
        reminder("old"),
        { role: "assistant", content: "new history" },
        reminder("latest"),
      ],
      tools,
    );
    expect(cacheBlocks(body)).toHaveLength(4);
    expect(
      body.tools
        .filter((entry: any) => entry.cache_control)
        .map((entry: any) => entry.name),
    ).toEqual(["one"]);
    expect(processed.tools?.one.providerOptions?.custom).toEqual({
      keep: "one",
    });
  });

  it("keeps signatures, redacted reasoning, media, tool pairing, and metadata without marking thinking", async () => {
    const messages: LlmGatewayMessage[] = [
      {
        role: "system",
        content: "  untouched system\n",
        providerOptions: { custom: { keep: "system" }, ...cached },
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "inspect",
            providerOptions: { custom: { keep: "part" } },
          },
          {
            type: "image",
            image: new Uint8Array([1, 2, 3]),
            mediaType: "image/png",
          },
        ],
        providerOptions: { custom: { keep: "user" }, ...cached },
      },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "signed thinking",
            providerOptions: {
              anthropic: { signature: "sig-exact", cacheControl: marker },
              openai: { reasoningEncryptedContent: "encrypted-exact" },
            },
          },
          {
            type: "reasoning",
            text: "",
            providerOptions: {
              anthropic: {
                redactedData: "redacted-exact",
                cache_control: marker,
              },
            },
          },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "lookup",
            input: {},
          },
        ],
        providerOptions: { custom: { keep: "assistant" }, ...cached },
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "lookup",
            output: {
              type: "text",
              value: "found",
              providerOptions: {
                anthropic: { cache_control: marker },
                custom: { keep: "output" },
              },
            },
          },
        ],
        providerOptions: { custom: { keep: "tool" } },
      },
      reminder("latest"),
    ];
    const original = structuredClone(messages);
    deepFreeze(messages);
    const { body, processed, warnings } = await captureAnthropic(messages);
    expect(messages).toEqual(original);
    expect(body.system[0].text).toBe("  untouched system\n");
    const parts = body.messages.flatMap((message: any) => message.content);
    expect(parts).toEqual(
      expect.arrayContaining([
        {
          type: "thinking",
          thinking: "signed thinking",
          signature: "sig-exact",
        },
        { type: "redacted_thinking", data: "redacted-exact" },
        expect.objectContaining({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AQID" },
        }),
        expect.objectContaining({
          type: "tool_use",
          id: "call-1",
          name: "lookup",
        }),
        expect.objectContaining({ type: "tool_result", tool_use_id: "call-1" }),
      ]),
    );
    expect(cacheBlocks(body).length).toBeLessThanOrEqual(4);
    expect(warnings ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          feature: "cache_control on non-cacheable context",
        }),
      ]),
    );
    const converted = toModelPrompt(processed.messages);
    expect(
      converted.messages.map(
        (message) => message.providerOptions?.custom?.keep,
      ),
    ).toEqual(["user", "assistant", "tool", undefined]);
    expect(processed.messages[2].content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          providerOptions: {
            anthropic: { signature: "sig-exact" },
            openai: { reasoningEncryptedContent: "encrypted-exact" },
          },
        }),
      ]),
    );
  });

  it("falls back before trailing thinking without counting discarded thinking markers", async () => {
    const { body } = await captureAnthropic([
      { role: "system", content: "system" },
      { role: "user", content: "question" },
      {
        role: "assistant",
        providerOptions: cached,
        content: [
          { type: "text", text: "eligible end" },
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: {
              anthropic: { signature: "sig", cacheControl: marker },
            },
          },
        ],
      },
      reminder("latest"),
    ]);
    expect(cacheBlocks(body).map((block) => block.text)).toEqual([
      "system",
      "eligible end",
    ]);
  });

  it.each([
    ["off", undefined],
    ["on", false],
    ["auto", false],
  ] as const)(
    "strips both cache aliases everywhere when mode=%s request=%s",
    async (mode, cacheControl) => {
      const messages: LlmGatewayMessage[] = [
        { role: "system", content: "system", providerOptions: cached },
        { role: "user", content: "question", providerOptions: cached },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "lookup",
              input: {},
              providerOptions: cached,
            },
          ],
        },
        {
          role: "tool",
          providerOptions: cached,
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "lookup",
              providerOptions: cached,
              output: {
                type: "content",
                value: [
                  {
                    type: "text",
                    text: "result",
                    providerOptions: {
                      anthropic: { cache_control: marker },
                      custom: { keep: true },
                    },
                  },
                ],
              },
            },
          ],
        },
        reminder("latest"),
      ];
      const tools = {
        lookup: tool({ inputSchema: z.object({}), providerOptions: cached }),
      };
      deepFreeze(messages);
      const { body, processed } = await captureAnthropic(
        messages,
        tools,
        mode,
        cacheControl,
      );
      expect(cacheBlocks(body)).toEqual([]);
      expect(JSON.stringify(processed)).not.toContain("cacheControl");
      expect(JSON.stringify(processed)).not.toContain("cache_control");
      expect(JSON.stringify(processed)).toContain('"keep":true');
    },
  );

  it.each(["openai", "openai-responses"] as const)(
    "never sends Anthropic fields on %s; keeps explicit Responses options",
    async (apiFormat) => {
      const payload =
        apiFormat === "openai"
          ? {
              id: "chat_test",
              object: "chat.completion",
              created: 1,
              model: "gpt-4o-mini",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "ok" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 3,
                completion_tokens: 1,
                total_tokens: 4,
              },
            }
          : {
              id: "resp_test",
              object: "response",
              created_at: 1,
              status: "completed",
              model: "gpt-4o-mini",
              output: [
                {
                  type: "message",
                  id: "msg_test",
                  status: "completed",
                  role: "assistant",
                  content: [
                    { type: "output_text", text: "ok", annotations: [] },
                  ],
                },
              ],
              usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
            };
      const capture = transport(payload);
      const selected = selection(apiFormat, "on");
      const messages: LlmGatewayMessage[] = [
        { role: "system", content: "static", providerOptions: cached },
        { role: "user", content: "question", providerOptions: cached },
        reminder("latest"),
      ];
      if (apiFormat === "openai-responses") {
        messages.splice(2, 0, {
          role: "assistant",
          providerOptions: { custom: { keep: "message metadata" } },
          content: [
            {
              type: "reasoning",
              text: "exact summary",
              providerOptions: {
                anthropic: {
                  signature: "keep-signature",
                  cacheControl: marker,
                },
                openai: {
                  itemId: "rs_test",
                  reasoningEncryptedContent: "encrypted-exact",
                },
              },
            },
            { type: "text", text: "prior answer" },
          ],
        });
      }
      deepFreeze(messages);
      const processed = applyPromptCachePolicy(messages, {
        selection: selected,
        tools: {
          lookup: tool({ inputSchema: z.object({}), providerOptions: cached }),
        },
      });
      const openai = createOpenAI({
        apiKey: "local-test",
        fetch: capture.fetch,
      });
      await generateText({
        model:
          apiFormat === "openai"
            ? openai.chat("gpt-4o-mini")
            : openai.responses("gpt-4o-mini"),
        ...toModelPrompt(processed.messages),
        tools: processed.tools,
        maxRetries: 0,
        providerOptions: buildProtocolProviderOptions(selected, {
          responseOptions: {
            store: false,
            promptCacheKey: "stable-key",
            metadata: { source: "test" },
          },
        }),
      });
      expect(cacheBlocks(capture.requests[0])).toEqual([]);
      expect(JSON.stringify(capture.requests[0])).not.toContain("anthropic");
      expect(JSON.stringify(capture.requests[0])).not.toContain(
        "promptCaching",
      );
      if (apiFormat === "openai-responses") {
        expect(capture.requests[0]).toMatchObject({
          store: false,
          prompt_cache_key: "stable-key",
          metadata: { source: "test" },
        });
        expect(capture.requests[0].input).toEqual(
          expect.arrayContaining([
            {
              type: "reasoning",
              id: "rs_test",
              encrypted_content: "encrypted-exact",
              summary: [{ type: "summary_text", text: "exact summary" }],
            },
          ]),
        );
      }
    },
  );

  it("uses only surviving reminder boundaries after compression, and accepts explicit reminder indices", () => {
    const messages: LlmGatewayMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "compacted history" },
      { role: "user", content: "custom latest reminder" },
    ];
    const result = applyPromptCachePolicy(messages, {
      selection: selection(),
      runtimeReminderIndices: [2],
    });
    expect(result.messages[1].providerOptions).toEqual(cached);
    expect(result.messages[2].providerOptions).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("previous history end");
  });
});
