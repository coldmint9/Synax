import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getRawSqlite } from "../../db/index.js";
import { DATA_ROOT } from "../../lib/env.js";
import { AgentRuntimeError } from "./runtime-errors.js";
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
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!text.includes("\0"))
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
      ? hint === "audio/mp3"
        ? "audio/mpeg"
        : hint === "audio/x-wav"
          ? "audio/wav"
          : hint
      : extensions[ext];
  if (
    claimed &&
    detected &&
    claimed !== detected &&
    !(
      ["text/plain", "text/csv", "application/json"].includes(claimed) &&
      detected === "text/plain"
    )
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
function map(row: any): RuntimeAsset {
  return {
    id: row.id,
    projectId: row.project_id,
    filename: row.filename,
    mediaType: row.media_type,
    size: row.size,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}
export function getAsset(id: string, projectId?: string): RuntimeAsset {
  if (!/^asset_[a-f0-9]{32}$/.test(id)) error("Invalid asset ID.");
  const row = getRawSqlite()
    .prepare("SELECT * FROM agent_runtime_assets WHERE id=?")
    .get(id);
  if (!row) error("Media resource no longer exists.", "MEDIA_NOT_FOUND", 404);
  const asset = map(row);
  if (projectId && asset.projectId !== projectId)
    error(
      "Media belongs to a different project.",
      "MEDIA_PROJECT_MISMATCH",
      403,
    );
  return asset;
}
export function assetPath(id: string): string {
  getAsset(id);
  return path.join(root(), id);
}
export async function readAsset(
  id: string,
  projectId?: string,
): Promise<Buffer> {
  const asset = getAsset(id, projectId);
  const file = await fsp
    .open(
      path.join(root(), id),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    )
    .catch(() => error("Media file is missing.", "MEDIA_NOT_FOUND", 404));
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size !== asset.size ||
      stat.size > MAX_FILE_BYTES
    )
      error("Media file was changed.", "MEDIA_CHANGED", 409);
    const bytes = await file.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      error("Media file was changed.", "MEDIA_CHANGED", 409);
    return bytes;
  } finally {
    await file.close();
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
  const existing = getRawSqlite()
    .prepare(
      "SELECT * FROM agent_runtime_assets WHERE project_id=? AND sha256=? AND filename=? AND media_type=? AND EXISTS (SELECT 1 FROM agent_runtime_asset_sessions WHERE asset_id=agent_runtime_assets.id) LIMIT 1",
    )
    .get(projectId, sha256, path.basename(filename), mediaType);
  if (existing) {
    const asset = map(existing);
    try {
      await readAsset(asset.id, projectId);
      return asset;
    } catch (error) {
      if (!(error instanceof AgentRuntimeError)) throw error;
    }
  }
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
  await fsp.mkdir(root(), { recursive: true, mode: 0o700 });
  await fsp.writeFile(path.join(root(), asset.id), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    getRawSqlite()
      .prepare(
        "INSERT INTO agent_runtime_assets (id,project_id,filename,media_type,size,sha256,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        asset.id,
        asset.projectId,
        asset.filename,
        asset.mediaType,
        asset.size,
        asset.sha256,
        asset.createdAt,
      );
  } catch (e) {
    await fsp.unlink(path.join(root(), asset.id));
    throw e;
  }
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
export function bindAssets(
  sessionId: string,
  parts: RuntimeContentPart[],
): void {
  const db = getRawSqlite();
  const session = db
    .prepare("SELECT project_id FROM agent_runtime_sessions WHERE id=?")
    .get(sessionId) as { project_id: string } | undefined;
  if (!session) error("Session not found.", "NOT_FOUND", 404);
  const assets = validateAssets(parts, session!.project_id);
  for (const a of assets)
    db.prepare(
      "INSERT OR IGNORE INTO agent_runtime_asset_sessions (asset_id,session_id) VALUES (?,?)",
    ).run(a.id, sessionId);
}
export function sessionHasAsset(sessionId: string, id: string): boolean {
  return !!getRawSqlite()
    .prepare(
      "SELECT 1 FROM agent_runtime_asset_sessions WHERE asset_id=? AND session_id=?",
    )
    .get(id, sessionId);
}
export async function deleteUnboundAsset(id: string): Promise<void> {
  const db = getRawSqlite();
  getAsset(id);
  db.transaction(() => {
    if (
      db
        .prepare("SELECT 1 FROM agent_runtime_asset_sessions WHERE asset_id=?")
        .get(id)
    )
      error("Media is retained by a session.", "MEDIA_IN_USE", 409);
    db.prepare("DELETE FROM agent_runtime_assets WHERE id=?").run(id);
  })();
  await fsp.unlink(path.join(root(), id)).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
}
export async function sweepAssets(): Promise<void> {
  const rows = getRawSqlite()
    .prepare(
      "SELECT id FROM agent_runtime_assets WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM agent_runtime_asset_sessions WHERE asset_id=agent_runtime_assets.id)",
    )
    .all(new Date(Date.now() - 86_400_000).toISOString()) as { id: string }[];
  for (const row of rows) await deleteUnboundAsset(row.id).catch(() => {});
}
export function modelContentParts(parts: RuntimeContentPart[]): any[] {
  return parts.map((p) =>
    p.type === "text"
      ? p
      : {
          type: "file",
          data: new URL(`synax-asset:${p.assetId}`),
          mediaType: getAsset(p.assetId).mediaType,
          filename: getAsset(p.assetId).filename,
        },
  );
}
