import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import type { RegisteredTool } from "../contracts.js";
import { bindAssets, createAsset, getAsset, sessionHasAsset } from "../media-assets.js";
import { MAX_FILE_BYTES, modalityForMime } from "../content-parts.js";
import { agentRuntimeStore } from "../session-store.js";
import { resolveWorkspacePath } from "./workspace.js";
import { resolveFileParts } from "../file-input/index.js";
import { sessionInputCapabilities } from "../media-capabilities.js";
import { isVisualDocument } from "../file-input/registry.js";
import { fetchRemoteImage } from "../file-input/remote-image.js";
export const mediaReadTool: RegisteredTool = {
  id: "media.read",
  label: "Read media",
  description:
    "Read an attached asset by assetId or a workspace file by path. Provide exactly one assetId or path. Files must be at most 50 MiB. PDF, Markdown, DOCX, XLSX and PPTX provide text and visual context to models with confirmed image input. Markdown local images are resolved relative to the document; public HTTP(S) images are downloaded with bounded, SSRF-safe validation. Office embedded images are extracted locally; complete Office layout, charts and vector diagrams require LibreOffice (optionally configured via SYNAX_LIBREOFFICE_PATH). Text-only models receive text and explicit warnings about unread visual content. Images and videos use native media input. Unsupported binary files are rejected; skills/tools may extend the parser registry.",
  category: "read",
  mutability: "read",
  resumeBehavior: "auto",
  internalGate: "none",
  inputSchema: z
    .object({
      assetId: z.string().optional().describe("Asset ID attached to this session. Omit when using path."),
      path: z.string().optional().describe("File relative to the session working directory, or an absolute path permitted by the sandbox. Omit when using assetId. Use this to attach a file before passing its returned asset ID to generation tools."),
      assetOnly: z.boolean().optional().describe("Explicit tool-extension import: retain the original file as an opaque session asset for a parsing, OCR or transcription tool. Return metadata only; never expose binary bytes to the model. Default false parses documents and rejects unsupported binary files."),
    })
    .refine(
      (a) => Boolean(a.assetId) !== Boolean(a.path),
      "Provide exactly one assetId or path.",
    ),
  getPattern(args) {
    return (args as { path?: string })?.path;
  },
  async execute(input) {
    const args = input.args as { assetId?: string; path?: string; assetOnly?: boolean };
    const session = agentRuntimeStore.getSession(input.sessionId);
    let asset;
    let imageLoader: Parameters<typeof resolveFileParts>[3];
    if (args.assetId) {
      if (!sessionHasAsset(input.sessionId, args.assetId))
        throw new Error("Asset is not attached to this session.");
      asset = getAsset(args.assetId, session.projectId);
    } else {
      const file = resolveWorkspacePath(args.path!, input.sessionId);
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
        throw new Error("Media must be a file of at most 50 MiB.");
      asset = await createAsset(
        session.projectId,
        path.basename(file),
        await fsp.readFile(file),
      );
      imageLoader = async (source) => {
        if (/^https?:\/\//i.test(source))
          return (await fetchRemoteImage(source, 10 * 1024 * 1024)).bytes;
        const imagePath = path.resolve(path.dirname(file), source);
        const safeImagePath = resolveWorkspacePath(imagePath, input.sessionId);
        const bytes = await fsp.readFile(safeImagePath);
        if (bytes.byteLength > 10 * 1024 * 1024)
          throw new Error("Markdown 图片超过 10 MiB。");
        return bytes;
      };
    }
    const parts = [{ type: modalityForMime(asset.mediaType), assetId: asset.id }];
    if (args.assetOnly) bindAssets(input.sessionId, parts);
    const contentParts = args.assetOnly ? [] : await resolveFileParts(parts, session.projectId,
      isVisualDocument(asset.mediaType) ? await sessionInputCapabilities(input.sessionId,
      input.runId ? agentRuntimeStore.getRun(input.runId).model ?? undefined : undefined) : undefined,
      imageLoader);
    // Retain the source separately: ten rendered pages plus the source would
    // otherwise exceed the per-input ten-file validation limit.
    // The part must carry the modality derived from the MIME type: images and
    // videos are native visuals, so "file" is only correct for documents.
    bindAssets(input.sessionId, parts);
    bindAssets(input.sessionId, contentParts);
    const warnings = contentParts.filter(p => p.type === "text" && /无法识别|无法完整识别|未提供给模型识别/.test(p.text));
    return {
      result: { asset },
      contentParts,
      displaySummary: `Read ${asset.filename} (${asset.mediaType}, ${asset.size} bytes)${warnings.length ? "；图片或流程图未被识别，详见解析提示。" : ""}`,
      artifacts: [],
    };
  },
};
