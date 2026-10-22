import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll } from "vitest";
import type { NativeTestModel } from "./native-generation.js";
import { ensureTestRuntime } from "./rust-runtime.js";

beforeAll(ensureTestRuntime);
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
type Protocol = "openai" | "openai-responses" | "anthropic";
type Options = { apiKey?: string; name?: string; baseURL?: string; fetch: typeof fetch };

/** Old transport fixtures now serve as local upstreams of the real Rust SDK. */
function provider(options: Options, defaultProtocol: Protocol) {
  let listening: Promise<string> | undefined;
  const endpoint = () => listening ??= (async () => {
    const server = http.createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString("utf8");
        const response = await options.fetch(`http://fixture.invalid${req.url}`, { method: "POST", body });
        res.writeHead(response.status, { "content-type": response.headers.get("content-type")?.includes("event-stream") ? "text/event-stream" : response.ok ? "text/event-stream" : "application/json" });
        if (!response.ok || response.headers.get("content-type")?.includes("event-stream")) {
          if (response.body) for await (const chunk of response.body) res.write(chunk);
          res.end(); return;
        }
        const value = await response.json() as any;
        const event = (type: string, data: object) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
        if (req.url?.endsWith("/messages")) {
          event("message_start", { message: { ...value, content: [] } });
          for (const [index, block] of (value.content ?? []).entries()) {
            event("content_block_start", { index, content_block: block });
            event("content_block_stop", { index });
          }
          event("message_delta", { delta: { stop_reason: value.stop_reason ?? "end_turn" }, usage: value.usage });
          event("message_stop", {});
        } else if (req.url?.endsWith("/responses")) {
          event("response.created", { response: { ...value, output: [] } });
          for (const [index, item] of (value.output ?? []).entries()) {
            event("response.output_item.added", { output_index: index, item });
            event("response.output_item.done", { output_index: index, item });
          }
          event("response.completed", { response: value });
        } else {
          res.write(`data: ${JSON.stringify({ ...value, object: "chat.completion.chunk", choices: value.choices?.map((choice: any) => ({ ...choice, delta: choice.message, message: undefined })) })}\n\n`);
          res.write("data: [DONE]\n\n");
        }
        res.end();
      } catch (error) { res.destroy(error as Error); }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  })();
  const languageModel = (model: string, protocol = defaultProtocol): NativeTestModel => ({
    request: async () => ({ apiFormat: protocol, providerId: options.name ?? (protocol === "anthropic" ? "anthropic" : "openai"),
      apiKey: options.apiKey ?? "fixture", baseUrl: await endpoint(), model, prompt: [] }),
  });
  return Object.assign(languageModel, { languageModel, chatModel: languageModel,
    chat: (model: string) => languageModel(model, "openai"),
    responses: (model: string) => languageModel(model, "openai-responses"),
    messages: (model: string) => languageModel(model, "anthropic") });
}
export const createRustMessages = (options: Options) => provider(options, "anthropic");
export const createRustOpenAI = (options: Options) => provider(options, "openai-responses");
export const createRustCompatible = (options: Options) => provider(options, "openai");
