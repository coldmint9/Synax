import { createOpenAI } from "@ai-sdk/openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultGlobalConfig } from "../../../lib/config/config-defaults.js";
import { resolveLlmSelection } from "../resolver.js";
import { executePipeline } from "../pipeline.js";
import { resolveMediaMessages } from "../../agent-runtime/media-capabilities.js";
import type { LlmGatewayMessage, ResolvedModelSelection } from "../types.js";

const fixture = vi.hoisted(() => ({
  requests: [] as Record<string, any>[],
  mode: "responses",
  bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
}));
vi.mock("../../agent-runtime/media-assets.js", () => ({
  getAsset: (id: string) => ({
    id,
    projectId: "project",
    filename: id === "audio" ? "voice.mp3" : "image.png",
    mediaType: id === "audio" ? "audio/mpeg" : "image/png",
    size: 8,
    sha256: "fixture",
    createdAt: "",
  }),
  readAsset: async () => fixture.bytes,
  validateAssets: vi.fn(),
}));
vi.mock("../providers/provider-cache.js", () => ({
  getOrCreateClient: async () =>
    createOpenAI({
      apiKey: "fixture",
      fetch: async (_url, init) => {
        fixture.requests.push(JSON.parse(String(init?.body)));
        return Response.json(
          fixture.mode === "chat"
            ? {
                id: "chat",
                created: 1,
                model: "gpt-5.6-sol",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "ok" },
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              }
            : {
                id: "resp",
                created_at: 1,
                model: "gpt-5.6-sol",
                status: "completed",
                output: [
                  {
                    type: "message",
                    id: "msg",
                    role: "assistant",
                    status: "completed",
                    content: [
                      { type: "output_text", text: "ok", annotations: [] },
                    ],
                  },
                ],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
        );
      },
    }),
}));
function selection(
  model = "gpt-5.6-sol",
  modalities?: Array<"text" | "image" | "file">,
): ResolvedModelSelection {
  const globalConfig = structuredClone(createDefaultGlobalConfig());
  globalConfig.providers.find((provider) => provider.id === "openai")!.models =
    [{ id: model, label: model, inputModalities: modalities }];
  globalConfig.providerConnections.openai = {
    providerId: "openai",
    apiKey: "fixture",
    extra: {
      model,
      apiFormat: fixture.mode === "chat" ? "openai" : "openai-responses",
    },
  };
  return resolveLlmSelection({
    catalog: { providers: [], source: "snapshot", fetchedAt: "" },
    globalConfig,
    purpose: "agent",
    modelOverride: `openai/${model}`,
  });
}
const image: LlmGatewayMessage = {
  role: "user",
  content: [
    { type: "text", text: "Inspect" },
    {
      type: "file",
      data: new URL("synax-asset:image"),
      mediaType: "image/png",
      providerOptions: { openai: { imageDetail: "original" } },
    },
  ],
};
beforeEach(() => {
  fixture.requests.length = 0;
  fixture.mode = "responses";
});
describe("generic multimodal message transport", () => {
  it("recognizes Sol without the remote catalog and sends original image bytes and all reasoning efforts", async () => {
    const chosen = selection();
    expect(chosen.modelDef).toMatchObject({
      inputModalities: ["text", "image", "file"],
      reasoning: true,
      contextLimit: 1050000,
    });
    for (const effort of [
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ] as const) {
      await executePipeline(
        {
          projectId: "project",
          purpose: "agent",
          messages: [image],
          reasoningEffort: effort,
        },
        chosen,
        { kind: "text" },
      );
      const body = fixture.requests.at(-1)!;
      expect(body.model).toBe("gpt-5.6-sol");
      expect(body.reasoning.effort).toBe(effort);
      expect(body.input[0].content[1]).toMatchObject({
        type: "input_image",
        detail: "original",
        image_url: `data:image/png;base64,${fixture.bytes.toString("base64")}`,
      });
    }
  });
  it("sends images and none reasoning through Chat Completions as well", async () => {
    fixture.mode = "chat";
    await executePipeline(
      {
        projectId: "project",
        purpose: "agent",
        messages: [image],
        reasoningEffort: "none",
      },
      selection(),
      { kind: "text" },
    );
    expect(fixture.requests[0].reasoning_effort).toBe("none");
    expect(fixture.requests[0].messages[0].content[1].image_url.detail).toBe(
      "original",
    );
  });
  it("accepts arbitrary declared future vision models", async () => {
    await executePipeline(
      {
        projectId: "project",
        purpose: "agent",
        messages: [image],
        providerOptions: { openai: { metadata: { test: "generic" } } },
      },
      selection("future-vision-model", ["text", "image"]),
      { kind: "text" },
    );
    expect(fixture.requests[0].model).toBe("future-vision-model");
    expect(fixture.requests[0].input[0].content[1].type).toBe("input_image");
    expect(fixture.requests[0].metadata).toEqual({ test: "generic" });
  });
  it("preserves tool media as native Responses tool output with image detail", async () => {
    const messages: LlmGatewayMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call",
            toolName: "media",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "media",
            output: { type: "text", value: "result" },
          },
        ],
      },
      { ...image, providerOptions: { synax: { toolCallId: "call" } } },
    ];
    await executePipeline(
      { projectId: "project", purpose: "agent", messages },
      selection(),
      { kind: "text" },
    );
    const output = fixture.requests[0].input.find(
      (part: any) => part.type === "function_call_output",
    );
    expect(
      output.output.some(
        (part: any) =>
          part.type === "input_image" && part.detail === "original",
      ),
    ).toBe(true);
  });
  it("retains incompatible tool audio as an explicit asset reference while rejecting user audio", async () => {
    const audio: LlmGatewayMessage = {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "audio/mpeg",
          data: new URL("synax-asset:audio"),
        },
      ],
    };
    await expect(
      resolveMediaMessages([audio], selection(), "project"),
    ).rejects.toThrow("cannot receive");
    const compiled = await resolveMediaMessages(
      [{ ...audio, providerOptions: { synax: { toolCallId: "speech" } } }],
      selection(),
      "project",
    );
    expect(JSON.stringify(compiled)).toContain("Media asset retained");
    expect(JSON.stringify(compiled)).toContain("voice.mp3");
    expect(JSON.stringify(compiled)).not.toContain("synax-asset:");
  });
});
