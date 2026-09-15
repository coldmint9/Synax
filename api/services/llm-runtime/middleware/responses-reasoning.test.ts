import http from "node:http";
import type { AddressInfo } from "node:net";
import { streamText } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { instantiateProvider, selectLanguageModel } from "../providers/provider-registry.js";
import { applyResponsesReasoningMiddleware } from "./responses-reasoning.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** DeepSeek Responses stream: chain-of-thought rides `response.reasoning_text.*`. */
function deepSeekEvents(deltas: string[], fullText: string | null) {
  return [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: "resp_1", object: "response", status: "in_progress", model: "deepseek-flash" },
    },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", status: "in_progress", summary: [] },
    },
    ...deltas.map((delta, index) => ({
      type: "response.reasoning_text.delta",
      sequence_number: 4 + index,
      item_id: "rs_1",
      output_index: 0,
      content_index: 0,
      delta,
    })),
    ...(fullText != null
      ? [
          {
            type: "response.reasoning_text.done",
            sequence_number: 20,
            item_id: "rs_1",
            output_index: 0,
            content_index: 0,
            text: fullText,
          },
        ]
      : []),
    {
      type: "response.output_item.done",
      sequence_number: 21,
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        status: "completed",
        content: [{ type: "reasoning_text", text: fullText ?? deltas.join("") }],
        summary: [],
      },
    },
    {
      type: "response.output_item.added",
      sequence_number: 30,
      output_index: 1,
      item: { type: "message", id: "msg_1", status: "in_progress", role: "assistant", content: [] },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 31,
      item_id: "msg_1",
      output_index: 1,
      content_index: 0,
      delta: "pong",
    },
    {
      type: "response.completed",
      sequence_number: 40,
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        model: "deepseek-flash",
        output: [],
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          total_tokens: 5,
          output_tokens_details: { reasoning_tokens: 7 },
        },
      },
    },
  ];
}

async function startDeepSeekStub(events: unknown[]): Promise<{
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const event of events) {
        res.write(
          `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      }
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

/** Concatenated reasoning text, ignoring reasoning-file parts. */
function reasoningText(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .map((part) => (part.type === "reasoning" ? part.text ?? "" : ""))
    .join("");
}

async function runStream(baseUrl: string, wrapped: boolean) {
  const client = await instantiateProvider(
    {
      id: "custom-api:deepseek",
      label: "DeepSeek",
      npm: "@ai-sdk/openai-compatible",
      api: undefined,
    },
    {
      providerId: "custom-api:deepseek",
      apiFormat: "openai-responses",
      baseUrl,
      apiKey: "sk-test",
    },
  );
  const raw = selectLanguageModel(client, "deepseek-flash", undefined, "openai-responses");
  const model = wrapped ? applyResponsesReasoningMiddleware(raw as never) : raw;
  const result = streamText({
    model: model as never,
    messages: [{ role: "user", content: "ping" }],
    providerOptions: { openai: { forceReasoning: true, reasoningEffort: "high" } },
    maxRetries: 0,
  });
  await result.consumeStream();
  return {
    text: await result.text,
    reasoning: reasoningText(await result.reasoning),
  };
}

describe("DeepSeek Responses reasoning recovery", () => {
  it("replays response.reasoning_text deltas into reasoning parts", async () => {
    const { baseUrl, requests } = await startDeepSeekStub(
      deepSeekEvents(["The user ", "greets me."], "The user greets me."),
    );

    const result = await runStream(baseUrl, true);

    expect(result.text).toBe("pong");
    expect(result.reasoning).toBe("The user greets me.");
    // recovery is adapter-side: the request body stays a clean Responses call
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: "deepseek-flash" });
    expect(JSON.stringify(requests[0])).not.toContain("include_raw_chunks");
  });

  it("does not duplicate reasoning when the done event repeats the full text", async () => {
    const { baseUrl } = await startDeepSeekStub(
      deepSeekEvents(["alpha", "beta"], "alphabeta"),
    );

    const result = await runStream(baseUrl, true);

    expect(result.reasoning).toBe("alphabeta");
  });

  it("falls back to the completed item content when no deltas streamed", async () => {
    const { baseUrl } = await startDeepSeekStub(deepSeekEvents([], "silent reasoning"));

    const result = await runStream(baseUrl, true);

    expect(result.reasoning).toBe("silent reasoning");
  });

  it("leaves reasoning empty without the middleware, reproducing the reported bug", async () => {
    const { baseUrl } = await startDeepSeekStub(
      deepSeekEvents(["The user ", "greets me."], "The user greets me."),
    );

    const result = await runStream(baseUrl, false);

    expect(result.text).toBe("pong");
    expect(result.reasoning).toBe("");
  });
});
