import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./origin", () => ({ apiFetch: mocks.fetch }));
import { optimizeInput } from "./inputOptimization";
const input = { projectId: "p1", text: "原文" };
const signal = () => new AbortController().signal;
beforeEach(() => vi.resetAllMocks());

it("decodes fragmented UTF-8 frames and delivers text before completion", async () => {
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  mocks.fetch.mockResolvedValue(new Response(new ReadableStream({ start(c) { stream = c; } }), {
    headers: { "Content-Type": "text/event-stream" },
  }));
  const delta = vi.fn();
  const pending = optimizeInput(input, signal(), delta);
  const bytes = encoder.encode('event: delta\r\ndata: {"text":"- 清晰意图"}\r\n\r\n');
  for (const byte of bytes) stream.enqueue(Uint8Array.of(byte));
  await vi.waitFor(() => expect(delta).toHaveBeenCalledWith("- 清晰意图"));
  stream.enqueue(encoder.encode('event: result\ndata: {"text":"- 清晰意图","status":"optimized"}\n\n'));
  stream.close();
  expect(await pending).toEqual({ text: "- 清晰意图", status: "optimized" });
});

it.each([
  ['event: delta\ndata: {"text":"部分内容"}\n\n', "连接中断"],
  ['event: error\ndata: {"error":"provider failed"}\n\n', "provider failed"],
])("rejects incomplete and failed streams", async (body, message) => {
  mocks.fetch.mockResolvedValue(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
  await expect(optimizeInput(input, signal())).rejects.toThrow(message);
});

it("accepts JSON from older runtimes", async () => {
  mocks.fetch.mockResolvedValue(Response.json({ text: "改写", status: "optimized" }));
  expect(await optimizeInput(input, signal())).toEqual({ text: "改写", status: "optimized" });
});
