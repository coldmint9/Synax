import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import type { RegisteredTool } from "../contracts.js";
import { bindAssets, createAsset, getAsset, sessionHasAsset } from "../media-assets.js";
import { MAX_FILE_BYTES, modalityForMime } from "../content-parts.js";
import { agentRuntimeStore } from "../session-store.js";
import { resolveWorkspacePath } from "./workspace.js";
import { resolveFileParts } from "../file-input/index.js";
export const mediaReadTool: RegisteredTool = {
  id: "media.read",
  label: "Read media",
  description:
    "Read an attached asset by assetId or a workspace file by path. Provide exactly one assetId or path. Files must be at most 50 MiB. Character files and PDF text layers, DOCX, XLSX and PPTX are parsed locally into text, independently of model file capabilities. Images and videos use native media input. Unsupported binary files are rejected; skills/tools may convert them to text or extend the parser registry. Scanned PDFs require an OCR tool.",
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
    }
    const parts = [{ type: modalityForMime(asset.mediaType), assetId: asset.id }];
    if (args.assetOnly) bindAssets(input.sessionId, parts);
    return {
      result: { asset },
      contentParts: args.assetOnly ? [] : await resolveFileParts(parts, session.projectId),
      displaySummary: `Read ${asset.filename} (${asset.mediaType}, ${asset.size} bytes)`,
      artifacts: [],
    };
  },
};
