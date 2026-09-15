import { describe, expect, it, vi } from "vitest";
const gateway = vi.hoisted(() => ({ createGatewayStream: vi.fn() }));
vi.mock("../../llm-runtime/gateway.js", () => gateway);
import type { LoopModelStreamEvent } from "../contracts.js";
import { streamLoopModelStep } from "../loop-model-stream.js";
import { buildLoopToolSet } from "../loop-ai-tools.js";

const input = {
  request: {
    purpose: "executor",
    messages: [{ role: "user" as const, content: "Inspect" }],
  },
  tools: buildLoopToolSet([]),
  mustFinalize: false,
  model: "fixture",
};
describe("provider protocol preservation", () => {
  it("preserves reasoning signatures, tool signatures and usage separately from visible output", async () => {
    gateway.createGatewayStream.mockResolvedValue({
      fullStream: (async function* () {
        yield { type: "reasoning-start", id: "r" };
        yield { type: "reasoning-delta", id: "r", text: "reasoning" };
        yield {
          type: "reasoning-end",
          id: "r",
          providerMetadata: { anthropic: { signature: "signed-thinking" } },
        };
        yield {
          type: "tool-call",
          toolCallId: "call1",
          toolName: "file_read",
          input: { path: "a.ts" },
          providerMetadata: { google: { thoughtSignature: "signed-tool" } },
        };
        yield {
          type: "finish-step",
          finishReason: "tool-calls",
          usage: { inputTokens: 42, outputTokens: 9 },
        };
        yield { type: "finish", finishReason: "tool-calls" };
      })(),
    });
    const events = [];
    for await (const event of streamLoopModelStep(input)) events.push(event);
    const final = events.find((e) => e.type === "step_complete");
    expect(
      final?.type === "step_complete" && final.step.reasoningParts,
    ).toEqual([
      {
        text: "reasoning",
        providerMetadata: { anthropic: { signature: "signed-thinking" } },
      },
    ]);
    expect(
      final?.type === "step_complete" &&
        final.step.toolCallProviderMetadata?.call1,
    ).toEqual({ google: { thoughtSignature: "signed-tool" } });
    expect(
      events.some((e) => e.type === "usage" && e.usage.inputTokens === 42),
    ).toBe(true);
  });
  it("emits known usage before a later transport error rather than silently dropping it", async () => {
    gateway.createGatewayStream.mockResolvedValue({
      fullStream: (async function* () {
        yield {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 100, outputTokens: 20 },
        };
        throw new Error("transport disconnected");
      })(),
    });
    const seen: LoopModelStreamEvent[] = [];
    await expect(
      (async () => {
        for await (const e of streamLoopModelStep(input)) seen.push(e);
      })(),
    ).rejects.toThrow("transport disconnected");
    expect(seen).toContainEqual({
      type: "usage",
      usage: expect.objectContaining({
        inputTokens: 100,
        outputTokens: 20,
        normalization: expect.objectContaining({ version: 1, source: "sdk" }),
      }),
    });
  });
});
