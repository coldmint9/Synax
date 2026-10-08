import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { runtimeAssetRoutes } from "../../../transport/http/runtime-assets.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import {
  createAsset,
  modelContentParts,
  bindAssets,
  sessionHasAsset,
} from "../media-assets.js";
import {
  nativeInputCapabilities,
  resolveMediaMessages,
} from "../media-capabilities.js";
import {
  codexMediaInput,
  claudeMediaInput,
  acpMediaInput,
} from "../media-backend-input.js";
import { importToolContent } from "../media-tool-content.js";
import { mediaReadTool } from "../tools/media-read.js";
import { documentFixtures, officeTypes } from "./file-input-fixtures.js";
import {
  executorInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";
import type { ResolvedModelSelection } from "../../../infrastructure/llm-runtime/types.js";
const selection: ResolvedModelSelection = {
  model: "fixture/text",
  modelId: "text",
  providerId: "fixture",
  apiFormat: "openai",
  provider: {
    id: "fixture",
    label: "Fixture",
    npm: "@ai-sdk/deepseek",
    env: [],
    models: [],
    supported: true,
  },
  config: {
    providerId: "fixture",
    apiKey: "fixture",
    baseUrl: "http://localhost:9876/v1",
  },
  modelDef: { id: "text", label: "Text", inputModalities: ["text"] },
};
const fixtures = documentFixtures();
beforeEach(resetAgentRuntimeFixtures);
describe("document inputs independent of provider capabilities", () => {
  it.each([
    "text/javascript",
    "application/javascript",
    "application/xml",
    "text/yaml",
    "application/octet-stream",
    "video/mp2t",
  ])(
    "uploads character content as text despite the %s MIME hint",
    async (mime) => {
      const session = agentSessionRuntime.create(executorInput);
      const form = new FormData();
      form.set("projectId", session.projectId);
      form.set(
        "file",
        new File(["const answer = 42;"], "notes.ts", { type: mime }),
      );
      const app = new Hono().route("/assets", runtimeAssetRoutes);
      const response = await app.request("/assets", {
        method: "POST",
        body: form,
      });
      expect(response.status).toBe(201);
      const { asset } = await response.json();
      expect(asset.mediaType).toBe("text/plain");
      const messages = await resolveMediaMessages(
        [
          {
            role: "user",
            content: modelContentParts(
              [{ type: "file", assetId: asset.id }],
            ),
          },
        ],
        selection,
        session.projectId,
      );
      expect(
        (messages[0].content as any[]).every((part) => part.type === "text"),
      ).toBe(true);
    },
  );
  it("retains generated binary media as metadata without passing bytes to a text model", async () => {
    const session = agentSessionRuntime.create(executorInput);
    const bytes = Buffer.alloc(44);
    bytes.write("RIFF");
    bytes.write("WAVE", 8);
    const asset = await createAsset(
      session.projectId,
      "generated.wav",
      bytes,
      "audio/wav",
    );
    const messages = await resolveMediaMessages(
      [
        {
          role: "assistant",
          content: [
            {
              type: "file",
              data: `synax-asset:${asset.id}`,
              mediaType: asset.mediaType,
            },
          ],
        },
      ],
      selection,
      session.projectId,
    );
    const content = messages.flatMap<{ type: string; text?: string }>(
      (message) => (typeof message.content === "string" ? [] : message.content),
    );
    expect(content.every((part) => part.type === "text")).toBe(true);
    expect(
      content.some(
        (part) =>
          part.type === "text" && part.text?.includes("Binary asset retained"),
      ),
    ).toBe(true);
  });
  it("imports an opaque binary only for an explicit tool extension, without model content", async () => {
    const session = agentSessionRuntime.create(executorInput);
    const root = fs.mkdtempSync(
      path.join(process.cwd(), "file-parser-extension-"),
    );
    const file = path.join(root, "opaque.bin");
    fs.writeFileSync(file, Buffer.from([0, 255, 1, 2]));
    const base = {
      sessionId: session.id,
      toolCallId: "extension",
      context: {},
      store: agentRuntimeStore,
    };
    try {
      await expect(
        mediaReadTool.execute({ ...base, args: { path: file } } as any),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
      const imported = await mediaReadTool.execute({
        ...base,
        args: { path: file, assetOnly: true },
      } as any);
      expect(imported.contentParts).toEqual([]);
      expect(
        sessionHasAsset(session.id, (imported.result as any).asset.id),
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(["pdf", "docx", "xlsx", "pptx"] as const)(
    "uploads and sends .%s as text to a text-only model",
    async (kind) => {
      const session = agentSessionRuntime.create(executorInput);
      const app = new Hono().route("/assets", runtimeAssetRoutes);
      const form = new FormData();
      form.set("projectId", session.projectId);
      form.set(
        "file",
        new File([new Uint8Array(fixtures[kind])], `sample.${kind}`, {
          type: kind === "pdf" ? "application/pdf" : officeTypes[kind],
        }),
      );
      const response = await app.request("/assets", {
        method: "POST",
        body: form,
      });
      expect(response.status).toBe(201);
      const { asset } = await response.json();
      const parts = [{ type: "file" as const, assetId: asset.id }];
      const messages = await resolveMediaMessages(
        [{ role: "user", content: modelContentParts(parts) }],
        selection,
        session.projectId,
      );
      expect(nativeInputCapabilities(selection).modalities).toEqual(["text"]);
      expect(JSON.stringify(messages)).toContain(`sample.${kind}`);
      expect(JSON.stringify(messages)).not.toContain('"type":"file"');
      expect(JSON.stringify(messages)).not.toContain("base64");
      const codex = await codexMediaInput({ contentParts: parts }, "");
      expect(codex[0]).toMatchObject({ type: "text" });
      const claude = await claudeMediaInput({ contentParts: parts }, "");
      expect(claude[0]).toMatchObject({ type: "text" });
      const acp = await acpMediaInput(parts, "");
      expect(acp[0]).toMatchObject({ type: "text" });
      bindAssets(session.id, parts);
      const read = await mediaReadTool.execute({
        sessionId: session.id,
        toolCallId: "read",
        args: { assetId: asset.id },
      } as any);
      expect(read.contentParts?.[0]).toMatchObject({ type: "text" });
      expect(JSON.stringify(read.contentParts)).toContain(`sample.${kind}`);
    },
  );
  it("normalizes tool-returned documents, and refuses unknown binary uploads", async () => {
    const session = agentSessionRuntime.create(executorInput);
    const imported = await importToolContent(session.projectId, [
      {
        type: "file",
        name: "report.docx",
        mimeType: officeTypes.docx,
        data: fixtures.docx.toString("base64"),
      },
    ]);
    expect(imported[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(imported)).toContain("文档段落");
    const app = new Hono().route("/assets", runtimeAssetRoutes);
    const form = new FormData();
    form.set("projectId", session.projectId);
    form.set("file", new File([new Uint8Array([0, 255, 1, 2])], "unknown.bin"));
    const response = await app.request("/assets", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "UNSUPPORTED_FILE" });
  });
  it("turns character files in historical messages into text with no declared media capabilities", async () => {
    const session = agentSessionRuntime.create(executorInput);
    const asset = await createAsset(
      session.projectId,
      "notes.ts",
      Buffer.from("const answer = 42;"),
    );
    const messages = await resolveMediaMessages(
      [
        {
          role: "user",
          content: modelContentParts([{ type: "file", assetId: asset.id }]),
        },
      ],
      { ...selection, modelDef: { id: "text", label: "Text" } },
      session.projectId,
    );
    expect(messages[0].content).toContainEqual({
      type: "text",
      text: "文件：notes.ts\nconst answer = 42;",
    });
    expect(
      (messages[0].content as any[]).every((part) => part.type === "text"),
    ).toBe(true);
  });
});
