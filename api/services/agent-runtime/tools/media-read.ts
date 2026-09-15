import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import type { RegisteredTool } from "../contracts.js";
import { createAsset, getAsset, sessionHasAsset } from "../media-assets.js";
import { MAX_FILE_BYTES, modalityForMime } from "../content-parts.js";
import { agentRuntimeStore } from "../session-store.js";
import { resolveWorkspacePath } from "./workspace.js";
export const mediaReadTool: RegisteredTool = {
  id: "media.read",
  label: "Read media",
  description:
    "Read an attached asset by assetId or a workspace image, audio, video or document by path. Returns original media to a compatible model; no OCR or conversion.",
  category: "read",
  mutability: "read",
  resumeBehavior: "auto",
  internalGate: "none",
  inputSchema: z
    .object({ assetId: z.string().optional(), path: z.string().optional() })
    .refine(
      (a) => Boolean(a.assetId) !== Boolean(a.path),
      "Provide exactly one assetId or path.",
    ),
  getPattern(args) {
    return (args as { path?: string })?.path;
  },
  async execute(input) {
    const args = input.args as { assetId?: string; path?: string };
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
    return {
      result: { asset },
      contentParts: [
        { type: modalityForMime(asset.mediaType), assetId: asset.id },
      ],
      displaySummary: `Read ${asset.filename} (${asset.mediaType}, ${asset.size} bytes)`,
      artifacts: [],
    };
  },
};
