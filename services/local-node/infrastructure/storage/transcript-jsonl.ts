import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HASH = /^[0-9a-f]{64}$/;
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PAYLOAD = 64 * 1024;
const MAX_LINE = 128 * 1024;
const MAX_BATCH = 1024 * 1024;

export interface TranscriptRecord {
  hash: string;
  kind: string;
  payload: Buffer;
  references: string[];
}
export interface TranscriptLocation {
  offset: number;
  length: number;
  payloadBytes: number;
}
function fail(message: string): never {
  throw new Error(`TRANSCRIPT_${message}`);
}
function validateRecord(record: TranscriptRecord): void {
  if (typeof record.hash !== "string" || !HASH.test(record.hash)) fail("HASH");
  if (typeof record.kind !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(record.kind)) fail("KIND");
  if (!Buffer.isBuffer(record.payload) || record.payload.length > MAX_PAYLOAD) fail("PAYLOAD_SIZE");
  if (!Array.isArray(record.references) || record.references.length > 256 ||
      record.references.some((ref, i, refs) => typeof ref !== "string" || !HASH.test(ref) || (i > 0 && refs[i - 1] >= ref))) {
    fail("REFERENCES");
  }
}
function validateSegment(segment: string): void {
  if (typeof segment !== "string" || !SEGMENT.test(segment)) fail("SEGMENT");
}
function recordBytes(record: TranscriptRecord): Buffer {
  validateRecord(record);
  const body = {
    version: 1,
    hash: record.hash,
    kind: record.kind,
    references: record.references,
    payload: record.payload.toString("base64"),
  };
  const checksum = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const line = Buffer.from(JSON.stringify({ ...body, checksum }) + "\n");
  if (line.length > MAX_LINE) fail("LINE_SIZE");
  return line;
}
function directoryPath(root: string): string {
  if (!path.isAbsolute(root)) fail("ROOT");
  return path.join(root, "transcripts");
}
function checkDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("DIRECTORY");
}
function syncDirectory(dir: string): void {
  // Unsupported platforms fail closed. Production integration must provide its
  // platform-specific durable-directory adapter before enabling this backend.
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function ensureDirectory(root: string): string {
  const dir = directoryPath(root);
  // Caller supplies an existing trusted data root, never a user message path.
  checkDirectory(root);
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  checkDirectory(dir);
  // Also covers a previous failed/crashed first creation.
  syncDirectory(root);
  return dir;
}
function openSafe(file: string, flags: number): number {
  if (!fs.constants.O_NOFOLLOW) fail("PLATFORM_UNSUPPORTED");
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW, 0o600);
  if (!fs.fstatSync(fd).isFile()) {
    fs.closeSync(fd);
    fail("FILE_TYPE");
  }
  return fd;
}

/**
 * Primitive only; not yet wired into production. Caller MUST own the segment's
 * exclusive writer lease across append and index commit. No reader may refer to
 * bytes past committedBytes. The durable SQLite index owns this high-water mark.
 * A file sync is NOT an acknowledgement until the index commit is also durable.
 * Hash is a caller-supplied object identity; checksum validates the envelope.
 */
export function appendTranscriptBatch(
  root: string, segment: string, committedBytes: number, records: readonly TranscriptRecord[],
): TranscriptLocation[] {
  validateSegment(segment);
  if (!Number.isSafeInteger(committedBytes) || committedBytes < 0) fail("OFFSET");
  if (!records.length || records.length > 256) fail("BATCH_SIZE");
  let bytes = 0;
  const lines = records.map((record) => {
    const line = recordBytes(record);
    bytes += line.length;
    if (bytes > MAX_BATCH) fail("BATCH_SIZE");
    return line;
  });
  if (!Number.isSafeInteger(committedBytes + bytes)) fail("OFFSET");
  const dir = ensureDirectory(root);
  const file = path.join(dir, `${segment}.jsonl`);
  if (committedBytes > 0 && !fs.existsSync(file)) fail("MISSING_TAIL");
  // Never create a missing file when the durable index expects existing bytes.
  const fd = openSafe(file, fs.constants.O_RDWR | (committedBytes === 0 ? fs.constants.O_CREAT : 0));
  try {
    const size = fs.fstatSync(fd).size;
    if (size < committedBytes) fail("MISSING_TAIL");
    if (size > committedBytes) fs.ftruncateSync(fd, committedBytes);
    let offset = committedBytes;
    const locations = lines.map((line, index) => {
      const location = { offset, length: line.length, payloadBytes: records[index].payload.length };
      let written = 0;
      while (written < line.length) {
        const n = fs.writeSync(fd, line, written, line.length - written, offset + written);
        if (n <= 0) fail("SHORT_WRITE");
        written += n;
      }
      offset += line.length;
      return location;
    });
    fs.fsyncSync(fd);
    syncDirectory(dir);
    return locations;
  } finally { fs.closeSync(fd); }
}
export function appendTranscript(root: string, segment: string, committedBytes: number, record: TranscriptRecord): TranscriptLocation {
  return appendTranscriptBatch(root, segment, committedBytes, [record])[0];
}
export function readTranscript(root: string, segment: string, offset: number, length: number): TranscriptRecord {
  validateSegment(segment);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_LINE || !Number.isSafeInteger(offset + length)) fail("RANGE");
  const dir = directoryPath(root);
  checkDirectory(root);
  checkDirectory(dir);
  const fd = openSafe(path.join(dir, `${segment}.jsonl`), fs.constants.O_RDONLY);
  try {
    if (offset + length > fs.fstatSync(fd).size) fail("RANGE");
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, bytes, read, length - read, offset + read);
      if (!n) fail("TRUNCATED");
      read += n;
    }
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes) || !text.endsWith("\n") || text.slice(0, -1).includes("\n")) fail("LINE");
    let value: unknown;
    try { value = JSON.parse(text); } catch (cause) { throw new Error("TRANSCRIPT_CHECKSUM", { cause }); }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("SHAPE");
    const row = value as Record<string, unknown>;
    if (row.version !== 1 || typeof row.payload !== "string" || typeof row.checksum !== "string") fail("SHAPE");
    const record: TranscriptRecord = {
      hash: row.hash as string,
      kind: row.kind as string,
      references: row.references as string[],
      payload: Buffer.from(row.payload, "base64"),
    };
    validateRecord(record);
    if (record.payload.toString("base64") !== row.payload) fail("BASE64");
    // Canonical comparison rejects unknown fields, duplicate keys and checksum
    // changes, rather than silently accepting a different serialization.
    if (!recordBytes(record).equals(bytes)) fail("CHECKSUM");
    return record;
  } finally { fs.closeSync(fd); }
}
export const transcriptLimits = { maxPayloadBytes: MAX_PAYLOAD, maxLineBytes: MAX_LINE, maxBatchBytes: MAX_BATCH } as const;
