import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const UI_ARCHIVE_LIMIT = 80 * 1024 * 1024;
const UI_JSON_LIMIT = 220 * 1024 * 1024;
const UI_FILES_LIMIT = 2_000;
const UI_CONTENT_LIMIT = 150 * 1024 * 1024;
const hex = /^[0-9a-f]{64}$/;
const version = /^\d+\.\d+\.\d+$/;

export interface UiFile {
  path: string;
  sha256: string;
  size: number;
}
export interface UiArtifact {
  name: string;
  sha256: string;
  size: number;
}
export interface UiManifest {
  format: 1;
  version: string;
  appVersion: string;
  files: UiFile[];
  full: UiArtifact;
  delta?: UiArtifact & { baseVersion: string; paths: string[] };
}

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function validUiPath(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length < 512 &&
    !value.startsWith("/") &&
    !/[\\:\0]/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      ) &&
    !/^[a-zA-Z]:/.test(value)
  );
}

function validArtifact(value: unknown, name: string): value is UiArtifact {
  const item = value as UiArtifact;
  return (
    !!item &&
    item.name === name &&
    hex.test(item.sha256) &&
    Number.isSafeInteger(item.size) &&
    item.size > 0 &&
    item.size <= UI_ARCHIVE_LIMIT
  );
}

export function validateManifest(value: unknown): UiManifest {
  const data = value as UiManifest;
  if (
    !data ||
    data.format !== 1 ||
    !version.test(data.version) ||
    !version.test(data.appVersion) ||
    !Array.isArray(data.files) ||
    !data.files.length ||
    data.files.length > UI_FILES_LIMIT ||
    !validArtifact(data.full, "ui-full.json.gz")
  ) {
    throw new Error("Invalid UI update manifest");
  }
  const paths = new Set<string>();
  let total = 0;
  for (const entry of data.files) {
    if (
      !entry ||
      !validUiPath(entry.path) ||
      entry.path === "manifest.json" ||
      !hex.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > UI_CONTENT_LIMIT ||
      paths.has(entry.path)
    ) {
      throw new Error("Invalid UI update file list");
    }
    paths.add(entry.path);
    total += entry.size;
  }
  if (!paths.has("index.html") || total > UI_CONTENT_LIMIT) {
    throw new Error("UI update is missing its index or exceeds the size limit");
  }
  if (data.delta !== undefined) {
    const delta = data.delta;
    if (
      !validArtifact(delta, "ui-delta.json.gz") ||
      !version.test(delta.baseVersion) ||
      !Array.isArray(delta.paths) ||
      delta.paths.length > UI_FILES_LIMIT ||
      new Set(delta.paths).size !== delta.paths.length ||
      delta.paths.some((file) => !paths.has(file))
    ) {
      throw new Error("Invalid UI delta metadata");
    }
  }
  return data;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

// A deliberately simple, dependency-free archive. JSON keeps paths as data, not
// archive extraction instructions; the outer gzip makes repeated assets compact.
export function encodeUiArchive(files: Map<string, Buffer>): Buffer {
  const entries = [...files]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, contents]) => [file, contents.toString("base64")]);
  return gzipSync(Buffer.from(JSON.stringify({ format: 1, files: entries })));
}

export function decodeUiArchive(
  archive: Buffer,
  expected: UiFile[],
): Map<string, Buffer> {
  if (archive.length > UI_ARCHIVE_LIMIT)
    throw new Error("UI archive exceeds size limit");
  const value = JSON.parse(
    gunzipSync(archive, { maxOutputLength: UI_JSON_LIMIT }).toString("utf8"),
  );
  if (
    value?.format !== 1 ||
    !Array.isArray(value.files) ||
    value.files.length !== expected.length
  ) {
    throw new Error("Invalid UI archive");
  }
  const listed = new Map(expected.map((entry) => [entry.path, entry]));
  const decoded = new Map<string, Buffer>();
  for (const item of value.files) {
    if (
      !Array.isArray(item) ||
      item.length !== 2 ||
      !validUiPath(item[0]) ||
      typeof item[1] !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        item[1],
      )
    ) {
      throw new Error("Invalid UI archive entry");
    }
    const entry = listed.get(item[0]);
    if (!entry || decoded.has(item[0]))
      throw new Error("Unexpected UI archive entry");
    const contents = Buffer.from(item[1], "base64");
    if (contents.length !== entry.size || sha256(contents) !== entry.sha256) {
      throw new Error(`UI file checksum mismatch: ${item[0]}`);
    }
    decoded.set(item[0], contents);
  }
  return decoded;
}
