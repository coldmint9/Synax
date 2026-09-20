import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const videoCalls = vi.hoisted(() => [] as any[]);
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { toolRegistry } from "../tool-registry.js";
import {
  deleteUnboundAsset,
  modelContentParts,
  readAsset,
  sessionHasAsset,
} from "../media-assets.js";
import { resolveMediaMessages } from "../media-capabilities.js";
import {
  executorInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";
import { saveGeneratedMedia } from "../generated-media.js";
import type { ResolvedModelSelection } from "../../llm-runtime/types.js";

const selection: ResolvedModelSelection = {
  model: "fixture/vision",
  modelId: "future-vision",
  providerId: "fixture",
  apiFormat: "openai-responses",
  provider: {
    id: "fixture",
    label: "Fixture",
    npm: "@ai-sdk/openai",
    env: [],
    models: [],
    supported: true,
  },
  config: {
    providerId: "fixture",
    apiKey: "fixture",
    baseUrl: "http://localhost:9876/v1",
  },
  modelDef: {
    id: "future-vision",
    label: "Vision",
    inputModalities: ["text", "image"],
  },
};
vi.mock("../tools/media-context.js", async (original) => ({
  ...(await original<typeof import("../tools/media-context.js")>()),
  resolveSessionMediaProvider: async (_input: unknown, providerId?: string) =>
    providerId === "video"
      ? {
          ...selection,
          provider: { ...selection.provider, id: "video", npm: "@ai-sdk/xai" },
        }
      : selection,
}));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
vi.mock(
  "../../llm-runtime/providers/provider-registry.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../../llm-runtime/providers/provider-registry.js")
      >();
    return {
      ...actual,
      instantiateProvider: async (provider: any, config: any) =>
        provider.id !== "video"
          ? actual.instantiateProvider(provider, config)
          : {
              videoModel: (modelId: string) => ({
                specificationVersion: "v4",
                provider: "fixture.video",
                modelId,
                maxVideosPerCall: 1,
                doGenerate: async (args: unknown) => {
                  videoCalls.push(args);
                  const bytes = Buffer.alloc(24);
                  bytes.write("ftyp", 4);
                  bytes.write("isom", 8);
                  return {
                    videos: [
                      { type: "binary", data: bytes, mediaType: "video/mp4" },
                    ],
                    warnings: [],
                    response: {
                      timestamp: new Date(),
                      modelId,
                      headers: undefined,
                    },
                  };
                },
              }),
            },
    };
  },
);
beforeEach(resetAgentRuntimeFixtures);
afterEach(() => vi.unstubAllGlobals());
describe("media tool assets survive the runtime boundary", () => {
  it("generates speech, transcribes the stored audio, and generates video through generic model factories", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const wav = Buffer.alloc(44);
    wav.write("RIFF");
    wav.write("WAVE", 8);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/audio/speech"))
          return new Response(wav, {
            headers: { "Content-Type": "audio/wav" },
          });
        return Response.json({
          text: "fixture speech",
          language: "english",
          duration: 1,
          segments: [
            {
              id: 0,
              seek: 0,
              text: "fixture speech",
              start: 0,
              end: 1,
              tokens: [],
              temperature: 0,
              avg_logprob: 0,
              compression_ratio: 1,
              no_speech_prob: 0,
            },
          ],
        });
      }),
    );
    const session = agentSessionRuntime.create(executorInput);
    const speech = await toolRegistry.execute(session.id, "media.speak", {
      model: "future-speech-model",
      text: "Hello",
      voice: "alloy",
      outputFormat: "wav",
    });
    expect(speech.record.status).toBe("completed");
    const part = speech.record.contentParts![0];
    if (part.type === "text") throw new Error("missing audio");
    expect(part.type).toBe("audio");
    expect(await readAsset(part.assetId)).toEqual(wav);
    const transcript = await toolRegistry.execute(
      session.id,
      "media.transcribe",
      { model: "future-transcription-model", audio: part.assetId },
    );
    expect(transcript.record.status, transcript.record.error ?? "").toBe(
      "completed",
    );
    expect(transcript.record.outputRef).toMatchObject({
      text: "fixture speech",
    });
    expect(JSON.parse(String(requests[0].init.body))).toMatchObject({
      model: "future-speech-model",
      input: "Hello",
      response_format: "wav",
    });
    expect((requests[1].init.body as FormData).get("model")).toBe(
      "future-transcription-model",
    );
    const video = await toolRegistry.execute(session.id, "media.video", {
      providerId: "video",
      model: "future-video-model",
      prompt: "A moving cloud",
      duration: 4,
      generateAudio: true,
      providerOptions: { xai: { customOption: "value" } },
    });
    expect(video.record.status, video.record.error ?? "").toBe("completed");
    expect(video.record.contentParts![0].type).toBe("video");
    expect(videoCalls.at(-1)).toMatchObject({
      prompt: "A moving cloud",
      duration: 4,
      generateAudio: true,
      providerOptions: { xai: { customOption: "value" } },
    });
  });
  it("generates, persists, rehydrates and edits an image without losing bytes", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        requests.push(init);
        return Response.json({ data: [{ b64_json: png.toString("base64") }] });
      }),
    );
    const session = agentSessionRuntime.create(executorInput);
    const first = await toolRegistry.execute(session.id, "media.generate", {
      model: "arbitrary-image-model",
      prompt: "Draw a test image",
      stream: false,
    });
    expect(first.record.status).toBe("completed");
    const part = first.record.contentParts![0];
    expect(part.type).toBe("image");
    if (part.type === "text") throw new Error("missing image");
    expect(sessionHasAsset(session.id, part.assetId)).toBe(true);
    expect(await readAsset(part.assetId, session.projectId)).toEqual(png);
    await expect(deleteUnboundAsset(part.assetId)).rejects.toThrow(
      "retained by a session",
    );
    const content = modelContentParts([part]);
    expect(content[0].text).toContain(part.assetId);
    const replay = await resolveMediaMessages(
      [{ role: "user", content }],
      selection,
      session.projectId,
    );
    expect(
      (replay[0].content as any[]).find((p) => p.type === "file").data,
    ).toEqual(png);
    const edit = await toolRegistry.execute(session.id, "media.generate", {
      model: "arbitrary-image-model",
      prompt: "Make the subject blue",
      images: [part.assetId],
      stream: false,
    });
    expect(edit.record.status).toBe("completed");
    expect(requests[1].body).toBeInstanceOf(FormData);
    expect(
      Buffer.from(
        await (
          (requests[1].body as FormData).get("image[]") as File
        ).arrayBuffer(),
      ),
    ).toEqual(png);
    expect(
      JSON.stringify(agentRuntimeStore.listToolCalls(session.id)),
    ).not.toContain(png.toString("base64"));
    const other = agentSessionRuntime.create(executorInput);
    const denied = await toolRegistry.execute(other.id, "media.generate", {
      prompt: "Edit",
      images: [part.assetId],
      stream: false,
    });
    expect(denied.record.status).toBe("failed");
    expect(denied.record.error).toContain("not attached");
    expect(requests).toHaveLength(2);
  });
  it("retains direct image, audio, video and file model outputs as typed assets", async () => {
    const session = agentSessionRuntime.create(executorInput);
    const wav = Buffer.alloc(44);
    wav.write("RIFF");
    wav.write("WAVE", 8);
    const mp4 = Buffer.alloc(24);
    mp4.write("ftyp", 4);
    mp4.write("isom", 8);
    for (const [type, mediaType, bytes] of [
      ["image", "image/png", png],
      ["audio", "audio/wav", wav],
      ["video", "video/mp4", mp4],
      ["file", "application/pdf", Buffer.from("%PDF-1.7\nfixture")],
    ] as const) {
      const part = await saveGeneratedMedia(session.projectId, {
        mediaType,
        uint8Array: bytes,
      });
      expect(part.type).toBe(type);
      agentRuntimeStore.appendMessage({
        id: `message-${type}`,
        sessionId: session.id,
        runId: null,
        stepId: null,
        role: "assistant",
        content: "",
        contentParts: [part],
        metadata: {},
        createdAt: new Date().toISOString(),
      });
      if (part.type === "text") throw new Error("Expected binary");
      expect(await readAsset(part.assetId, session.projectId)).toEqual(bytes);
      expect(sessionHasAsset(session.id, part.assetId)).toBe(true);
    }
    expect(
      agentRuntimeStore
        .listMessages(session.id)
        .filter((message) => message.contentParts)
        .map((message) => message.contentParts![0].type),
    ).toEqual(["image", "audio", "video", "file"]);
  });
});
