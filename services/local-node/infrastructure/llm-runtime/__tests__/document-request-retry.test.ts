import { createAnthropic } from "@ai-sdk/anthropic";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRawSqlite } from "../../database/index.js";
import { createAsset, modelContentParts } from "../../../modules/agent-runtime/media-assets.js";
import { resolveMediaMessages } from "../../../modules/agent-runtime/media-capabilities.js";
import { registerFileParser } from "../../../modules/agent-runtime/file-input/index.js";
import { resetAgentRuntimeFixtures } from "../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js";
import { makePdf, flowchartDrawing } from "../../../modules/agent-runtime/__tests__/file-input-fixtures.js";
import { createHistoryCacheAnchor, type HistoryCacheAnchor } from "../cache-policy.js";
import type { LlmGatewayMessage, LlmGatewayRequest, ResolvedModelSelection } from "../types.js";

const fixture = vi.hoisted(() => ({ failNext: false, requests: [] as Record<string, any>[] }));
vi.mock("../providers/provider-cache.js", () => ({
  getOrCreateClient: async () => createAnthropic({
    apiKey: "fixture",
    fetch: async (_url, init) => {
      fixture.requests.push(JSON.parse(String(init?.body)));
      if (fixture.failNext) {
        fixture.failNext = false;
        throw new Error("fetch failed");
      }
      return new Response(JSON.stringify({
        id: "msg_fixture", type: "message", role: "assistant", model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      }), { headers: { "Content-Type": "application/json" } });
    },
  }),
}));
import { executePipeline } from "../pipeline.js";

const selection: ResolvedModelSelection = {
  providerId: "fixture", model: "fixture/model", modelId: "claude-sonnet-4-5", apiFormat: "anthropic",
  provider: { id: "fixture", label: "Fixture", npm: "@ai-sdk/anthropic", env: [], supported: true, models: [] },
  modelDef: { id: "claude-sonnet-4-5", label: "Fixture", inputModalities: ["text", "image"] },
  config: { providerId: "fixture", apiKey: "fixture" },
};
const projectId = "project-alpha";
const reminder: LlmGatewayMessage = { role: "system", content: "<system-reminder>Stable step</system-reminder>" };
const assetCount = () => (getRawSqlite().prepare("SELECT count(*) AS n FROM agent_runtime_assets").get() as { n: number }).n;
async function documentMessages(toolMedia = false): Promise<LlmGatewayMessage[]> {
  const asset = await createAsset(projectId, "diagram.pdf", makePdf("Same document", flowchartDrawing, 2), "application/pdf");
  const media: LlmGatewayMessage = {
    role: "user", content: modelContentParts([{ type: "file", assetId: asset.id }]),
    ...(toolMedia ? { providerOptions: { synax: { toolCallId: "read" } } } : {}),
  };
  return [
    { role: "system", content: "Stable instructions" },
    ...(toolMedia ? [
      { role: "user" as const, content: "Read document" },
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "read", toolName: "read", input: {} }] },
      { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "read", toolName: "read", output: { type: "text" as const, value: "Document result" } }] },
    ] : []),
    media, reminder,
  ];
}
function snapshotGuard() {
  let saved: HistoryCacheAnchor | undefined;
  const prepared: LlmGatewayMessage[][] = [];
  const onRequestPrepared: NonNullable<LlmGatewayRequest["onRequestPrepared"]> = info => {
    if (saved && saved.fingerprint !== info.historyAnchor.fingerprint)
      throw new Error("request_snapshot_changed");
    saved = info.historyAnchor;
    prepared.push(info.messages);
  };
  return { onRequestPrepared, prepared };
}
beforeEach(() => {
  resetAgentRuntimeFixtures();
  fixture.requests.length = 0;
  fixture.failNext = false;
});

describe("document request retry snapshots", () => {
  it.each([false, true])("retries the same PDF after a network failure without creating page assets (tool=%s)", async toolMedia => {
    const messages = await documentMessages(toolMedia);
    const original = JSON.stringify(messages);
    const before = assetCount();
    const guard = snapshotGuard();
    const request: LlmGatewayRequest = {
      projectId, purpose: "validate", messages, maxTokens: 32, maxRetries: 0,
      cacheControl: true, onRequestPrepared: guard.onRequestPrepared,
    };
    fixture.failNext = true;
    await expect(executePipeline(request, selection, { kind: "text" })).rejects.toThrow("fetch failed");
    await executePipeline(request, selection, { kind: "text" });
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]).toEqual(fixture.requests[0]);
    expect(guard.prepared).toHaveLength(2);
    expect(JSON.stringify(messages)).toBe(original);
    expect(assetCount()).toEqual(before);
    const blocks = fixture.requests[1].messages.flatMap((m: any) => m.content);
    const images = toolMedia
      ? blocks.find((b: any) => b.type === "tool_result").content.filter((b: any) => b.type === "image")
      : blocks.filter((b: any) => b.type === "image");
    expect(images).toHaveLength(2);
  });

  it.each([false, true])("keeps OpenAI Responses PDF history identical across preparations (tool=%s)", async toolMedia => {
    const messages = await documentMessages(toolMedia);
    const model: ResolvedModelSelection = {
      ...selection, apiFormat: "openai-responses",
      provider: { ...selection.provider, npm: "@ai-sdk/openai" },
    };
    const first = await resolveMediaMessages(messages, model, projectId);
    const second = await resolveMediaMessages(messages, model, projectId);
    expect(createHistoryCacheAnchor(second)).toEqual(createHistoryCacheAnchor(first));
    expect(second).toEqual(first);
    if (toolMedia) {
      const result = second.find(m => m.role === "tool")!;
      expect(result.content[0]).toMatchObject({ output: { type: "content" } });
    }
  });

  it("still rejects a genuinely changed rendered page before the retry is dispatched", async () => {
    const messages = await documentMessages();
    let bytes = Buffer.from("page-one");
    const unregister = registerFileParser({
      id: "retry-fixture", supports: input => input.mediaType === "application/pdf",
      parse: async () => ({ text: "Stable text", images: [{ page: 1, mediaType: "image/png", bytes }] }),
    });
    try {
      const guard = snapshotGuard();
      const request: LlmGatewayRequest = {
        projectId, purpose: "validate", messages, maxTokens: 32, maxRetries: 0,
        onRequestPrepared: guard.onRequestPrepared,
      };
      await executePipeline(request, selection, { kind: "text" });
      bytes = Buffer.from("page-two");
      await expect(executePipeline(request, selection, { kind: "text" })).rejects.toThrow("request_snapshot_changed");
      expect(fixture.requests).toHaveLength(1);
    } finally {
      unregister();
    }
  });
});
