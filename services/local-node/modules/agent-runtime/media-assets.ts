import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { runtimeFacade } from "./sidecar/runtime-facade.js";
import { agentRuntimeStore } from "./session-store.js";
import { DATA_ROOT } from "../../infrastructure/runtime/env.js";
import { AgentRuntimeError } from "./runtime-errors.js";
import { decodeCharacterFile } from "./file-input/registry.js";
import {
  MAX_FILE_BYTES,
  MAX_INPUT_BYTES,
  modalityForMime,
  type RuntimeAsset,
  type RuntimeContentPart,
} from "./content-parts.js";

const root = () => path.resolve(DATA_ROOT, "runtime-media");
const error = (
  message: string,
  code = "INVALID_MEDIA",
  status = 400,
): never => {
  throw new AgentRuntimeError(message, code, status);
};
const extensions: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  txt: "text/plain",
  md: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  svg: "image/svg+xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};
export function detectMediaType(
  bytes: Buffer,
  filename: string,
  declared = "",
): string {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const hint = declared.toLowerCase().split(";")[0].trim();
  let detected: string | undefined;
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    detected = "image/png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    detected = "image/jpeg";
  else if (/^GIF8[79]a/.test(bytes.toString("ascii", 0, 6)))
    detected = "image/gif";
  else if (bytes.toString("ascii", 0, 4) === "RIFF")
    detected =
      bytes.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : bytes.toString("ascii", 8, 12) === "WAVE"
          ? "audio/wav"
          : undefined;
  else if (bytes.subarray(0, 5).toString() === "%PDF-")
    detected = "application/pdf";
  else if (bytes[0] === 255 && (bytes[1] & 0xf6) === 0xf0)
    detected = "audio/aac";
  else if (
    bytes.toString("ascii", 0, 3) === "ID3" ||
    (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0)
  )
    detected = "audio/mpeg";
  else if (bytes.toString("ascii", 0, 4) === "fLaC") detected = "audio/flac";
  else if (bytes.toString("ascii", 0, 4) === "OggS") detected = "audio/ogg";
  else if (bytes.toString("ascii", 4, 8) === "ftyp") {
    const brand = bytes.toString("ascii", 8, 12);
    detected = /avif|avis/.test(brand)
      ? "image/avif"
      : brand.startsWith("M4A")
        ? "audio/mp4"
        : brand === "qt  "
          ? "video/quicktime"
          : "video/mp4";
  } else if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    detected = bytes.subarray(0, 256).includes(Buffer.from("webm"))
      ? "video/webm"
      : "video/x-matroska";
  else if (bytes.toString("ascii", 0, 2) === "BM") detected = "image/bmp";
  else if (bytes.toString("ascii", 0, 2) === "PK")
    detected =
      ["docx", "xlsx", "pptx"].includes(ext) &&
      bytes.includes(Buffer.from("[Content_Types].xml"))
        ? extensions[ext]
        : "application/zip";
  else {
    try {
      const text = decodeCharacterFile(bytes);
      if (text !== undefined)
        detected = /<svg[\s>]/i.test(text.slice(0, 1024))
          ? "image/svg+xml"
          : /<!doctype html|<html[\s>]/i.test(text.slice(0, 1024))
            ? "text/html"
            : extensions[ext]?.startsWith("text/") || ext === "json"
              ? extensions[ext]
              : "text/plain";
    } catch {
      /* unknown binary */
    }
  }
  const claimed =
    hint && hint !== "application/octet-stream"
      ? hint === "audio/opus"
        ? "audio/ogg"
        : hint === "audio/mp3"
          ? "audio/mpeg"
          : hint === "audio/x-wav"
            ? "audio/wav"
            : hint
      : extensions[ext];
  if (
    claimed &&
    detected &&
    claimed !== detected &&
    // Character content is text regardless of browser MIME hints or extension.
    !detected.startsWith("text/") && detected !== "application/json" && detected !== "image/svg+xml"
  )
    error(`File contents do not match ${claimed} (${filename}).`);
  if (
    !detected &&
    claimed &&
    /^(image|audio|video)\/|application\/pdf/.test(claimed)
  )
    error(`Unrecognized or invalid media file: ${filename}.`);
  return detected ?? "application/octet-stream";
}
const assets = new Map<string, RuntimeAsset>();
const bindings = new Map<string, Set<string>>();
/** Metadata cache only. Asset bytes and binding authority are owned by Rust. */
export async function hydrateRuntimeAssets(sessionIds: string[] = []): Promise<void> {
  let after: string | undefined;
  do {
    const page=await runtimeFacade.historyCommandGlobal({scopeId:'assets',requestId:randomUUID(),operation:'asset_page',payload:{after}}) as {items:RuntimeAsset[];next?:string};
    for(const asset of page.items) assets.set(asset.id,asset);
    after=page.next;
  } while(after);
  for(const sessionId of sessionIds) {
    const bound=await runtimeFacade.listBoundAssets(sessionId) as RuntimeAsset[];
    bindings.set(sessionId,new Set(bound.map(a=>a.id)));
    for(const asset of bound) assets.set(asset.id,asset);
  }
}
/** Fetch exact metadata from the Rust asset store and refresh the local cache. */
export async function loadAsset(
  id: string,
  projectId?: string,
): Promise<RuntimeAsset> {
  if (!/^asset_[a-f0-9]{32}$/.test(id)) return error("Invalid asset ID.");
  const asset = (await runtimeFacade.getAssetMetadata(id)) as RuntimeAsset;
  assets.set(id, asset);
  return getAsset(id, projectId);
}

/** Ensure every referenced asset is available in the metadata cache. */
export async function prepareAssets(
  parts: RuntimeContentPart[],
  projectId?: string,
): Promise<void> {
  for (const part of parts) {
    if (part.type !== "text") await loadAsset(part.assetId, projectId);
  }
}

/** Materialize a Rust-owned blob for providers that require a local path. */
export async function materializeAsset(id: string): Promise<string> {
  const bytes = await readAsset(id);
  await fsp.mkdir(root(), { recursive: true, mode: 0o700 });
  const destination = assetPath(id);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await fsp.rename(temporary, destination);
  return destination;
}

export function getAsset(id:string,projectId?:string):RuntimeAsset {
  if(!/^asset_[a-f0-9]{32}$/.test(id)) error('Invalid asset ID.');
  const asset=assets.get(id);
  if(!asset) return error('Media resource no longer exists.','MEDIA_NOT_FOUND',404);
  if(projectId && asset.projectId!==projectId) error('Media belongs to a different project.','MEDIA_PROJECT_MISMATCH',403);
  return {...asset};
}
export function assetPath(id: string): string {
  getAsset(id);
  return path.join(root(), id);
}
export async function readAsset(id:string,projectId?:string):Promise<Buffer> {
  const asset=getAsset(id,projectId);
  try {
    return Buffer.from(await runtimeFacade.readAssetBlob(asset.id));
  } catch {
    return fsp.readFile(assetPath(asset.id));
  }
}

export async function createAsset(
  projectId: string,
  filename: string,
  bytes: Buffer,
  declared?: string,
): Promise<RuntimeAsset> {
  if (!projectId || projectId.length > 128) error("A project ID is required.");
  if (!bytes.length || bytes.length > MAX_FILE_BYTES)
    error("File must be nonempty and at most 50 MiB.", "MEDIA_TOO_LARGE", 413);
  const mediaType = detectMediaType(bytes, filename, declared);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const asset: RuntimeAsset = {
    id: `asset_${randomUUID().replaceAll("-", "")}`,
    projectId,
    filename:
      path
        .basename(filename.replaceAll("\\", "/"))
        .replace(/[\x00-\x1f]/g, "")
        .slice(0, 255) || "attachment",
    mediaType,
    size: bytes.length,
    sha256,
    createdAt: new Date().toISOString(),
  };
  try {
    await runtimeFacade.putAssetBlob(asset.id,asset,bytes);
  } catch {
    // The Rust journal is authoritative in a running host; local asset bytes
    // remain a safe bootstrap/test fallback before the sidecar is connected.
  }
  await fsp.mkdir(root(),{recursive:true,mode:0o700});
  await fsp.writeFile(path.join(root(),asset.id),bytes,{flag:'wx',mode:0o600});
  assets.set(asset.id,asset);
  return asset;
}
export function validateAssets(
  parts: RuntimeContentPart[],
  projectId: string,
): RuntimeAsset[] {
  const assets = parts.flatMap((p) =>
    p.type === "text" ? [] : [getAsset(p.assetId, projectId)],
  );
  if (
    assets.length > 10 ||
    assets.reduce((sum, a) => sum + a.size, 0) > MAX_INPUT_BYTES
  )
    error("Input exceeds 10 files or 100 MiB.", "MEDIA_TOO_LARGE", 413);
  for (const part of parts)
    if (
      part.type !== "text" &&
      modalityForMime(getAsset(part.assetId, projectId).mediaType) !== part.type
    )
      error("Content part does not match the media type.");
  for (const asset of assets) {
    try {
      const stat = fs.lstatSync(path.join(root(), asset.id));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.size)
        error("Media file was changed.", "MEDIA_CHANGED", 409);
    } catch (e) {
      if (e instanceof AgentRuntimeError) throw e;
      error("Media file is missing.", "MEDIA_NOT_FOUND", 404);
    }
  }
  return assets;
}
export async function bindValidatedAssets(sessionId:string,values:RuntimeAsset[]):Promise<void> {
  for(const asset of values) await runtimeFacade.bindAsset(sessionId,asset.id);
  const ids=bindings.get(sessionId) ?? new Set<string>();
  for(const asset of values) ids.add(asset.id);
  bindings.set(sessionId,ids);
}
export const bindValidatedAssetsAuthoritative=bindValidatedAssets;
export async function bindAssets(sessionId:string,parts:RuntimeContentPart[]):Promise<void> {
  const session=agentRuntimeStore.getSession(sessionId);
  await bindValidatedAssets(sessionId,validateAssets(parts,session.projectId));
}
export function sessionHasAsset(sessionId:string,id:string):boolean {return bindings.get(sessionId)?.has(id) ?? false;}

/** Load only the bindings needed by a session executing in this process. */
export async function hydrateSessionAssets(sessionId: string): Promise<void> {
  const bound = (await runtimeFacade.listBoundAssets(sessionId)) as RuntimeAsset[];
  bindings.set(sessionId, new Set(bound.map((asset) => asset.id)));
  for (const asset of bound) assets.set(asset.id, asset);
}

export async function deleteUnboundAsset(id:string):Promise<void> {
  await runtimeFacade.deleteAssetMetadata(id);
  await runtimeFacade.deleteAssetBlob(id);
  assets.delete(id);
  await fsp.unlink(path.join(root(),id)).catch(e=>{if(e.code!=='ENOENT')throw e;});
}
export async function sweepAssets(): Promise<void> {
  const { runtimeFacade } = await import('./sidecar/runtime-facade.js');
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  let after: string | undefined;
  do {
    const page = await runtimeFacade.historyCommandGlobal({scopeId:'__assets__',requestId:`asset-page:${after??'start'}`,operation:'asset_page',payload:{after}}) as {items:Array<{id:string;createdAt:string}>;next?:string};
    for(const asset of page.items) {
      if(asset.createdAt>=cutoff)continue;
      try { await runtimeFacade.deleteAssetMetadata(asset.id); }
      catch(error) {
        if(error instanceof Error && error.message.includes('asset is retained by a session'))continue;
        throw error;
      }
      await runtimeFacade.deleteAssetBlob(asset.id);
      assets.delete(asset.id);
      await fsp.unlink(path.join(root(),asset.id)).catch(error=>{if(error.code!=='ENOENT')throw error});
    }
    after=page.next;
  } while(after);
}
export function modelContentParts(parts: RuntimeContentPart[]): any[] {
  return parts.flatMap((p) => {
    if (p.type === "text") return [p];
    const asset = getAsset(p.assetId);
    return [
      {
        type: "text",
        text: `Attached media: ${JSON.stringify({ assetId: asset.id, filename: asset.filename })}. Use this assetId with media.read or media.generate.`,
      },
      {
        type: "file",
        data: new URL(`synax-asset:${p.assetId}`),
        mediaType: asset.mediaType,
        filename: asset.filename,
        ...(p.providerOptions ? { providerOptions: p.providerOptions } : {}),
        ...(p.type === "image" && p.detail
          ? {
              providerOptions: {
                ...p.providerOptions,
                openai: { ...p.providerOptions?.openai, imageDetail: p.detail },
              },
            }
          : {}),
      },
    ];
  });
}
